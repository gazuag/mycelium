import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONNECTION_OBSERVATION_RETENTION_MS,
  MAX_CONNECTION_PEERS,
  MAX_FIND_OBSERVATIONS,
  MAX_OBJECT_SUPPLY_OBSERVATIONS,
  OBJECT_SUPPLY_DEDUPE_MS,
  connectionObservationId,
  currentConnectionDurationMs,
  loadConnectionObservations,
  loadFindForwardingObservations,
  loadObjectSupplyObservations,
  pruneExpiredObservations,
  recordConnectionClosed,
  recordConnectionFailure,
  recordConnectionOpened,
  recordFindForwarding,
  recordValidatedObjectSupply,
  type PeerIdentityEvidence
} from './local-observations';
import { openDatabase } from '../storage/idb';

const SESSION_PEER = 'aa:bb:cc:dd:ee:ff:00:11';
const VERIFIED_PEER = '11:22:33:44:55:66:77:88';
const sessionIdentity: PeerIdentityEvidence = { kind: 'session', peerId: SESSION_PEER };

beforeEach(async () => {
  const db = await openDatabase();
  const storeNames = [
    'peer_connection_observations',
    'find_forwarding_observations',
    'object_supply_observations'
  ];
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeNames, 'readwrite');
    storeNames.forEach((storeName) => transaction.objectStore(storeName).clear());
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
});

