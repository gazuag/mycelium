export interface PreviouslyConnectedPeer {
  readonly peerId: string;
  readonly lastConnectedAt: string;
}

export interface PeerRecoveryOptions {
  readonly getConnectedPeers: () => readonly string[];
  readonly getPreviouslyConnectedPeers: () => readonly PreviouslyConnectedPeer[];
  readonly discoverOnlinePeers: () => Promise<readonly string[]>;
  readonly isAttemptInProgress: (peerId: string) => boolean;
  readonly attemptPeer: (peerId: string) => Promise<boolean>;
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

export class PeerRecoveryCoordinator {
  private readonly options: PeerRecoveryOptions;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, PeerFailure>();
  private active = false;
  private running = false;
  private pendingRun = false;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIndex = 0;
  private stopWaiter: (() => void) | null = null;

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
    if (this.options.getConnectedPeers().length > 0) {
      this.stop();
      return;
    }
    if (this.active) return;

    this.active = true;
    this.retryIndex = 0;
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
      const remaining = knownPeers.map((peer) => peer.peerId);
      this.fillAttemptQueue(remaining, tried, 1);
      let discoveryComplete = false;
      const discovery = this.options.discoverOnlinePeers()
        .catch(() => [] as readonly string[])
        .then((onlinePeers) => {
          discoveryComplete = true;
          const onlineSet = new Set(onlinePeers.filter((peerId) => peerId.trim().length > 0));
          const prioritizedOnlinePeers = [
            ...knownPeers.map((peer) => peer.peerId).filter((peerId) => onlineSet.has(peerId)),
            ...new Set(onlinePeers.filter((peerId) => !knownPeers.some((peer) => peer.peerId === peerId)))
          ];
          remaining.splice(0, remaining.length, ...prioritizedOnlinePeers.filter((peerId) => (
            !tried.has(peerId) && !this.inFlight.has(peerId)
          )));
          for (const peerId of onlineSet) {
            if (!prioritizedOnlinePeers.includes(peerId) && !tried.has(peerId) && !this.inFlight.has(peerId)) {
              remaining.push(peerId);
            }
          }
        });

      while (this.isCurrent(generation) && this.options.getConnectedPeers().length === 0) {
        this.fillAttemptQueue(remaining, tried);
        if (discoveryComplete && remaining.length === 0 && this.inFlight.size === 0) break;

        const pending: Promise<unknown>[] = [...this.inFlight.values()];
        if (!discoveryComplete) pending.push(discovery);
        if (pending.length === 0) break;
        await Promise.race([...pending, stopWait]);
      }

      if (!this.isCurrent(generation) || this.options.getConnectedPeers().length > 0) return;
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

  private fillAttemptQueue(remaining: string[], tried: Set<string>, concurrencyLimit?: number): void {
    const configuredLimit = normalizePositiveInteger(
      this.options.maxConcurrentAttempts,
      DEFAULT_MAX_CONCURRENT_ATTEMPTS
    );
    const maxConcurrent = Math.min(configuredLimit, concurrencyLimit ?? configuredLimit);
    while (remaining.length > 0 && this.inFlight.size < maxConcurrent) {
      const peerId = remaining.shift();
      if (!peerId || tried.has(peerId) || this.inFlight.has(peerId)
        || this.options.isAttemptInProgress(peerId) || !this.canAttempt(peerId)) continue;
      tried.add(peerId);
      this.startAttempt(peerId);
    }
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
