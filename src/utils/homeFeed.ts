import type { LocalPostView, RecommendationSummary } from '../object-layer';
import type { HomeFeedInjection } from './homeFeedInjection';

export interface HomeFeedPost extends LocalPostView {
  homeFeedSource?: 'followed' | 'recommendation' | 'discovery';
  recommendationSummary?: RecommendationSummary;
}

export interface ComposeHomeFeedOptions {
  baseline: readonly LocalPostView[];
  recommendations: readonly LocalPostView[];
  discovery: readonly LocalPostView[];
  injections: readonly HomeFeedInjection[];
  getRecommendationSummary: (postId: string) => RecommendationSummary;
  replyCounts: ReadonlyMap<string, number>;
}

export function composeHomeFeed({
  baseline,
  recommendations,
  discovery,
  injections,
  getRecommendationSummary,
  replyCounts,
}: ComposeHomeFeedOptions): HomeFeedPost[] {
  const selectedIds = new Set<string>();
  const followedPosts = [...baseline]
    .sort((left, right) => Date.parse(right.object.created_at) - Date.parse(left.object.created_at))
    .flatMap((post) => {
    const id = post.object.object_id;
    if (selectedIds.has(id)) return [];
    selectedIds.add(id);
    return [{ ...post, homeFeedSource: 'followed' as const, recommendationSummary: getRecommendationSummary(id) }];
  });

  const recommendationsById = new Map(recommendations.map((post) => [post.object.object_id, post]));
  const discoveryById = new Map([...discovery].sort((left, right) =>
    (replyCounts.get(right.object.object_id) ?? 0) - (replyCounts.get(left.object.object_id) ?? 0)
    || Date.parse(right.object.created_at) - Date.parse(left.object.created_at)
    || left.object.object_id.localeCompare(right.object.object_id)
  ).map((post) => [post.object.object_id, post]));
  const composed: HomeFeedPost[] = [...followedPosts];
  for (const injection of injections) {
    if (selectedIds.has(injection.postId)) continue;
    const post = injection.source === 'recommendation'
      ? recommendationsById.get(injection.postId)
      : discoveryById.get(injection.postId);
    if (!post) continue;
    selectedIds.add(injection.postId);
    composed.push({
      ...post,
      homeFeedSource: injection.source,
      recommendationSummary: getRecommendationSummary(injection.postId),
      injectedAt: injection.injectedAt
    });
  }
  return composed;
}
