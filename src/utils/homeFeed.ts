import type { LocalPostView, RecommendationSummary } from '../object-layer';

export interface HomeFeedPost extends LocalPostView {
  homeFeedSource?: 'followed' | 'recommendation' | 'discovery';
  recommendationSummary?: RecommendationSummary;
}

export interface ComposeHomeFeedOptions {
  baseline: readonly LocalPostView[];
  recommendations: readonly LocalPostView[];
  discovery: readonly LocalPostView[];
  getRecommendationSummary: (postId: string) => RecommendationSummary;
  replyCounts: ReadonlyMap<string, number>;
  now?: number;
}

export function composeHomeFeed({
  baseline,
  recommendations,
  discovery,
  getRecommendationSummary,
  replyCounts,
  now = Date.now()
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

  const recommendationCapacity = Math.floor(followedPosts.length * 20 / 70);
  const availableRecommendations = recommendations.flatMap((post) => {
    const id = post.object.object_id;
    if (selectedIds.has(id)) return [];
    selectedIds.add(id);
    return [{
      ...post,
      homeFeedSource: 'recommendation' as const,
      recommendationSummary: getRecommendationSummary(id)
    }];
  });
  const recommendationPosts = availableRecommendations.slice(0, recommendationCapacity);
  for (const post of availableRecommendations.slice(recommendationCapacity)) {
    selectedIds.delete(post.object.object_id);
  }

  const discoveryCapacity = Math.floor(followedPosts.length * 10 / 70);
  const discoveryPosts = [...discovery]
    .filter((post) => !selectedIds.has(post.object.object_id))
    .sort((left, right) =>
      (replyCounts.get(right.object.object_id) ?? 0) - (replyCounts.get(left.object.object_id) ?? 0)
      || Date.parse(right.object.created_at) - Date.parse(left.object.created_at)
      || left.object.object_id.localeCompare(right.object.object_id)
    )
    .slice(0, discoveryCapacity)
    .flatMap((post) => {
      const id = post.object.object_id;
      if (selectedIds.has(id)) return [];
      selectedIds.add(id);
      return [{ ...post, homeFeedSource: 'discovery' as const }];
    });

  const recommendationSpacing = recommendationPosts.length > 0
    ? Math.max(1, Math.floor(followedPosts.length / recommendationCapacity))
    : Number.POSITIVE_INFINITY;
  const discoverySpacing = discoveryPosts.length > 0
    ? Math.max(1, Math.floor(followedPosts.length / discoveryCapacity))
    : Number.POSITIVE_INFINITY;
  const composed: HomeFeedPost[] = [];
  let recommendationIndex = 0;
  let discoveryIndex = 0;

  followedPosts.forEach((post, index) => {
    composed.push(post);
    const baselinePosition = index + 1;
    const nextPost = followedPosts[index + 1];
    const previousTimestamp = Date.parse(post.object.created_at);
    const nextTimestamp = nextPost ? Date.parse(nextPost.object.created_at) : Number.NaN;
    const injectedAt = Number.isFinite(previousTimestamp) && Number.isFinite(nextTimestamp)
      ? (previousTimestamp + nextTimestamp) / 2
      : Number.isFinite(previousTimestamp)
        ? previousTimestamp - 1
        : Number.isFinite(nextTimestamp)
          ? nextTimestamp + 1
          : now;
    if (recommendationIndex < recommendationPosts.length && baselinePosition % recommendationSpacing === 0) {
      const recommendation = recommendationPosts[recommendationIndex++];
      const keptInjectedAt = recommendation.injectedAt !== undefined;
      const finalInjectedAt = recommendation.injectedAt ?? injectedAt;
      if (import.meta.env.DEV) {
        console.debug(`Injected post ${recommendation.object.object_id.slice(0, 8)}: had-injectedAt=${keptInjectedAt} ${keptInjectedAt ? 'kept' : 'calculated'}=${new Date(finalInjectedAt).toISOString()}`);
      }
      composed.push({
        ...recommendation,
        injectedAt: finalInjectedAt
      });
    }
    if (discoveryIndex < discoveryPosts.length && baselinePosition % discoverySpacing === 0) {
      const discoveryPost = discoveryPosts[discoveryIndex++];
      const keptInjectedAt = discoveryPost.injectedAt !== undefined;
      const finalInjectedAt = discoveryPost.injectedAt ?? injectedAt;
      if (import.meta.env.DEV) {
        console.debug(`Injected post ${discoveryPost.object.object_id.slice(0, 8)}: had-injectedAt=${keptInjectedAt} ${keptInjectedAt ? 'kept' : 'calculated'}=${new Date(finalInjectedAt).toISOString()}`);
      }
      composed.push({
        ...discoveryPost,
        injectedAt: finalInjectedAt
      });
    }
  });

  return composed;
}