describe('local topology observations', () => {
  it('records one successful connection and ignores duplicate open callbacks', async () => {
    const openedAt = Date.parse('2026-10-27T12:00:00.000Z');
    const sessionId = connectionObservationId('connection-1');
    await recordConnectionOpened(SESSION_PEER, sessionId, sessionIdentity, openedAt);
    await recordConnectionOpened(SESSION_PEER, sessionId, sessionIdentity, openedAt + 500);

    const [observation] = await loadConnectionObservations();
    expect(observation.success_count).toBe(1);
    expect(observation.sessions).toHaveLength(1);
    expect(observation.sessions[0]).toMatchObject({
      id: sessionId,
      opened_at: new Date(openedAt).toISOString(),
      identity: { kind: 'session', peerId: SESSION_PEER }
    });
  });

  it('records connection duration on close and derives duration while still open', async () => {
    const openedAt = Date.parse('2026-10-27T12:00:00.000Z');
    const sessionId = connectionObservationId('connection-2');
    await recordConnectionOpened(SESSION_PEER, sessionId, sessionIdentity, openedAt);
    const [openObservation] = await loadConnectionObservations();
    expect(currentConnectionDurationMs(openObservation.sessions[0], openedAt + 15_000)).toBe(15_000);
    expect(openObservation.sessions[0].closed_at).toBeUndefined();

    await recordConnectionClosed(SESSION_PEER, sessionId, openedAt + 15_000);
    await recordConnectionClosed(SESSION_PEER, sessionId, openedAt + 20_000);
    const [closedObservation] = await loadConnectionObservations();
    expect(closedObservation.most_recent_disconnect).toBe(new Date(openedAt + 15_000).toISOString());
    expect(closedObservation.sessions[0].duration_ms).toBe(15_000);
  });

  it('persists connection history with explicit verified and session-only identity evidence', async () => {
    const verified: PeerIdentityEvidence = {
      kind: 'verified',
      peerId: VERIFIED_PEER,
      publicKey: 'public-key-bound-by-signed-identity-object'
    };
    await recordConnectionOpened(SESSION_PEER, connectionObservationId('connection-3'), sessionIdentity);
    await recordConnectionOpened(VERIFIED_PEER, connectionObservationId('connection-4'), verified);

    const loaded = await loadConnectionObservations();
    expect(loaded.find((item) => item.peer_id === SESSION_PEER)?.sessions[0].identity.kind).toBe('session');
    expect(loaded.find((item) => item.peer_id === VERIFIED_PEER)?.sessions[0].identity).toEqual(verified);
  });

  it('deduplicates reliable failed attempts and bounds recent failure history', async () => {
    const now = Date.now();
    await recordConnectionFailure(SESSION_PEER, 'attempt-1', now);
    await recordConnectionFailure(SESSION_PEER, 'attempt-1', now + 1);
    for (let index = 2; index <= 12; index += 1) {
      await recordConnectionFailure(SESSION_PEER, `attempt-${index}`, now + index);
    }

    const [observation] = await loadConnectionObservations();
    expect(observation.success_count).toBe(0);
    expect(observation.recent_failures).toHaveLength(10);
    expect(observation.recent_failures[0].id).toBe('attempt-3');
    expect(observation.most_recent_failure).toBe(new Date(now + 12).toISOString());
  });

  it('records forwarding parent and child separately and deduplicates a retried request', async () => {
    const now = Date.now();
    await recordFindForwarding('request-1', 'parent-peer', 'child-peer', 'pending', now);
    await recordFindForwarding('request-1', 'parent-peer', 'child-peer', 'responded', now + 1000);
    await recordFindForwarding('request-1', 'parent-peer', 'child-peer', 'pending', now + 2000);

    await expect(loadFindForwardingObservations()).resolves.toEqual([expect.objectContaining({
      request_id: 'request-1',
      incoming_peer_id: 'parent-peer',
      incoming_peer_identity_kind: 'session',
      child_peer_id: 'child-peer',
      child_peer_identity_kind: 'session',
      status: 'responded',
      observed_at: new Date(now).toISOString()
    })]);
  });

  it('stores supplier and object author as distinct transfer fields', async () => {
    await recordValidatedObjectSupply('supplier-peer', 'object-1', 'author-key', Date.now());

    await expect(loadObjectSupplyObservations()).resolves.toEqual([expect.objectContaining({
      supplier_peer_id: 'supplier-peer',
      supplier_identity_kind: 'session',
      object_id: 'object-1',
      object_author: 'author-key',
      object_author_verified: true,
      validated: true
    })]);
  });

  it('deduplicates repeated delivery of the same object but records distinct objects', async () => {
    const now = Date.now();
    await recordValidatedObjectSupply('supplier-peer', 'object-1', 'author-key', now);
    await recordValidatedObjectSupply('supplier-peer', 'object-1', 'author-key', now + 1000);
    await recordValidatedObjectSupply('supplier-peer', 'object-2', 'author-key', now + 1000);

    const observations = await loadObjectSupplyObservations();
    expect(observations).toHaveLength(2);
    expect(observations.find((item) => item.object_id === 'object-1')?.last_observed_at)
      .toBe(new Date(now).toISOString());
    expect(observations.some((item) => item.object_id === 'object-2')).toBe(true);
    expect(OBJECT_SUPPLY_DEDUPE_MS).toBeGreaterThan(0);
  });

  it('expires observations and prunes them from storage', async () => {
    const oldTime = Date.parse('2025-01-01T00:00:00.000Z');
    await recordConnectionOpened(SESSION_PEER, connectionObservationId('connection-old'), sessionIdentity, oldTime);
    const expiredAt = oldTime + CONNECTION_OBSERVATION_RETENTION_MS + 1;

    await expect(loadConnectionObservations(expiredAt)).resolves.toHaveLength(0);
    await pruneExpiredObservations(expiredAt);
    const db = await openDatabase();
    const stored = await new Promise<number>((resolve, reject) => {
      const request = db.transaction('peer_connection_observations', 'readonly')
        .objectStore('peer_connection_observations')
        .count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(stored).toBe(0);
    db.close();
  });

  it('enforces a hard cap on persisted connection peers', async () => {
    const now = Date.now();
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('peer_connection_observations', 'readwrite');
      const store = transaction.objectStore('peer_connection_observations');
      for (let index = 0; index < MAX_CONNECTION_PEERS + 3; index += 1) {
        const updatedAt = new Date(now + index).toISOString();
        store.put({
          id: `peer-${index}`,
          peer_id: `peer-${index}`,
          success_count: 1,
          most_recent_success: updatedAt,
          recent_failures: [],
          sessions: [],
          updated_at: updatedAt,
          expires_at: new Date(now + CONNECTION_OBSERVATION_RETENTION_MS).toISOString()
        });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();

    await pruneExpiredObservations(now);
    const [count] = await Promise.all([loadConnectionObservations(now).then((observations) => observations.length)]);
    expect(count).toBe(MAX_CONNECTION_PEERS);
  });

  it('enforces hard caps on FIND and object-supply observations', async () => {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(now + CONNECTION_OBSERVATION_RETENTION_MS).toISOString();
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([
        'find_forwarding_observations',
        'object_supply_observations'
      ], 'readwrite');
      const forwarding = transaction.objectStore('find_forwarding_observations');
      const supplies = transaction.objectStore('object_supply_observations');
      for (let index = 0; index < MAX_FIND_OBSERVATIONS + 3; index += 1) {
        forwarding.put({
          id: `find-${index}`,
          request_id: `request-${index}`,
          incoming_peer_id: 'incoming',
          incoming_peer_identity_kind: 'session',
          child_peer_id: 'child',
          child_peer_identity_kind: 'session',
          status: 'pending',
          observed_at: timestamp,
          updated_at: timestamp,
          expires_at: expiresAt
        });
      }
      for (let index = 0; index < MAX_OBJECT_SUPPLY_OBSERVATIONS + 3; index += 1) {
        supplies.put({
          id: `supply-${index}`,
          supplier_peer_id: 'supplier',
          supplier_identity_kind: 'session',
          object_id: `object-${index}`,
          object_author: 'author',
          object_author_verified: true,
          validated: true,
          first_observed_at: timestamp,
          last_observed_at: timestamp,
          updated_at: timestamp,
          expires_at: expiresAt
        });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();

    await pruneExpiredObservations(now);
    await expect(loadFindForwardingObservations(now)).resolves.toHaveLength(MAX_FIND_OBSERVATIONS);
    await expect(loadObjectSupplyObservations(now)).resolves.toHaveLength(MAX_OBJECT_SUPPLY_OBSERVATIONS);
  });

  it('rejects identity claims that do not match the observed session peer', async () => {
    await expect(recordConnectionOpened(
      SESSION_PEER,
      connectionObservationId('connection-invalid'),
      { kind: 'verified', peerId: VERIFIED_PEER, publicKey: 'key' }
    )).rejects.toThrow('must match');
  });
});
