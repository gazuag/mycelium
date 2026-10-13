import { postReplyTo, type LocalPostView } from '../object-layer';

export function buildLocalDirectReplyCounts(posts: readonly LocalPostView[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const parentId = postReplyTo(post);
    if (parentId) counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  }
  return counts;
}
