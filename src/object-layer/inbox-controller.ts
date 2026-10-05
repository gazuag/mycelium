export type InboxSyncReason = 'startup' | 'peer_connected' | 'timer' | 'manual';

export interface InboxSyncResult {
  stored: number;
  truncated: boolean;
}

export interface InboxControllerConfig {
  debounceMs: number;
  minGapMs: number;
  intervalMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface InboxControllerState {
  running: boolean;
  lastRunAt: number | null;
  consecutiveFailures: number;
  nextAllowedAt: number;
}

export interface InboxControllerOptions {
  syncOnce: () => Promise<InboxSyncResult>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  config?: Partial<InboxControllerConfig>;
}

const DEFAULT_CONFIG: InboxControllerConfig = {
  debounceMs: 2_000,
  minGapMs: 10_000,
  intervalMs: 60_000,
  backoffBaseMs: 15_000,
  backoffMaxMs: 600_000
};

export function createInboxController({
  syncOnce,
  now = Date.now,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  config: configOverrides = {}
}: InboxControllerOptions) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  let stopped = false;
  let running = false;
  let lastRunAt: number | null = null;
  let consecutiveFailures = 0;
  let backoffUntil = 0;
  let pending = false;
  let pendingManual = false;
  let debounceTimer: unknown | null = null;
  let wakeTimer: unknown | null = null;
  let periodicTimer: unknown | null = null;

  const clearHandle = (handle: unknown | null) => {
    if (handle !== null) clearTimer(handle);
  };

  const clearDebounceTimer = () => {
    clearHandle(debounceTimer);
    debounceTimer = null;
  };

  const clearWakeTimer = () => {
    clearHandle(wakeTimer);
    wakeTimer = null;
  };

  const clearPeriodicTimer = () => {
    clearHandle(periodicTimer);
    periodicTimer = null;
  };

  const schedulePeriodic = () => {
    if (stopped || periodicTimer !== null) return;
    periodicTimer = setTimer(() => {
      periodicTimer = null;
      if (stopped) return;
      trigger('timer');
      schedulePeriodic();
    }, config.intervalMs);
  };

  const runPending = async () => {
    if (stopped || running || !pending || debounceTimer !== null) return;
    const currentTime = now();
    const minGapAt = lastRunAt === null ? currentTime : lastRunAt + config.minGapMs;
    const allowedAt = Math.max(minGapAt, pendingManual ? currentTime : backoffUntil);
    if (currentTime < allowedAt) {
      clearWakeTimer();
      wakeTimer = setTimer(() => {
        wakeTimer = null;
        void runPending();
      }, allowedAt - currentTime);
      return;
    }

    clearWakeTimer();
    pending = false;
    pendingManual = false;
    running = true;
    lastRunAt = currentTime;

    try {
      const result = await syncOnce();
      if (result.truncated) {
        consecutiveFailures += 1;
        const delay = Math.min(
          config.backoffBaseMs * 2 ** (consecutiveFailures - 1),
          config.backoffMaxMs
        );
        backoffUntil = now() + delay;
      } else {
        consecutiveFailures = 0;
        backoffUntil = 0;
      }
    } catch {
      consecutiveFailures += 1;
      const delay = Math.min(
        config.backoffBaseMs * 2 ** (consecutiveFailures - 1),
        config.backoffMaxMs
      );
      backoffUntil = now() + delay;
    } finally {
      running = false;
      if (!stopped) void runPending();
    }
  };

  function trigger(reason: InboxSyncReason): void {
    if (stopped) return;

    pending = true;
    if (reason === 'manual') {
      pendingManual = true;
      clearDebounceTimer();
    } else if (reason === 'peer_connected') {
      if (pendingManual) {
        void runPending();
        return;
      }
      clearWakeTimer();
      clearDebounceTimer();
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        void runPending();
      }, config.debounceMs);
      return;
    } else {
      clearDebounceTimer();
    }

    void runPending();
  }

  function start(): void {
    if (!stopped && periodicTimer !== null) return;
    stopped = false;
    schedulePeriodic();
    void runPending();
  }

  function stop(): void {
    stopped = true;
    pending = false;
    pendingManual = false;
    clearDebounceTimer();
    clearWakeTimer();
    clearPeriodicTimer();
  }

  function getState(): InboxControllerState {
    const minGapAt = lastRunAt === null ? now() : lastRunAt + config.minGapMs;
    return {
      running,
      lastRunAt,
      consecutiveFailures,
      nextAllowedAt: Math.max(minGapAt, backoffUntil)
    };
  }

  return { trigger, start, stop, getState };
}
