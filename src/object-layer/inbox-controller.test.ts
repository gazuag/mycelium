import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInboxController } from './inbox-controller';

const SUCCESS = { stored: 1, truncated: false };

function createController(syncOnce: () => Promise<{ stored: number; truncated: boolean }>, options: {
  debounceMs?: number;
  minGapMs?: number;
  intervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
} = {}) {
  return createInboxController({
    syncOnce,
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    config: {
      debounceMs: 2_000,
      minGapMs: 10_000,
      intervalMs: 60_000,
      backoffBaseMs: 15_000,
      backoffMaxMs: 60_000,
      ...options
    }
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('inbox sync controller', () => {
  it('runs startup immediately', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn(async () => SUCCESS);
    const controller = createController(syncOnce);

    controller.trigger('startup');
    await flushMicrotasks();

    expect(syncOnce).toHaveBeenCalledOnce();
    expect(controller.getState().lastRunAt).toBe(Date.now());
    controller.stop();
  });

  it('debounces a burst of peer-connected triggers into one run', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn(async () => SUCCESS);
    const controller = createController(syncOnce);

    controller.trigger('peer_connected');
    await vi.advanceTimersByTimeAsync(1_000);
    controller.trigger('peer_connected');
    await vi.advanceTimersByTimeAsync(1_000);
    controller.trigger('peer_connected');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(syncOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(syncOnce).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('coalesces triggers during a run into exactly one follow-up', async () => {
    vi.useFakeTimers();
    let finish!: (result: typeof SUCCESS) => void;
    const syncOnce = vi.fn(() => new Promise<typeof SUCCESS>((resolve) => { finish = resolve; }));
    const controller = createController(syncOnce, { minGapMs: 0 });

    controller.trigger('startup');
    controller.trigger('timer');
    controller.trigger('startup');
    expect(syncOnce).toHaveBeenCalledOnce();
    finish(SUCCESS);
    await flushMicrotasks();

    expect(syncOnce).toHaveBeenCalledTimes(2);
    finish(SUCCESS);
    await flushMicrotasks();
    expect(syncOnce).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('never overlaps syncOnce calls when triggers arrive while a run is pending', async () => {
    vi.useFakeTimers();
    let finish!: (result: typeof SUCCESS) => void;
    let inFlight = 0;
    let maximumInFlight = 0;
    const syncOnce = vi.fn(() => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      return new Promise<typeof SUCCESS>((resolve) => {
        finish = (result) => {
          inFlight -= 1;
          resolve(result);
        };
      });
    });
    const controller = createController(syncOnce, { minGapMs: 0 });

    controller.trigger('startup');
    controller.trigger('manual');
    controller.trigger('timer');
    expect(maximumInFlight).toBe(1);
    finish(SUCCESS);
    await flushMicrotasks();
    expect(maximumInFlight).toBe(1);
    finish(SUCCESS);
    await flushMicrotasks();
    controller.stop();
  });

  it('defers a trigger inside the minimum gap instead of dropping it', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn(async () => SUCCESS);
    const controller = createController(syncOnce, { minGapMs: 10_000 });

    controller.trigger('startup');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    controller.trigger('timer');
    await vi.advanceTimersByTimeAsync(8_999);
    expect(syncOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(syncOnce).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('fires periodic catch-up after intervalMs and reschedules the timer', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn(async () => SUCCESS);
    const controller = createController(syncOnce, { intervalMs: 5_000, minGapMs: 0 });

    controller.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(syncOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(syncOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    expect(syncOnce).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('backs off after failures and doubles the delay up to the configured cap', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn()
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockRejectedValueOnce(new Error('sync failed'));
    const controller = createController(syncOnce, {
      minGapMs: 0,
      backoffBaseMs: 1_000,
      backoffMaxMs: 3_000
    });

    controller.trigger('startup');
    await flushMicrotasks();
    expect(controller.getState().consecutiveFailures).toBe(1);
    expect(controller.getState().nextAllowedAt).toBe(Date.now() + 1_000);
    for (const delay of [1_000, 2_000, 3_000]) {
      controller.trigger('timer');
      await vi.advanceTimersByTimeAsync(delay);
      await flushMicrotasks();
    }
    expect(syncOnce).toHaveBeenCalledTimes(4);
    expect(controller.getState().consecutiveFailures).toBe(4);
    expect(controller.getState().nextAllowedAt).toBe(Date.now() + 3_000);
    controller.stop();
  });

  it('applies backoff when a sync result is truncated', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn(async () => ({ stored: 3, truncated: true }));
    const controller = createController(syncOnce, { minGapMs: 0, backoffBaseMs: 2_000 });

    controller.trigger('startup');
    await flushMicrotasks();

    expect(controller.getState().consecutiveFailures).toBe(1);
    expect(controller.getState().nextAllowedAt).toBe(Date.now() + 2_000);
    controller.stop();
  });

  it('resets consecutive failures after a successful sync', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn()
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockResolvedValueOnce(SUCCESS);
    const controller = createController(syncOnce, { minGapMs: 0, backoffBaseMs: 1_000 });

    controller.trigger('startup');
    await flushMicrotasks();
    expect(controller.getState().consecutiveFailures).toBe(1);
    controller.trigger('manual');
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(controller.getState().consecutiveFailures).toBe(0);
    expect(controller.getState().nextAllowedAt).toBeLessThanOrEqual(Date.now());
    controller.stop();
  });

  it('allows manual triggers to bypass backoff but not single-flight', async () => {
    vi.useFakeTimers();
    let finish!: (result: typeof SUCCESS) => void;
    const syncOnce = vi.fn()
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockImplementationOnce(() => new Promise<typeof SUCCESS>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(SUCCESS);
    const controller = createController(syncOnce, { minGapMs: 0, backoffBaseMs: 10_000 });

    controller.trigger('startup');
    await flushMicrotasks();
    controller.trigger('manual');
    await flushMicrotasks();
    expect(syncOnce).toHaveBeenCalledTimes(2);
    controller.trigger('manual');
    expect(syncOnce).toHaveBeenCalledTimes(2);
    finish(SUCCESS);
    await flushMicrotasks();
    expect(syncOnce).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('does not delay a queued manual follow-up with a peer debounce', async () => {
    vi.useFakeTimers();
    let finish!: (result: typeof SUCCESS) => void;
    const syncOnce = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof SUCCESS>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(SUCCESS);
    const controller = createController(syncOnce, { minGapMs: 0 });

    controller.trigger('startup');
    controller.trigger('manual');
    controller.trigger('peer_connected');
    finish(SUCCESS);
    await flushMicrotasks();

    expect(syncOnce).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('stop clears timers and ignores subsequent triggers', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn(async () => SUCCESS);
    const controller = createController(syncOnce);

    controller.start();
    controller.trigger('peer_connected');
    controller.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    controller.trigger('manual');
    await flushMicrotasks();

    expect(syncOnce).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start called twice does not create duplicate periodic timers', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn(async () => SUCCESS);
    const controller = createController(syncOnce, { intervalMs: 5_000, minGapMs: 0 });

    controller.start();
    controller.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    expect(syncOnce).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('does not leave the controller stuck or reject unhandled when syncOnce fails', async () => {
    vi.useFakeTimers();
    const syncOnce = vi.fn()
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockResolvedValueOnce(SUCCESS);
    const controller = createController(syncOnce, { minGapMs: 0, backoffBaseMs: 1_000 });

    controller.trigger('startup');
    await flushMicrotasks();
    expect(controller.getState().running).toBe(false);
    controller.trigger('manual');
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(syncOnce).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ running: false, consecutiveFailures: 0 });
    controller.stop();
  });
});
