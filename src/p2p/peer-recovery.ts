import type { PeerUsefulnessEstimate } from './peer-usefulness';

export interface PreviouslyConnectedPeer {
  readonly peerId: string;
  readonly lastConnectedAt: string;
}

export interface PeerRecoveryOptions {
  readonly getConnectedPeers: () => readonly string[];
  readonly getPendingPeerIds?: () => readonly string[];
  readonly getPreviouslyConnectedPeers: () => readonly PreviouslyConnectedPeer[];
  readonly discoverOnlinePeers: () => Promise<readonly string[]>;
  readonly getPeerUsefulnessEstimates?: (
    peerIds: readonly string[],
    connectedPeerIds: readonly string[]
  ) => Promise<readonly PeerUsefulnessEstimate[]>;
  readonly onPeerUsefulnessError?: (error: unknown) => void;
  readonly isAttemptInProgress: (peerId: string) => boolean;
  readonly attemptPeer: (peerId: string) => Promise<boolean>;
  readonly preferredTarget?: number;
  readonly maxConcurrentAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly peerBackoffBaseMs?: number;
  readonly peerBackoffMaxMs?: number;
  readonly now?: () => number;
}

interface PeerFailure {
  readonly attempts: number;
  readonly retryAt: number;
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_PEER_BACKOFF_BASE_MS = 5_000;
const DEFAULT_PEER_BACKOFF_MAX_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_ATTEMPTS = 2;
export const DEFAULT_PREFERRED_CONNECTION_TARGET = 10;
export const MIN_USEFULNESS_SELECTION_CONFIDENCE = 0.5;

interface PeerCandidateRotation {
  lastExplorationPeerId?: string;
  lastCrediblePeerId?: string;
}

interface PeerCandidateGroups {
  explorationPeerIds: ReadonlySet<string>;
  crediblePeerIds: ReadonlySet<string>;
}

export function prioritizePeerCandidates(
  candidates: readonly string[],
  estimates: readonly PeerUsefulnessEstimate[],
  rotation: PeerCandidateRotation = {}
): string[] {
  const uniqueCandidates = [...new Set(candidates.filter((peerId) => peerId.trim().length > 0))];
  if (uniqueCandidates.length < 2) return uniqueCandidates;

  const estimatesByPeer = new Map<string, PeerUsefulnessEstimate>();
  for (const estimate of estimates) {
    if (!estimate || !estimate.peer_id || !Number.isFinite(estimate.score)
      || !Number.isFinite(estimate.confidence)) continue;
    const previous = estimatesByPeer.get(estimate.peer_id);
    if (!previous || estimate.confidence > previous.confidence) {
      estimatesByPeer.set(estimate.peer_id, estimate);
    }
  }

  const hasCredibleUsefulness = (estimate: PeerUsefulnessEstimate | undefined): estimate is PeerUsefulnessEstimate => (
    estimate !== undefined
    && estimate.confidence >= MIN_USEFULNESS_SELECTION_CONFIDENCE
    && estimate.novel_object_weight > 0
  );
  const credibleCandidates = uniqueCandidates.filter((peerId) => hasCredibleUsefulness(estimatesByPeer.get(peerId)));
  if (credibleCandidates.length === 0) {
    const explorationCandidates = [...uniqueCandidates].sort((left, right) => left.localeCompare(right));
    return rotateAfterPeer(explorationCandidates, rotation.lastExplorationPeerId);
  }

  const explorationCandidates = uniqueCandidates.filter((peerId) => (
    !hasCredibleUsefulness(estimatesByPeer.get(peerId))
  )).sort((left, right) => left.localeCompare(right));
  const explorationPeer = rotateAfterPeer(explorationCandidates, rotation.lastExplorationPeerId)[0];

  const rankedCredible = credibleCandidates
    .map((peerId, index) => ({ peerId, index, score: estimatesByPeer.get(peerId)!.score }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const diversifiedCredible = rotateAfterPeer(
    rankedCredible.map(({ peerId }) => peerId),
    rotation.lastCrediblePeerId
  );

  return [
    ...(explorationPeer ? [explorationPeer] : []),
    ...diversifiedCredible,
    ...uniqueCandidates.filter((peerId) => (
      peerId !== explorationPeer && !credibleCandidates.includes(peerId)
    ))
  ];
}

function rotateAfterPeer(peerIds: readonly string[], previousPeerId?: string): string[] {
  if (peerIds.length < 2 || !previousPeerId) return [...peerIds];
  const previousIndex = peerIds.indexOf(previousPeerId);
  if (previousIndex < 0) return [...peerIds];
  const nextIndex = (previousIndex + 1) % peerIds.length;
  return [...peerIds.slice(nextIndex), ...peerIds.slice(0, nextIndex)];
}

function isCredibleUsefulness(estimate: PeerUsefulnessEstimate | undefined): estimate is PeerUsefulnessEstimate {
  return estimate !== undefined
    && estimate.confidence >= MIN_USEFULNESS_SELECTION_CONFIDENCE
  && estimate.novel_object_weight > 0;
}

export class PeerConnectionCapacity {
  private readonly getConnectedPeers: () => readonly string[];
  private readonly hardMaximum: number;
  private readonly maxConcurrentAttempts: number;
  private readonly reservations = new Set<string>();

  constructor(
    getConnectedPeers: () => readonly string[],
    hardMaximum = 20,
    maxConcurrentAttempts = 4,
    private readonly preferredTarget = DEFAULT_PREFERRED_CONNECTION_TARGET
  ) {
    this.getConnectedPeers = getConnectedPeers;
    this.hardMaximum = normalizePositiveInteger(hardMaximum, 20);
    this.maxConcurrentAttempts = normalizePositiveInteger(maxConcurrentAttempts, 4);
    this.preferredTarget = Math.min(
      normalizePositiveInteger(preferredTarget, DEFAULT_PREFERRED_CONNECTION_TARGET),
      this.hardMaximum
    );
  }

  reserve(peerId: string, direction: 'inbound' | 'outbound'): boolean {
    if (!peerId.trim()) return false;
    const connected = new Set(this.getConnectedPeers());
    if (connected.has(peerId) || this.reservations.has(peerId)) return true;

    const occupied = new Set([...connected, ...this.reservations]);
    if (occupied.size >= this.hardMaximum || this.reservations.size >= this.maxConcurrentAttempts) {
      return false;
    }
    if (direction === 'outbound' && occupied.size >= this.preferredTarget) return false;
    this.reservations.add(peerId);
    return true;
  }

  release(peerId: string): void {
    this.reservations.delete(peerId);
  }

  getPendingPeerIds(): readonly string[] {
    return [...this.reservations];
  }

  getOccupiedCount(): number {
    return new Set([...this.getConnectedPeers(), ...this.reservations]).size;
  }
}

export class PeerRecoveryCoordinator {
  private readonly options: PeerRecoveryOptions;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, PeerFailure>();
  private readonly candidateRotation: PeerCandidateRotation = {};
  private active = false;
  private running = false;
  private pendingRun = false;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIndex = 0;
  private stopWaiter: (() => void) | null = null;
  private lastObservedCount = 0;
  private selectionRound = 0;

  constructor(options: PeerRecoveryOptions) {
    this.options = options;
  }

  get isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    this.stop();
  }

  notifyConnectivityChanged(): void {
    const connectedCount = new Set(this.options.getConnectedPeers()).size;
    const preferredTarget = normalizePositiveInteger(
      this.options.preferredTarget,
      DEFAULT_PREFERRED_CONNECTION_TARGET
    );
    if (connectedCount >= preferredTarget) {
      this.stop();
      this.lastObservedCount = connectedCount;
      return;
    }
    if (this.active) {
      if (connectedCount < this.lastObservedCount && this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        void this.run(this.generation);
      }
      this.lastObservedCount = connectedCount;
      return;
    }

    this.active = true;
    this.retryIndex = 0;
    this.lastObservedCount = connectedCount;
    this.generation += 1;
    if (this.running) {
      this.pendingRun = true;
      return;
    }
    void this.run(this.generation);
  }

  private stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.pendingRun = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopWaiter?.();
    this.stopWaiter = null;
  }

  private async run(generation: number): Promise<void> {
    if (this.running || !this.active) return;
    this.running = true;
    let stopWait: Promise<void> | null = null;
    try {
      stopWait = new Promise<void>((resolve) => {
        this.stopWaiter = resolve;
      });

      const knownPeers = [...this.options.getPreviouslyConnectedPeers()]
        .filter((peer) => peer.peerId.trim().length > 0)
        .sort((left, right) => compareRecentConnection(left.lastConnectedAt, right.lastConnectedAt));
      const tried = new Set<string>();
      const remaining: string[] = [];
      let discoveryComplete = false;
      let candidateGroups: PeerCandidateGroups | undefined;
      const discovery = this.options.discoverOnlinePeers()
        .catch(() => [] as readonly string[])
        .then(async (onlinePeers) => {
          discoveryComplete = true;
          const onlineSet = new Set(onlinePeers.filter((peerId) => peerId.trim().length > 0));
          const discoveredCandidates = [
            ...knownPeers.map((peer) => peer.peerId).filter((peerId) => onlineSet.has(peerId)),
            ...new Set(onlinePeers.filter((peerId) => !knownPeers.some((peer) => peer.peerId === peerId)))
          ];
          const prioritizedOnlinePeers = [...new Set(discoveredCandidates)].filter((peerId) => (
            !tried.has(peerId) && !this.inFlight.has(peerId)
          ));
          let orderedCandidates = prioritizedOnlinePeers;
          if (this.options.getPeerUsefulnessEstimates && orderedCandidates.length > 1) {
            try {
              const connectedPeerIds = [...new Set(this.options.getConnectedPeers())];
              const estimates = await this.options.getPeerUsefulnessEstimates(
                orderedCandidates,
                connectedPeerIds
              );
              const estimatesByPeer = new Map(estimates.map((estimate) => [estimate.peer_id, estimate]));
              candidateGroups = {
                explorationPeerIds: new Set(orderedCandidates.filter((peerId) => (
                  !isCredibleUsefulness(estimatesByPeer.get(peerId))
                ))),
                crediblePeerIds: new Set(orderedCandidates.filter((peerId) => (
                  isCredibleUsefulness(estimatesByPeer.get(peerId))
                )))
              };
              orderedCandidates = prioritizePeerCandidates(orderedCandidates, estimates, this.candidateRotation);
            } catch (error) {
              this.options.onPeerUsefulnessError?.(error);
            }
          }
          remaining.push(...orderedCandidates);
        });

      while (this.isCurrent(generation) && this.hasCapacityToFill()) {
        this.fillAttemptQueue(remaining, tried, undefined, candidateGroups);
        if (discoveryComplete && remaining.length === 0 && this.inFlight.size === 0) break;

        const pending: Promise<unknown>[] = [...this.inFlight.values()];
        if (!discoveryComplete) pending.push(discovery);
        if (pending.length === 0) break;
        await Promise.race([...pending, stopWait]);
      }

      if (!this.isCurrent(generation)) return;
      if (new Set(this.options.getConnectedPeers()).size >= this.preferredTarget()) {
        this.stop();
        return;
      }
      this.scheduleRetry();
    } finally {
      this.running = false;
      if (this.generation === generation && this.stopWaiter && stopWait) this.stopWaiter = null;
      if (this.pendingRun && this.active) {
        this.pendingRun = false;
        void this.run(this.generation);
      }
    }
  }

  private fillAttemptQueue(
    remaining: string[],
    tried: Set<string>,
    concurrencyLimit?: number,
    candidateGroups?: PeerCandidateGroups
  ): void {
    const configuredLimit = normalizePositiveInteger(
      this.options.maxConcurrentAttempts,
      DEFAULT_MAX_CONCURRENT_ATTEMPTS
    );
    const maxConcurrent = Math.min(configuredLimit, concurrencyLimit ?? configuredLimit);
    while (
      remaining.length > 0
      && this.inFlight.size < maxConcurrent
      && this.pendingPeerIds().size < configuredLimit
      && this.occupiedPeerIds().size < this.preferredTarget()
    ) {
      const peerId = remaining.shift();
      if (!peerId || tried.has(peerId) || this.inFlight.has(peerId)
        || this.options.getConnectedPeers().includes(peerId)
        || this.options.isAttemptInProgress(peerId) || !this.canAttempt(peerId)) continue;
      tried.add(peerId);
      if (candidateGroups?.explorationPeerIds.has(peerId)) {
        this.candidateRotation.lastExplorationPeerId = peerId;
      } else if (candidateGroups?.crediblePeerIds.has(peerId)) {
        this.candidateRotation.lastCrediblePeerId = peerId;
      }
      this.startAttempt(peerId);
    }
  }

  private hasCapacityToFill(): boolean {
    return this.occupiedPeerIds().size < this.preferredTarget();
  }

  private occupiedPeerIds(): Set<string> {
    return new Set([...this.options.getConnectedPeers(), ...this.pendingPeerIds()]);
  }

  private pendingPeerIds(): Set<string> {
    return new Set([
      ...(this.options.getPendingPeerIds?.() ?? []),
      ...this.inFlight.keys()
    ]);
  }

  private preferredTarget(): number {
    return normalizePositiveInteger(this.options.preferredTarget, DEFAULT_PREFERRED_CONNECTION_TARGET);
  }

  private startAttempt(peerId: string): void {
    let result: Promise<boolean>;
    try {
      result = Promise.resolve(this.options.attemptPeer(peerId));
    } catch (error) {
      result = Promise.reject(error);
    }
    const attempt = result
      .then((connected) => {
        if (connected) this.failures.delete(peerId);
        else this.recordFailure(peerId);
      })
      .catch(() => this.recordFailure(peerId))
      .finally(() => {
        this.inFlight.delete(peerId);
      });
    this.inFlight.set(peerId, attempt);
  }

  private canAttempt(peerId: string): boolean {
    const failure = this.failures.get(peerId);
    return !failure || failure.retryAt <= (this.options.now?.() ?? Date.now());
  }

  private recordFailure(peerId: string): void {
    const attempts = (this.failures.get(peerId)?.attempts ?? 0) + 1;
    const base = this.options.peerBackoffBaseMs ?? DEFAULT_PEER_BACKOFF_BASE_MS;
    const maximum = this.options.peerBackoffMaxMs ?? DEFAULT_PEER_BACKOFF_MAX_MS;
    const delay = Math.min(maximum, base * (2 ** (attempts - 1)));
    this.failures.set(peerId, {
      attempts,
      retryAt: (this.options.now?.() ?? Date.now()) + delay
    });
  }

  private scheduleRetry(): void {
    if (!this.active || this.retryTimer !== null) return;
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.retryIndex, delays.length - 1)] ?? DEFAULT_RETRY_DELAYS_MS[0];
    this.retryIndex += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.run(this.generation);
    }, delay);
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.generation === generation;
  }
}

function compareRecentConnection(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.localeCompare(right);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
