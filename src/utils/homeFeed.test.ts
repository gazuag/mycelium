import { describe, expect, it } from 'vitest';
import type { LocalPostView, RecommendationSummary } from '../object-layer';
import { composeHomeFeed } from './homeFeed';

function makePost(id: string, createdAt = '2026-10-01T00:00:00.000Z'): LocalPostView {
  return {
    object: {
      object_id: id,
      object_type: 'mycelium.post',
      author: `author-${id}`,
      created_at: createdAt,
      payload: { content: id },
      signature: '',
      replication_policy: {}
    },
    authorFingerprint: `fingerprint-${id}`
  };
}

const summary = (postId: string): RecommendationSummary => ({
  post_id: postId,
  active_recommenders: [],
  active_recommender_count: 0,
  followed_recommenders: [],
  followed_recommender_count: 0,
  recommended_by_me: false
});

describe('composeHomeFeed', () => {
  it('interleaves recommendation and Discovery posts at their baseline spacing', () => {
    const feed = composeHomeFeed({
      baseline: Array.from({ length: 7 }, (_, index) => makePost(`followed-${index}`)),
      recommendations: [makePost('recommended'), makePost('recommended-extra')],
      discovery: [makePost('discovery'), makePost('discovery-extra')],
      getRecommendationSummary: summary,
      replyCounts: new Map(),
      now: 123
    });

    expect(feed.map((post) => post.homeFeedSource)).toEqual([
      'followed', 'followed', 'followed', 'recommendation',
      'followed', 'followed', 'followed', 'recommendation', 'followed',
      'discovery'
    ]);
    expect(feed.find((post) => post.homeFeedSource === 'followed')?.injectedAt).toBeUndefined();
    expect(feed.find((post) => post.homeFeedSource === 'recommendation')?.injectedAt)
      .toBe(Date.parse('2026-10-01T00:00:00.000Z'));
    expect(feed.find((post) => post.homeFeedSource === 'discovery')?.injectedAt)
      .toBe(Date.parse('2026-10-01T00:00:00.000Z') - 1);
  });

  it('limits injection to the 70:20:10 ratio relative to the baseline', () => {
    const feed = composeHomeFeed({
      baseline: Array.from({ length: 70 }, (_, index) => makePost(`followed-${index}`)),
      recommendations: Array.from({ length: 30 }, (_, index) => makePost(`recommended-${index}`)),
      discovery: Array.from({ length: 30 }, (_, index) => makePost(`discovery-${index}`)),
      getRecommendationSummary: summary,
      replyCounts: new Map(),
      now: 456
    });

    expect(feed.filter((post) => post.homeFeedSource === 'followed')).toHaveLength(70);
    expect(feed.filter((post) => post.homeFeedSource === 'recommendation')).toHaveLength(20);
    expect(feed.filter((post) => post.homeFeedSource === 'discovery')).toHaveLength(10);
  });

  it('keeps injections distributed after HomePage sorting and preserves baseline chronology', () => {
    const baseline = Array.from({ length: 70 }, (_, index) =>
      makePost(`followed-${index}`, new Date(Date.UTC(2026, 9, 1, 0, 0, -index)).toISOString())
    );
    const feed = composeHomeFeed({
      baseline,
      recommendations: Array.from({ length: 20 }, (_, index) => makePost(`recommended-${index}`, '2020-01-01T00:00:00.000Z')),
      discovery: Array.from({ length: 10 }, (_, index) => makePost(`discovery-${index}`, '2019-01-01T00:00:00.000Z')),
      getRecommendationSummary: summary,
      replyCounts: new Map(),
      now: Date.now()
    });
    const homePageSorted = [...feed].sort((left, right) =>
      (right.injectedAt ?? Date.parse(right.object.created_at))
      - (left.injectedAt ?? Date.parse(left.object.created_at))
    );
    const sources = homePageSorted.map((post) => post.homeFeedSource);
    const baselineIds = homePageSorted
      .filter((post) => post.homeFeedSource === 'followed')
      .map((post) => post.object.object_id);
    let followedCount = 0;
    const baselinePositionsBySource = new Map<string, number[]>();
    for (const post of homePageSorted) {
      if (post.homeFeedSource === 'followed') {
        followedCount += 1;
      } else {
        const positions = baselinePositionsBySource.get(post.homeFeedSource ?? '') ?? [];
        positions.push(followedCount);
        baselinePositionsBySource.set(post.homeFeedSource ?? '', positions);
      }
    }

    expect(baselineIds).toEqual(baseline.map((post) => post.object.object_id));
    expect(sources.slice(0, 4)).toEqual(['followed', 'followed', 'followed', 'recommendation']);
    expect(sources.filter((source) => source === 'recommendation')).toHaveLength(20);
    expect(sources.filter((source) => source === 'discovery')).toHaveLength(10);
    expect(baselinePositionsBySource.get('recommendation')?.slice(0, 4)).toEqual([3, 6, 9, 12]);
    expect(baselinePositionsBySource.get('discovery')?.slice(0, 3)).toEqual([7, 14, 21]);
  });

  it('preserves old injection timestamps and assigns fresh interpolated timestamps to new injections', () => {
    const baseline = Array.from({ length: 70 }, (_, index) =>
      makePost(`followed-${index}`, new Date(Date.UTC(2026, 9, 1, 0, 0, -index)).toISOString())
    );
    const recommendations = Array.from({ length: 20 }, (_, index) =>
      makePost(`recommended-${index}`, '2020-01-01T00:00:00.000Z')
    );
    const discovery = Array.from({ length: 10 }, (_, index) =>
      makePost(`discovery-${index}`, '2019-01-01T00:00:00.000Z')
    );
    const compose = (posts: LocalPostView[]) => composeHomeFeed({
      baseline: posts,
      recommendations,
      discovery,
      getRecommendationSummary: summary,
      replyCounts: new Map()
    });
    const initialFeed = compose(baseline);
    const initialRecommendation = initialFeed.find((post) => post.object.object_id === 'recommended-0');
    const initialDiscovery = initialFeed.find((post) => post.object.object_id === 'discovery-0');
    const newBaseline = Array.from({ length: 7 }, (_, index) =>
      makePost(`new-followed-${index}`, new Date(Date.UTC(2026, 9, 2, 0, 0, -index)).toISOString())
    );
    const updatedFeed = composeHomeFeed({
      baseline: [...newBaseline, ...baseline],
      recommendations: [
        ...initialFeed.filter((post) => post.homeFeedSource === 'recommendation'),
        makePost('recommended-new-1', '2020-01-02T00:00:00.000Z'),
        makePost('recommended-new-2', '2020-01-03T00:00:00.000Z')
      ],
      discovery: [
        ...initialFeed.filter((post) => post.homeFeedSource === 'discovery'),
        makePost('discovery-new', '2019-01-02T00:00:00.000Z')
      ],
      getRecommendationSummary: summary,
      replyCounts: new Map(),
      now: Date.parse('2026-10-08T00:00:00.000Z')
    });
    const updatedSorted = [...updatedFeed].sort((left, right) =>
      (right.injectedAt ?? Date.parse(right.object.created_at))
      - (left.injectedAt ?? Date.parse(left.object.created_at))
    );
    const oldRecommendation = updatedSorted.find((post) => post.object.object_id === 'recommended-0');
    const newRecommendation = updatedSorted.find((post) => post.object.object_id === 'recommended-new-1');
    const oldDiscovery = updatedSorted.find((post) => post.object.object_id === 'discovery-0');
    const newDiscovery = updatedSorted.find((post) => post.object.object_id === 'discovery-new');
    const initialPosition = initialFeed.findIndex((post) => post.object.object_id === 'recommended-0');
    const updatedPosition = updatedSorted.findIndex((post) => post.object.object_id === 'recommended-0');
    const effectiveTimes = updatedSorted.map((post) => post.injectedAt ?? Date.parse(post.object.created_at));

    expect(initialRecommendation?.injectedAt).toBeDefined();
    expect(initialDiscovery?.injectedAt).toBeDefined();
    expect(oldRecommendation?.injectedAt).toBe(initialRecommendation?.injectedAt);
    expect(oldDiscovery?.injectedAt).toBe(initialDiscovery?.injectedAt);
    expect(newRecommendation?.injectedAt).toBeDefined();
    expect(newDiscovery?.injectedAt).toBeDefined();
    expect(newRecommendation?.injectedAt).not.toBe(initialRecommendation?.injectedAt);
    expect(newDiscovery?.injectedAt).not.toBe(initialDiscovery?.injectedAt);
    expect(updatedPosition).toBeGreaterThan(initialPosition);
    expect(effectiveTimes).toEqual([...effectiveTimes].sort((left, right) => right - left));
  });

  it('deduplicates IDs across pools and ranks Discovery candidates by reply count', () => {
    const feed = composeHomeFeed({
      baseline: [makePost('shared-base'), makePost('followed-1'), makePost('followed-2'), makePost('followed-3'), makePost('followed-4'), makePost('followed-5'), makePost('followed-6')],
      recommendations: [makePost('shared-base'), makePost('shared-recommendation'), makePost('recommended-2'), makePost('recommended-3')],
      discovery: [makePost('shared-base'), makePost('shared-recommendation'), makePost('discovery-low'), makePost('discovery-high')],
      getRecommendationSummary: summary,
      replyCounts: new Map([['discovery-low', 1], ['discovery-high', 10]]),
      now: 789
    });
    const ids = feed.map((post) => post.object.object_id);

    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids.filter((id) => id === 'shared-base')).toHaveLength(1);
    expect(ids.filter((id) => id === 'shared-recommendation')).toHaveLength(1);
    expect(feed[feed.length - 1]?.object.object_id).toBe('discovery-high');
  });
});
