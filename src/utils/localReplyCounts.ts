import { postReplyTo, type LocalPostView } from '../object-layer';

export function buildLocalDirectReplyCounts(posts: readonly LocalPostView[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const seenReplyIds = new Set<string>();
  for (const post of posts) {
    const parentId = postReplyTo(post);
    if (parentId && /^[0-9a-f]{64}$/.test(parentId) && !seenReplyIds.has(post.object.object_id)) {
      seenReplyIds.add(post.object.object_id);
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    }
  }
  return counts;
}
