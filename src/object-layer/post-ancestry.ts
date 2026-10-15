import { postReplyTo } from './post-state';
import { isObjectExpired, validateDistributedObject } from './envelope';
import type { DistributedObject, LocalPostView, ObjectStore } from './types';

export const MAX_POST_ANCESTRY_DEPTH = 32;

export type PostAncestryStopReason = 'no-parent' | 'missing' | 'cycle' | 'depth-limit';

export interface PostAncestryResult {
  ancestors: LocalPostView[];
  stopReason: PostAncestryStopReason;
}

export type PostChainStopReason =
  | 'no-parent'
  | 'missing'
  | 'retrieval-failed'
  | 'invalid-object'
  | 'object-id-mismatch'
  | 'malformed-parent'
  | 'cycle'
  | 'depth-limit'
  | 'storage-failed';

export interface PostChainResult {
  readonly objects: DistributedObject[];
  readonly stopReason: PostChainStopReason;
  readonly complete: boolean;
  readonly storageFailures: readonly string[];
  readonly newlyCachedObjectIds: readonly string[];
  readonly missingObjectId?: string;
  readonly error?: string;
}

export type PostParentResolver = (objectId: string) => Promise<DistributedObject | null>;

export interface ExpandedPostChainResult {
  readonly objects: DistributedObject[];
  readonly chains: readonly PostChainResult[];
}

export async function ensurePostChainCached(
  post: DistributedObject,
  store: ObjectStore,
  resolvePostById: PostParentResolver,
  maxDepth = MAX_POST_ANCESTRY_DEPTH
): Promise<PostChainResult> {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error('Post ancestry depth must be a non-negative integer');
  }
  if (post.object_type !== 'mycelium.post' || isObjectExpired(post) || !(await validateDistributedObject(post))) {
    return {
      objects: [],
      stopReason: 'invalid-object',
      complete: false,
      storageFailures: [],
      newlyCachedObjectIds: []
    };
  }

  const newestFirst = [post];
  const visitedIds = new Set([post.object_id]);
  const storageFailures: string[] = [];
  const newlyCachedObjectIds: string[] = [];
  let currentPost = post;

  try {
    if (await store.put(post)) newlyCachedObjectIds.push(post.object_id);
  } catch {
    storageFailures.push(post.object_id);
  }

  while (true) {
    const payload = currentPost.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('reply_to' in payload)) {
      break;
    }

    const parentId = payload.reply_to;
    if (typeof parentId !== 'string' || !/^[0-9a-f]{64}$/.test(parentId)) {
      return chainResult(newestFirst, 'malformed-parent', storageFailures, newlyCachedObjectIds, false);
    }
    if (visitedIds.has(parentId)) {
      return chainResult(newestFirst, 'cycle', storageFailures, newlyCachedObjectIds, false);
    }
    if (newestFirst.length - 1 >= maxDepth) {
      return chainResult(newestFirst, 'depth-limit', storageFailures, newlyCachedObjectIds, false);
    }

    let parent: DistributedObject | null;
    try {
      parent = await store.get(parentId);
    } catch (error) {
      return chainResult(newestFirst, 'storage-failed', storageFailures, newlyCachedObjectIds, false, parentId, errorMessage(error));
    }

    if (parent && !(await isValidParent(parent, parentId))) parent = null;
    if (!parent) {
      try {
        parent = await resolvePostById(parentId);
      } catch (error) {
        return chainResult(newestFirst, 'retrieval-failed', storageFailures, newlyCachedObjectIds, false, parentId, errorMessage(error));
      }
    }
    if (!parent) {
      return chainResult(newestFirst, 'missing', storageFailures, newlyCachedObjectIds, false, parentId);
    }
    if (parent.object_id !== parentId) {
      return chainResult(newestFirst, 'object-id-mismatch', storageFailures, newlyCachedObjectIds, false, parentId);
    }
    if (!(await isValidParent(parent, parentId))) {
      return chainResult(newestFirst, 'invalid-object', storageFailures, newlyCachedObjectIds, false, parentId);
    }
    if (isObjectExpired(parent)) {
      return chainResult(newestFirst, 'invalid-object', storageFailures, newlyCachedObjectIds, false, parentId, 'Parent object has expired');
    }

    try {
      if (await store.put(parent)) newlyCachedObjectIds.push(parent.object_id);
    } catch {
      storageFailures.push(parent.object_id);
    }
    newestFirst.push(parent);
    visitedIds.add(parentId);
    currentPost = parent;
  }

  return chainResult(
    newestFirst,
    storageFailures.length > 0 ? 'storage-failed' : 'no-parent',
    storageFailures,
    newlyCachedObjectIds,
    storageFailures.length === 0
  );
}

