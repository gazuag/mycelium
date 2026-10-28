import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERRED_CONNECTION_TARGET,
  PeerConnectionCapacity,
  PeerRecoveryCoordinator,
  prioritizePeerCandidates,
  type PeerRecoveryOptions
} from './peer-recovery';
import type { PeerUsefulnessEstimate } from './peer-usefulness';

const flushMicrotasks = async () => {
  for (let index = 0; index < 100; index += 1) await Promise.resolve();
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

function usefulness(
  peerId: string,
  score: number,
  confidence: number,
  novelObjectWeight = 1
): PeerUsefulnessEstimate {
  return {
    peer_id: peerId,
    direct_connection_observed: false,
    direct_identity_evidence: 'unknown',
    direct_connection_weight: 0,
    distinct_validated_objects: 1,
    distinct_verified_authors: 1,
    redundant_objects: 0,
    responsive_forwarded_origins: 0,
    novel_object_weight: novelObjectWeight,
    forwarded_response_weight: 0,
    score,
    confidence
  };
}

describe('PeerRecoveryCoordinator', () => {
  it('starts filling on startup and immediately resumes after connectivity drops', async () => {
    let discoveries = 0;
    const { coordinator, connectedPeers } = createCoordinator({
      getConnectedPeers: () => connectedPeers,
      preferredTarget: 1,
      discoverOnlinePeers: async () => {
        discoveries += 1;
        return [];
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(discoveries).toBe(1);

    connectedPeers.push('existing-peer');
    coordinator.notifyConnectivityChanged();
    expect(coordinator.isActive).toBe(false);
    connectedPeers.length = 0;
    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(discoveries).toBe(2);
    coordinator.dispose();
  });

  it('tries recently known online peers before unfamiliar online candidates', async () => {
    const events: string[] = [];
    const { coordinator } = createCoordinator({
      getPreviouslyConnectedPeers: () => [
        { peerId: 'older-peer', lastConnectedAt: '2026-06-01T00:00:00Z' },
        { peerId: 'recent-peer', lastConnectedAt: '2026-06-02T00:00:00Z' }
      ],
      discoverOnlinePeers: async () => {
        events.push('discovery');
        return ['unfamiliar-peer', 'older-peer', 'recent-peer'];
      },
      attemptPeer: async (peerId) => {
        events.push(peerId);
        return false;
      },
      maxConcurrentAttempts: 1
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(events).toEqual(['discovery', 'recent-peer', 'older-peer', 'unfamiliar-peer']);
    coordinator.dispose();
  });

  it('fills toward the preferred target from unfamiliar online peers', async () => {
    const attempts: string[] = [];
    const connectedPeers = ['peer-existing-1', 'peer-existing-2', 'peer-existing-3'];
    const { coordinator } = createCoordinator({
      getConnectedPeers: () => connectedPeers,
      discoverOnlinePeers: async () => Array.from({ length: 20 }, (_, index) => `new-peer-${index}`),
      attemptPeer: async (peerId) => {
        attempts.push(peerId);
        connectedPeers.push(peerId);
        return false;
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(connectedPeers).toHaveLength(DEFAULT_PREFERRED_CONNECTION_TARGET);
    expect(attempts).toHaveLength(DEFAULT_PREFERRED_CONNECTION_TARGET - 3);
    coordinator.dispose();
  });

  it('replaces a dead connection while still below target after another candidate fails', async () => {
    const connectedPeers = Array.from(
      { length: DEFAULT_PREFERRED_CONNECTION_TARGET },
      (_, index) => `peer-${index}`
    );
    const attempts: string[] = [];
    const { coordinator } = createCoordinator({
      getConnectedPeers: () => connectedPeers,
      discoverOnlinePeers: async () => ['failed-candidate', 'replacement-candidate'],
      attemptPeer: async (peerId) => {
        attempts.push(peerId);
        if (peerId === 'replacement-candidate') connectedPeers.push(peerId);
        return peerId === 'replacement-candidate';
      }
    });

    coordinator.notifyConnectivityChanged();
    expect(coordinator.isActive).toBe(false);
    connectedPeers.shift();
    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(connectedPeers).toHaveLength(DEFAULT_PREFERRED_CONNECTION_TARGET);
    expect(attempts).toEqual(['failed-candidate', 'replacement-candidate']);
    coordinator.dispose();
  });

  it('suppresses duplicate recovery attempts for the same peer', async () => {
    let resolveAttempt: ((connected: boolean) => void) | undefined;
    let attempts = 0;
    const { coordinator } = createCoordinator({
      discoverOnlinePeers: async () => ['peer-a'],
      preferredTarget: 1,
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

  it('stops recovery after the configured preferred target is reached', async () => {
    let coordinator: PeerRecoveryCoordinator;
    const { connectedPeers } = createCoordinator();
    coordinator = new PeerRecoveryCoordinator({
      getConnectedPeers: () => connectedPeers,
      getPreviouslyConnectedPeers: () => [],
      discoverOnlinePeers: async () => ['peer-a'],
      isAttemptInProgress: () => false,
      preferredTarget: 1,
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

  it('stops initiating new attempts at the preferred target', async () => {
    const connectedPeers: string[] = [];
    const attempts: string[] = [];
    const { coordinator } = createCoordinator({
      getConnectedPeers: () => connectedPeers,
      discoverOnlinePeers: async () => Array.from({ length: 30 }, (_, index) => `candidate-${index}`),
      attemptPeer: async (peerId) => {
        attempts.push(peerId);
        connectedPeers.push(peerId);
        return true;
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(connectedPeers).toHaveLength(DEFAULT_PREFERRED_CONNECTION_TARGET);
    expect(attempts).toHaveLength(DEFAULT_PREFERRED_CONNECTION_TARGET);
    expect(coordinator.isActive).toBe(false);
    coordinator.dispose();
  });

  it('uses credible usefulness after discovery without bypassing active-attempt checks', async () => {
    const attempts: string[] = [];
    const estimates = [
      usefulness('busy-peer', 0.9, 0.8),
      usefulness('useful-peer', 0.8, 0.8)
    ];
    const { coordinator } = createCoordinator({
      preferredTarget: 1,
      discoverOnlinePeers: async () => ['busy-peer', 'useful-peer'],
      getPeerUsefulnessEstimates: async () => estimates,
      isAttemptInProgress: (peerId) => peerId === 'busy-peer',
      attemptPeer: async (peerId) => {
        attempts.push(peerId);
        return false;
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(attempts).toEqual(['useful-peer']);
    coordinator.dispose();
  });

  it('falls back to existing candidate order when usefulness estimation fails', async () => {
    const attempts: string[] = [];
    const errors: unknown[] = [];
    const { coordinator } = createCoordinator({
      preferredTarget: 1,
      discoverOnlinePeers: async () => ['first-peer', 'second-peer'],
      getPeerUsefulnessEstimates: async () => { throw new Error('IndexedDB unavailable'); },
      onPeerUsefulnessError: (error) => errors.push(error),
      attemptPeer: async (peerId) => {
        attempts.push(peerId);
        return false;
      }
    });

    coordinator.notifyConnectivityChanged();
    await flushMicrotasks();
    expect(attempts).toEqual(['first-peer', 'second-peer']);
    expect(errors).toHaveLength(1);
    coordinator.dispose();
  });
});

describe('prioritizePeerCandidates', () => {
  it('preserves existing order when evidence is missing, expired, or low-confidence', () => {
    const candidates = ['first-peer', 'second-peer', 'third-peer'];
    expect(prioritizePeerCandidates(candidates, [])).toEqual(candidates);
    expect(prioritizePeerCandidates(candidates, [
      usefulness('first-peer', 0.95, 0.49),
      usefulness('second-peer', 0.8, 0.2)
    ])).toEqual(candidates);
    expect(prioritizePeerCandidates(candidates, [
      usefulness('first-peer', 0.5, 0, 0),
      usefulness('second-peer', 0.5, 0, 0)
    ])).toEqual(candidates);
  });

  it('prefers credible evidence for additional reach over credible redundant evidence', () => {
    const ranked = prioritizePeerCandidates(
      ['redundant-peer', 'additional-reach-peer'],
      [
        usefulness('redundant-peer', 0.58, 0.75, 0.4),
        usefulness('additional-reach-peer', 0.82, 0.75, 2.5)
      ]
    );

    expect(ranked[0]).toBe('additional-reach-peer');
    expect(ranked).toContain('redundant-peer');
  });

  it('gives new and low-confidence peers a rotating exploration opportunity', () => {
    const candidates = ['known-useful-peer', 'new-peer-a', 'new-peer-b'];
    const estimates = [usefulness('known-useful-peer', 0.9, 0.9)];

    expect(prioritizePeerCandidates(candidates, estimates, 0)[0]).toBe('new-peer-a');
    expect(prioritizePeerCandidates(candidates, estimates, 1)[0]).toBe('new-peer-b');
    expect(prioritizePeerCandidates(candidates, estimates, 2)[0]).toBe('new-peer-a');
  });

  it('keeps lower-scored candidates eligible after higher-scored candidates', () => {
    const ordered = prioritizePeerCandidates(
      ['lower-score', 'higher-score'],
      [
        usefulness('lower-score', 0.65, 0.8),
        usefulness('higher-score', 0.85, 0.8)
      ]
    );

    expect(ordered).toEqual(['higher-score', 'lower-score']);
  });

  it('rotates equal-scored credible candidates across rounds and remains deterministic per round', () => {
    const candidates = ['peer-a', 'peer-b', 'peer-c'];
    const estimates = candidates.map((peerId) => usefulness(peerId, 0.8, 0.8));

    expect(prioritizePeerCandidates(candidates, estimates, 0))
      .toEqual(prioritizePeerCandidates(candidates, estimates, 0));
    expect([0, 1, 2].map((round) => prioritizePeerCandidates(candidates, estimates, round)[0]))
      .toEqual(['peer-a', 'peer-b', 'peer-c']);
  });
});

describe('PeerConnectionCapacity', () => {
  it('allows inbound connections above the preferred target but blocks new outbound attempts', () => {
    const established = Array.from(
      { length: DEFAULT_PREFERRED_CONNECTION_TARGET },
      (_, index) => `connected-${index}`
    );
    const capacity = new PeerConnectionCapacity(() => established);

    expect(capacity.reserve('inbound-peer', 'inbound')).toBe(true);
    expect(capacity.getOccupiedCount()).toBe(DEFAULT_PREFERRED_CONNECTION_TARGET + 1);
    expect(capacity.reserve('outbound-peer', 'outbound')).toBe(false);
    expect(established).toHaveLength(DEFAULT_PREFERRED_CONNECTION_TARGET);
  });

  it('counts established and pending inbound/outbound connections against the hard limit', () => {
    const established = Array.from({ length: 19 }, (_, index) => `connected-${index}`);
    const capacity = new PeerConnectionCapacity(() => established, 20, 4, 20);

    expect(capacity.reserve('inbound-peer', 'inbound')).toBe(true);
    expect(capacity.getOccupiedCount()).toBe(20);
    expect(capacity.reserve('outbound-peer', 'outbound')).toBe(false);
    expect(capacity.reserve('inbound-peer', 'outbound')).toBe(true);

    capacity.release('inbound-peer');
    expect(capacity.reserve('outbound-peer', 'outbound')).toBe(true);
    expect(capacity.getOccupiedCount()).toBe(20);
  });

  it('bounds simultaneous attempts without double-counting an established peer', () => {
    const established = ['connected-peer'];
    const capacity = new PeerConnectionCapacity(() => established, 20, 2);

    expect(capacity.reserve('connected-peer', 'inbound')).toBe(true);
    expect(capacity.reserve('attempt-a', 'inbound')).toBe(true);
    expect(capacity.reserve('attempt-b', 'outbound')).toBe(true);
    expect(capacity.reserve('attempt-c', 'inbound')).toBe(false);
    expect(capacity.getOccupiedCount()).toBe(3);

    established.push('attempt-a');
    capacity.release('attempt-a');
    expect(capacity.getOccupiedCount()).toBe(3);
    expect(capacity.reserve('attempt-c', 'outbound')).toBe(true);
  });
});
