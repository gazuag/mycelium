import { describe, expect, it, vi } from 'vitest';
import type { LocalPostView, RecommendationSummary } from '../object-layer';
import { composeHomeFeed } from './homeFeed';
import {
  EMPTY_HOME_FEED_INJECTION_STATE,
  DEFAULT_HOME_FEED_INJECTION_THRESHOLDS,
  HomeFeedInjectionScheduler,
  homeFeedInjectionStorageKey,
  isValidInjectionThreshold,
  parseHomeFeedInjectionState
} from './homeFeedInjection';

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

const candidates = {
  recommendations: ['recommended-0', 'recommended-1', 'recommended-2', 'recommended-3'],
  discovery: ['discovery-0', 'discovery-1']
};

function sorted(feed: ReturnType<typeof composeHomeFeed>) {
  return [...feed].sort((left, right) =>
    (right.injectedAt ?? Date.parse(right.object.created_at))
    - (left.injectedAt ?? Date.parse(left.object.created_at))
  );
}

describe('Home feed injection scheduling and ordering', () => {
  it('defaults legacy and new identities to recommendation 2 and Discovery 6', () => {
    const legacyState = parseHomeFeedInjectionState(JSON.stringify({
      recommendationPostsSinceInjection: 4,
      discoveryPostsSinceInjection: 5,
      injections: []
    }));

    expect(DEFAULT_HOME_FEED_INJECTION_THRESHOLDS).toEqual({ recommendation: 2, discovery: 6 });
    expect(legacyState.recommendationThreshold).toBe(2);
    expect(legacyState.discoveryThreshold).toBe(6);
    expect(parseHomeFeedInjectionState(null)).toMatchObject({
      recommendationThreshold: 2,
      discoveryThreshold: 6
    });
  });

  it('persists configured frequencies through reload and isolates each identity', () => {
    const storage = new Map<string, string>();
    const aliceKey = homeFeedInjectionStorageKey('alice');
    const bobKey = homeFeedInjectionStorageKey('bob');
    const alice = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, (state) => {
      storage.set(aliceKey, JSON.stringify(state));
    });
    alice.setThresholds(4, 0);

    const restoredAlice = parseHomeFeedInjectionState(storage.get(aliceKey) ?? null);
    const restoredBob = parseHomeFeedInjectionState(storage.get(bobKey) ?? null);

    expect(aliceKey).not.toBe(bobKey);
    expect(restoredAlice).toMatchObject({ recommendationThreshold: 4, discoveryThreshold: 0 });
    expect(restoredBob).toMatchObject({ recommendationThreshold: 2, discoveryThreshold: 6 });
  });

  it('rejects negative, fractional, empty, and non-finite frequencies', () => {
    expect([0, 1, 2, Number.MAX_SAFE_INTEGER].every(isValidInjectionThreshold)).toBe(true);
    expect([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].some(isValidInjectionThreshold)).toBe(false);
    expect(isValidInjectionThreshold(Number.NaN)).toBe(false);
    const scheduler = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, vi.fn());
    expect(() => scheduler.setThresholds(-1, 6)).toThrow('non-negative whole numbers');
    expect(() => scheduler.setThresholds(2.5, 6)).toThrow('non-negative whole numbers');
  });

  it('uses independent configured thresholds and disables overdue injections at zero', () => {
    const scheduler = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, vi.fn());
    scheduler.setThresholds(1, 3);
    scheduler.recordNewEligiblePost('followed-1', candidates, 10);
    expect(scheduler.getState().injections).toEqual([]);
    scheduler.recordNewEligiblePost('followed-2', candidates, 20);
    expect(scheduler.getState().injections).toEqual([
      { postId: 'recommended-0', source: 'recommendation', injectedAt: 20 }
    ]);
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(0);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(2);

    scheduler.recordNewEligiblePost('followed-3', { recommendations: [], discovery: [] }, 30);
    scheduler.recordNewEligiblePost('followed-4', { recommendations: [], discovery: [] }, 40);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(4);
    scheduler.setThresholds(0, 0);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(0);
    expect(scheduler.flushPendingInjections(candidates, 50)).toBe(false);
    scheduler.recordNewEligiblePost('followed-5', candidates, 50);
    expect(scheduler.getState().injections).toHaveLength(1);

    scheduler.setThresholds(1, 2);
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(0);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(0);
    scheduler.recordNewEligiblePost('followed-6', candidates, 60);
    expect(scheduler.getState().injections).toHaveLength(1);
    scheduler.recordNewEligiblePost('followed-7', candidates, 70);
    expect(scheduler.getState().injections).toEqual([
      { postId: 'recommended-0', source: 'recommendation', injectedAt: 20 },
      { postId: 'recommended-1', source: 'recommendation', injectedAt: 70 }
    ]);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(2);
  });

  it('keeps timestamps for existing injection records when frequencies change', () => {
    const scheduler = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, vi.fn());
    scheduler.recordNewEligiblePost('followed-1', candidates, 10);
    scheduler.recordNewEligiblePost('followed-2', candidates, 20);
    scheduler.recordNewEligiblePost('followed-3', candidates, 30);
    const priorInjections = scheduler.getState().injections;

    scheduler.setThresholds(10, 0);

    expect(scheduler.getState().injections).toBe(priorInjections);
    expect(scheduler.getState().injections[0]?.injectedAt).toBe(30);
  });

  it('counts each new eligible post once and injects only after count exceeds each threshold', () => {
    const scheduler = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, vi.fn());
    for (let index = 1; index <= 2; index += 1) {
      scheduler.recordNewEligiblePost(`followed-${index}`, candidates, 100 + index);
    }
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(2);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(2);
    expect(scheduler.getState().injections).toEqual([]);

    expect(scheduler.recordNewEligiblePost('followed-2', candidates, 103)).toBe(false);
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(2);

    scheduler.recordNewEligiblePost('followed-3', candidates, 103);
    expect(scheduler.getState().injections).toEqual([
      { postId: 'recommended-0', source: 'recommendation', injectedAt: 103 }
    ]);
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(0);

    for (let index = 4; index <= 6; index += 1) {
      scheduler.recordNewEligiblePost(`followed-${index}`, candidates, 100 + index);
    }
    expect(scheduler.getState().injections).toEqual([
      { postId: 'recommended-0', source: 'recommendation', injectedAt: 103 },
      { postId: 'recommended-1', source: 'recommendation', injectedAt: 106 }
    ]);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(6);

    scheduler.recordNewEligiblePost('followed-7', candidates, 107);
    expect(scheduler.getState().injections).toEqual([
      { postId: 'recommended-0', source: 'recommendation', injectedAt: 103 },
      { postId: 'recommended-1', source: 'recommendation', injectedAt: 106 },
      { postId: 'discovery-0', source: 'discovery', injectedAt: 107 }
    ]);
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(1);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(0);
  });

  it('does not double-count rapid duplicate deliveries and persists one atomic schedule update per post', () => {
    const persist = vi.fn();
    const scheduler = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, persist);
    for (let index = 0; index < 10; index += 1) {
      const id = `followed-${index}`;
      scheduler.recordNewEligiblePost(id, candidates, 500);
      scheduler.recordNewEligiblePost(id, candidates, 500);
    }

    expect(scheduler.getState().injections.filter((item) => item.source === 'recommendation')).toHaveLength(3);
    expect(scheduler.getState().injections.filter((item) => item.source === 'discovery')).toHaveLength(1);
    expect(new Set(scheduler.getState().injections.map((item) => item.postId)).size)
      .toBe(scheduler.getState().injections.length);
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(1);
    expect(scheduler.getState().discoveryPostsSinceInjection).toBe(3);
    expect(persist).toHaveBeenCalledTimes(10);
  });

  it('keeps a crossed threshold pending until a candidate is available', () => {
    const scheduler = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, vi.fn());
    for (let index = 0; index < 3; index += 1) {
      scheduler.recordNewEligiblePost(`followed-${index}`, { recommendations: [], discovery: [] }, 300);
    }

    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(3);
    expect(scheduler.flushPendingInjections(candidates, 400)).toBe(true);
    expect(scheduler.getState().injections).toEqual([
      { postId: 'recommended-0', source: 'recommendation', injectedAt: 400 }
    ]);
    expect(scheduler.getState().recommendationPostsSinceInjection).toBe(0);
  });

  it('preserves injection timestamps on reload and sorts them chronologically with ordinary posts', () => {
    const scheduler = new HomeFeedInjectionScheduler(EMPTY_HOME_FEED_INJECTION_STATE, vi.fn());
    scheduler.recordNewEligiblePost('followed-1', candidates, 10);
    scheduler.recordNewEligiblePost('followed-2', candidates, 20);
    scheduler.recordNewEligiblePost('followed-3', candidates, 500);
    const restored = parseHomeFeedInjectionState(JSON.stringify(scheduler.getState()));

    const baseline = [
      makePost('baseline-older', '1970-01-01T00:00:00.400Z'),
      makePost('baseline-newer', '1970-01-01T00:00:00.300Z')
    ];
    const compose = (baselinePosts: LocalPostView[]) => composeHomeFeed({
      baseline: baselinePosts,
      recommendations: [makePost('recommended-0', '2020-01-01T00:00:00.000Z')],
      discovery: [],
      injections: restored.injections,
      getRecommendationSummary: summary,
      replyCounts: new Map()
    });
    const initial = sorted(compose(baseline));
    const later = sorted(compose([
      makePost('baseline-newest-arrival', '1970-01-01T00:00:00.600Z'),
      ...baseline
    ]));
    const injectionBefore = initial.find((post) => post.object.object_id === 'recommended-0');
    const injectionAfter = later.find((post) => post.object.object_id === 'recommended-0');

    expect(injectionBefore?.injectedAt).toBe(500);
    expect(injectionAfter?.injectedAt).toBe(500);
    expect(initial.map((post) => post.object.object_id)).toEqual(['recommended-0', 'baseline-older', 'baseline-newer']);
    expect(later.map((post) => post.object.object_id)).toEqual([
      'baseline-newest-arrival', 'recommended-0', 'baseline-older', 'baseline-newer'
    ]);
    expect(baseline.map((post) => post.object.created_at)).toEqual([
      '1970-01-01T00:00:00.400Z', '1970-01-01T00:00:00.300Z'
    ]);
  });

  it('deduplicates IDs across candidate pools and includes only recorded injection occurrences', () => {
    const feed = composeHomeFeed({
      baseline: [makePost('shared-base'), makePost('followed-1')],
      recommendations: [makePost('shared-base'), makePost('shared-candidate')],
      discovery: [makePost('shared-base'), makePost('shared-candidate'), makePost('discovery-high')],
      injections: [
        { postId: 'shared-base', source: 'recommendation', injectedAt: 1 },
        { postId: 'shared-candidate', source: 'recommendation', injectedAt: 2 },
        { postId: 'shared-candidate', source: 'discovery', injectedAt: 3 },
        { postId: 'discovery-high', source: 'discovery', injectedAt: 4 }
      ],
      getRecommendationSummary: summary,
      replyCounts: new Map([['discovery-high', 10]])
    });

    expect(feed.map((post) => post.object.object_id)).toEqual(['shared-base', 'followed-1', 'shared-candidate', 'discovery-high']);
    expect(feed.find((post) => post.object.object_id === 'shared-candidate')?.homeFeedSource).toBe('recommendation');
    expect(feed.find((post) => post.object.object_id === 'shared-candidate')?.injectedAt).toBe(2);
  });
});
