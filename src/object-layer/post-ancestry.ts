import { postReplyTo } from './post-state';
import type { LocalPostView } from './types';

export const MAX_POST_ANCESTRY_DEPTH = 32;

export type PostAncestryStopReason = 'no-parent' | 'missing' | 'cycle' | 'depth-limit';

export interface PostAncestryResult {
  ancestors: LocalPostView[];
  stopReason: PostAncestryStopReason;
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
