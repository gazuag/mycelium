import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeerRecoveryCoordinator, type PeerRecoveryOptions } from './peer-recovery';

const flushMicrotasks = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

function createCoordinator(overrides: Partial<PeerRecoveryOptions> = {}) {
  const connectedPeers: string[] = [];
  const options: PeerRecoveryOptions = {
    getConnectedPeers: () => connectedPeers,
    getPreviouslyConnectedPeers: () => [],
    discoverOnlinePeers: async () => [],
    isAttemptInProgress: () => false,
    attemptPeer: async () => false,
    retryDelaysMs: [10],
    peerBackoffBaseMs: 10,
    peerBackoffMaxMs: 10,
    ...overrides
  };
  return { coordinator: new PeerRecoveryCoordinator(options), connectedPeers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PeerRecoveryCoordinator', () => {
  it('starts urgent recovery when the last connection is lost and checks on startup', async () => {
    let discoveries = 0;
    const { coordinator, connectedPeers } = createCoordinator({
      getConnectedPeers: () => connectedPeers,
      discoverOnlinePeers: async () => {
        discoveries += 1;
        return [];
      }
    });

    connectedPeers.push('existing-peer');
    coordinator.notifyConnectivityChanged();
    expect(discoveries).toBe(0);

    connectedPeers.length = 0;
    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(discoveries).toBe(1);
    coordinator.dispose();
  });

  it('attempts previously connected peers before querying for discovered peers', async () => {
    const events: string[] = [];
    const { coordinator } = createCoordinator({
      getPreviouslyConnectedPeers: () => [
        { peerId: 'known-peer', lastConnectedAt: '2026-06-02T00:00:00Z' }
      ],
      discoverOnlinePeers: async () => {
        events.push('discovery');
        return ['discovered-peer'];
      },
      attemptPeer: async (peerId) => {
        events.push(peerId);
        return false;
      },
      maxConcurrentAttempts: 1
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(events).toEqual(['known-peer', 'discovery', 'discovered-peer']);
    coordinator.dispose();
  });

  it('falls back to currently discovered peers when no known peer restores connectivity', async () => {
    const attempts: string[] = [];
    let resolveStaleAttempt: ((connected: boolean) => void) | undefined;
    const { coordinator } = createCoordinator({
      getPreviouslyConnectedPeers: () => [
        { peerId: 'stale-known-peer', lastConnectedAt: '2026-06-02T00:00:00Z' }
      ],
      discoverOnlinePeers: async () => ['online-cache-peer'],
      attemptPeer: async (peerId) => {
        attempts.push(peerId);
        if (peerId === 'stale-known-peer') {
          return new Promise<boolean>((resolve) => {
            resolveStaleAttempt = resolve;
          });
        }
        return false;
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(attempts).toEqual(['stale-known-peer', 'online-cache-peer']);
    coordinator.dispose();
    resolveStaleAttempt?.(false);
    await flushMicrotasks();
  });

  it('suppresses duplicate recovery attempts for the same peer', async () => {
    let resolveAttempt: ((connected: boolean) => void) | undefined;
    let attempts = 0;
    const { coordinator } = createCoordinator({
      discoverOnlinePeers: async () => ['peer-a'],
      attemptPeer: () => {
        attempts += 1;
        return new Promise<boolean>((resolve) => {
          resolveAttempt = resolve;
        });
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(attempts).toBe(1);
    resolveAttempt?.(false);
    await flushMicrotasks();
    coordinator.dispose();
  });

  it('retries failed peers with bounded backoff', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { coordinator } = createCoordinator({
      discoverOnlinePeers: async () => ['peer-a'],
      attemptPeer: async () => {
        attempts += 1;
        return false;
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(attempts).toBe(2);
    coordinator.dispose();
  });

  it('stops urgent recovery as soon as a peer connects', async () => {
    let coordinator: PeerRecoveryCoordinator;
    const { connectedPeers } = createCoordinator();
    coordinator = new PeerRecoveryCoordinator({
      getConnectedPeers: () => connectedPeers,
      getPreviouslyConnectedPeers: () => [],
      discoverOnlinePeers: async () => ['peer-a'],
      isAttemptInProgress: () => false,
      attemptPeer: async () => {
        connectedPeers.push('peer-a');
        coordinator.notifyConnectivityChanged();
        return true;
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(coordinator.isActive).toBe(false);
    coordinator.dispose();
  });
});
