import { isObjectExpired, validateDistributedObject } from './envelope';
import type { DistributedObject, FeedCursor, ObjectStore } from './types';

export type { FeedCursor } from './types';

const DEFAULT_FEED_PAGE_SIZE = 100;
export const MAX_FEED_PAGE_SIZE = 200;

export interface FeedPage {
  readonly objects: DistributedObject[];
  readonly next_cursor: FeedCursor | null;
  readonly has_more: boolean;
}

export function compareFeedKey(left: FeedCursor, right: FeedCursor): number {
  const leftTime = Date.parse(left.created_at);
  const rightTime = Date.parse(right.created_at);
  if (leftTime !== rightTime) {
    if (Number.isNaN(leftTime)) return Number.isNaN(rightTime) ? compareStrings(left.created_at, right.created_at) : -1;
    if (Number.isNaN(rightTime)) return 1;
    return leftTime < rightTime ? -1 : 1;
  }
  return compareStrings(left.object_id, right.object_id);
}

export async function queryFeedPage(
  store: ObjectStore,
  author: string,
  options: { after?: FeedCursor | null; limit?: number } = {}
): Promise<FeedPage> {
  const limit = normalizeLimit(options.limit);
  const candidates = await store.query();
  const core: DistributedObject[] = [];
  for (const object of candidates) {
    if (object.author !== author
      || (object.object_type !== 'mycelium.post' && object.object_type !== 'mycelium.recommendation')
      || isObjectExpired(object)
      || !(await validateDistributedObject(object))) {
      continue;
    }
    core.push(object);
  }

  core.sort((left, right) => compareFeedKey(toFeedCursor(left), toFeedCursor(right)));

  let pageCore: DistributedObject[];
  let hasMore: boolean;
  const after = options.after;
  if (after == null) {
    pageCore = core.slice(Math.max(0, core.length - limit));
    hasMore = false;
  } else {
    const newer = core.filter((object) => compareFeedKey(toFeedCursor(object), after) > 0);
    pageCore = newer.slice(0, limit);
    hasMore = newer.length > pageCore.length;
  }

  const nextCursor = pageCore.length > 0
    ? toFeedCursor(pageCore[pageCore.length - 1])
    : after ?? null;
  const result = [...pageCore];
  const includedIds = new Set(result.map((object) => object.object_id));
  let extrasAdded = 0;

  for (const recommendation of pageCore) {
    const postId = getReferencedPostId(recommendation);
    if (!postId || includedIds.has(postId) || extrasAdded >= limit) continue;

    const post = await store.get(postId);
    if (!post
      || post.object_id !== postId
      || post.object_type !== 'mycelium.post'
      || isObjectExpired(post)
      || !(await validateDistributedObject(post))) {
      continue;
    }

    includedIds.add(post.object_id);
    result.push(post);
    extrasAdded += 1;
  }

  return { objects: result, next_cursor: nextCursor, has_more: hasMore };
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isSafeInteger(limit) || limit === undefined || limit <= 0) return DEFAULT_FEED_PAGE_SIZE;
  return Math.min(limit, MAX_FEED_PAGE_SIZE);
}

function toFeedCursor(object: DistributedObject): FeedCursor {
  return { created_at: object.created_at, object_id: object.object_id };
}

function getReferencedPostId(object: DistributedObject): string | null {
  if (!object.payload || typeof object.payload !== 'object' || Array.isArray(object.payload)) return null;
  const postId = object.payload.post_id;
  return typeof postId === 'string' ? postId : null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