export async function expandObjectsWithPostChains(
  objects: readonly DistributedObject[],
  store: ObjectStore,
  resolvePostById: PostParentResolver
): Promise<ExpandedPostChainResult> {
  const expanded: DistributedObject[] = [];
  const includedIds = new Set<string>();
  const chains: PostChainResult[] = [];
  for (const object of objects) {
    if (object.object_type !== 'mycelium.post') {
      if (!includedIds.has(object.object_id)) {
        includedIds.add(object.object_id);
        expanded.push(object);
      }
      continue;
    }

    const chain = await ensurePostChainCached(object, store, resolvePostById);
    chains.push(chain);
    for (const chainObject of chain.objects) {
      if (includedIds.has(chainObject.object_id)) continue;
      includedIds.add(chainObject.object_id);
      expanded.push(chainObject);
    }
  }
  return { objects: expanded, chains };
}

function chainResult(
  newestFirst: readonly DistributedObject[],
  stopReason: PostChainStopReason,
  storageFailures: readonly string[],
  newlyCachedObjectIds: readonly string[],
  complete: boolean,
  missingObjectId?: string,
  error?: string
): PostChainResult {
  return {
    objects: [...newestFirst].reverse(),
    stopReason,
    complete,
    storageFailures,
    newlyCachedObjectIds,
    ...(missingObjectId ? { missingObjectId } : {}),
    ...(error ? { error } : {})
  };
}

async function isValidParent(object: DistributedObject, requestedId: string): Promise<boolean> {
  return object.object_id === requestedId
    && object.object_type === 'mycelium.post'
    && !isObjectExpired(object)
    && await validateDistributedObject(object);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadPostAncestry(
  post: LocalPostView,
  localPosts: readonly LocalPostView[],
  resolvePostById: (objectId: string) => Promise<LocalPostView | null>,
  maxDepth = MAX_POST_ANCESTRY_DEPTH
): Promise<PostAncestryResult> {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error('Post ancestry depth must be a non-negative integer');
  }

  const localPostsById = new Map(localPosts.map((candidate) => [candidate.object.object_id, candidate]));
  const visitedIds = new Set([post.object.object_id]);
  const ancestors: LocalPostView[] = [];
  let currentPost = post;
  let stopReason: PostAncestryStopReason = 'no-parent';

  while (true) {
    const parentId = postReplyTo(currentPost);
    if (!parentId) break;
    if (!/^[0-9a-f]{64}$/.test(parentId)) {
      stopReason = 'missing';
      break;
    }
    if (visitedIds.has(parentId)) {
      stopReason = 'cycle';
      break;
    }
    if (ancestors.length >= maxDepth) {
      stopReason = 'depth-limit';
      break;
    }

    const parent = localPostsById.get(parentId) ?? await resolvePostById(parentId);
    if (!parent || parent.object.object_id !== parentId) {
      stopReason = 'missing';
      break;
    }

    ancestors.push(parent);
    visitedIds.add(parentId);
    localPostsById.set(parentId, parent);
    currentPost = parent;
  }

  return { ancestors: ancestors.reverse(), stopReason };
}
