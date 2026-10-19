export type HomeFeedInjectionSource = 'recommendation' | 'discovery';

export interface HomeFeedInjection {
  readonly postId: string;
  readonly source: HomeFeedInjectionSource;
  readonly injectedAt: number;
}

export interface HomeFeedInjectionState {
  readonly recommendationThreshold: number;
  readonly discoveryThreshold: number;
  readonly recommendationPostsSinceInjection: number;
  readonly discoveryPostsSinceInjection: number;
  readonly injections: readonly HomeFeedInjection[];
}

export interface HomeFeedInjectionCandidates {
  readonly recommendations: readonly string[];
  readonly discovery: readonly string[];
}

export const DEFAULT_HOME_FEED_INJECTION_THRESHOLDS = {
  recommendation: 2,
  discovery: 6
} as const;

export const EMPTY_HOME_FEED_INJECTION_STATE: HomeFeedInjectionState = {
  recommendationThreshold: DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.recommendation,
  discoveryThreshold: DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.discovery,
  recommendationPostsSinceInjection: 0,
  discoveryPostsSinceInjection: 0,
  injections: []
};

export function homeFeedInjectionStorageKey(identityId: string): string {
  if (!identityId.trim()) throw new Error('Home feed injection settings require an identity ID');
  return `myceliumHomeFeedInjections:${identityId}`;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isValidInjectionThreshold(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isInjection(value: unknown): value is HomeFeedInjection {
  if (!value || typeof value !== 'object') return false;
  const injection = value as Partial<HomeFeedInjection>;
  return typeof injection.postId === 'string'
    && injection.postId.length > 0
    && (injection.source === 'recommendation' || injection.source === 'discovery')
    && Number.isFinite(injection.injectedAt);
}

export function parseHomeFeedInjectionState(raw: string | null): HomeFeedInjectionState {
  if (raw === null) return EMPTY_HOME_FEED_INJECTION_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Stored Home feed injection state is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Stored Home feed injection state must be an object');
  }
  const state = parsed as Partial<HomeFeedInjectionState>;
  const recommendationThreshold = state.recommendationThreshold
    ?? DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.recommendation;
  const discoveryThreshold = state.discoveryThreshold
    ?? DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.discovery;
  if (!validCount(recommendationThreshold)
    || !validCount(discoveryThreshold)
    || !validCount(state.recommendationPostsSinceInjection)
    || !validCount(state.discoveryPostsSinceInjection)
    || !Array.isArray(state.injections)
    || !state.injections.every(isInjection)) {
    throw new Error('Stored Home feed injection state has an invalid shape');
  }
  const uniqueIds = new Set(state.injections.map((injection) => injection.postId));
  if (uniqueIds.size !== state.injections.length) {
    throw new Error('Stored Home feed injection state contains duplicate post IDs');
  }
  return {
    recommendationThreshold,
    discoveryThreshold,
    recommendationPostsSinceInjection: state.recommendationPostsSinceInjection,
    discoveryPostsSinceInjection: state.discoveryPostsSinceInjection,
    injections: state.injections
  };
}

function injectIfReady(
  state: HomeFeedInjectionState,
  source: HomeFeedInjectionSource,
  candidates: readonly string[],
  injectedAt: number,
  threshold: number
): HomeFeedInjectionState {
  const count = source === 'recommendation'
    ? state.recommendationPostsSinceInjection
    : state.discoveryPostsSinceInjection;
  if (threshold === 0 || count <= threshold) return state;

  const alreadyInjected = new Set(state.injections.map((injection) => injection.postId));
  const postId = candidates.find((candidate) => candidate.length > 0 && !alreadyInjected.has(candidate));
  if (!postId) return state;

  return {
    ...state,
    recommendationPostsSinceInjection: source === 'recommendation' ? 0 : state.recommendationPostsSinceInjection,
    discoveryPostsSinceInjection: source === 'discovery' ? 0 : state.discoveryPostsSinceInjection,
    injections: [...state.injections, { postId, source, injectedAt }]
  };
}

function flushReadyInjections(
  state: HomeFeedInjectionState,
  candidates: HomeFeedInjectionCandidates,
  now: number
): HomeFeedInjectionState {
  const withRecommendation = injectIfReady(
    state,
    'recommendation',
    candidates.recommendations,
    now,
    state.recommendationThreshold
  );
  return injectIfReady(
    withRecommendation,
    'discovery',
    candidates.discovery,
    now,
    withRecommendation.discoveryThreshold
  );
}

export class HomeFeedInjectionScheduler {
  private state: HomeFeedInjectionState;
  private readonly processedPostIds = new Set<string>();

  constructor(
    initialState: HomeFeedInjectionState,
    private readonly persist: (state: HomeFeedInjectionState) => void
  ) {
    this.state = initialState;
  }

  getState(): HomeFeedInjectionState {
    return this.state;
  }

  recordNewEligiblePost(
    postId: string,
    candidates: HomeFeedInjectionCandidates,
    now = Date.now()
  ): boolean {
    if (!postId || this.processedPostIds.has(postId)) return false;
    this.processedPostIds.add(postId);
    const next = flushReadyInjections({
      recommendationThreshold: this.state.recommendationThreshold,
      discoveryThreshold: this.state.discoveryThreshold,
      recommendationPostsSinceInjection: this.state.recommendationPostsSinceInjection + 1,
      discoveryPostsSinceInjection: this.state.discoveryPostsSinceInjection + 1,
      injections: this.state.injections
    }, candidates, now);
    this.commit(next);
    return true;
  }

  flushPendingInjections(candidates: HomeFeedInjectionCandidates, now = Date.now()): boolean {
    const next = flushReadyInjections(this.state, candidates, now);
    if (next === this.state) return false;
    this.commit(next);
    return true;
  }

  setThresholds(recommendationThreshold: number, discoveryThreshold: number): boolean {
    if (!isValidInjectionThreshold(recommendationThreshold) || !isValidInjectionThreshold(discoveryThreshold)) {
      throw new Error('Home feed injection thresholds must be non-negative whole numbers');
    }
    if (recommendationThreshold === this.state.recommendationThreshold
      && discoveryThreshold === this.state.discoveryThreshold) return false;
    const next: HomeFeedInjectionState = {
      ...this.state,
      recommendationThreshold,
      discoveryThreshold,
      recommendationPostsSinceInjection: recommendationThreshold === this.state.recommendationThreshold
        ? this.state.recommendationPostsSinceInjection
        : 0,
      discoveryPostsSinceInjection: discoveryThreshold === this.state.discoveryThreshold
        ? this.state.discoveryPostsSinceInjection
        : 0
    };
    this.commit(next);
    return true;
  }

  private commit(next: HomeFeedInjectionState): void {
    this.state = next;
    this.persist(next);
  }
}
