import {
  FIND_FORWARDING_OBSERVATION_STORE,
  OBJECT_SUPPLY_OBSERVATION_STORE,
  openDatabase,
  PEER_CONNECTION_OBSERVATION_STORE
} from '../storage/idb';

export const CONNECTION_OBSERVATION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const FIND_OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const OBJECT_SUPPLY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const OBJECT_SUPPLY_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_CONNECTION_PEERS = 500;
export const MAX_FIND_OBSERVATIONS = 2_000;
export const MAX_OBJECT_SUPPLY_OBSERVATIONS = 5_000;
const MAX_CONNECTION_SESSIONS_PER_PEER = 20;
const MAX_RECENT_CONNECTION_FAILURES_PER_PEER = 10;

export function newConnectionAttemptObservationId(): string {
  return `${observationSessionId}:attempt-${++nextAttemptObservationId}`;
}

export type PeerIdentityEvidence =
  | { kind: 'session'; peerId: string }
  | { kind: 'verified'; peerId: string; publicKey: string };

export interface ConnectionSessionObservation {
  id: string;
  opened_at: string;
  closed_at?: string;
  duration_ms?: number;
  identity: PeerIdentityEvidence;
}

export interface PeerConnectionObservation {
  id: string;
  peer_id: string;
  success_count: number;
  most_recent_success?: string;
  recent_failures: Array<{
    id: string;
    occurred_at: string;
    identity: { kind: 'session'; peerId: string };
  }>;
  most_recent_failure?: string;
  most_recent_disconnect?: string;
  sessions: ConnectionSessionObservation[];
  updated_at: string;
  expires_at: string;
}

export interface FindForwardingObservation {
  id: string;
  request_id: string;
  incoming_peer_id: string;
  incoming_peer_identity_kind: 'session';
  child_peer_id: string;
  child_peer_identity_kind: 'session';
  status: 'pending' | 'responded' | 'failed';
  observed_at: string;
  updated_at: string;
  expires_at: string;
}

export interface ObjectSupplyObservation {
  id: string;
  supplier_peer_id: string;
  supplier_identity_kind: 'session';
  object_id: string;
  object_author: string;
  object_author_verified: true;
  validated: true;
  first_observed_at: string;
  last_observed_at: string;
  updated_at: string;
  expires_at: string;
}

export interface LocalObservationExport {
  format: 'mycelium-local-observations';
  version: 1;
  exported_at: string;
  summary: {
    connections: number;
    find_forwarding: number;
    object_supply: number;
  };
  observations: {
    connections: PeerConnectionObservation[];
    find_forwarding: FindForwardingObservation[];
    object_supply: ObjectSupplyObservation[];
  };
}

const observationSessionId = createSessionId();
let nextAttemptObservationId = 0;

export function connectionObservationId(managerConnectionId: string): string {
  return `${observationSessionId}:${validateId(managerConnectionId, 'connection id', 128)}`;
}

export function currentConnectionDurationMs(
  session: ConnectionSessionObservation,
  now = Date.now()
): number {
  const openedAt = Date.parse(session.opened_at);
  if (!Number.isFinite(openedAt)) return 0;
  const end = session.closed_at ? Date.parse(session.closed_at) : now;
  return Math.max(0, (Number.isFinite(end) ? end : now) - openedAt);
}

export async function loadConnectionObservations(now = Date.now()): Promise<PeerConnectionObservation[]> {
  return loadUnexpiredRecords<PeerConnectionObservation>(PEER_CONNECTION_OBSERVATION_STORE, now);
}

export async function loadFindForwardingObservations(now = Date.now()): Promise<FindForwardingObservation[]> {
  return loadUnexpiredRecords<FindForwardingObservation>(FIND_FORWARDING_OBSERVATION_STORE, now);
}

export async function loadObjectSupplyObservations(now = Date.now()): Promise<ObjectSupplyObservation[]> {
  return loadUnexpiredRecords<ObjectSupplyObservation>(OBJECT_SUPPLY_OBSERVATION_STORE, now);
}

export async function exportLocalObservations(now = Date.now()): Promise<LocalObservationExport> {
  const [connections, findForwarding, objectSupply] = await Promise.all([
    loadConnectionObservations(now),
    loadFindForwardingObservations(now),
    loadObjectSupplyObservations(now)
  ]);
  return {
    format: 'mycelium-local-observations',
    version: 1,
    exported_at: new Date(now).toISOString(),
    summary: {
      connections: connections.length,
      find_forwarding: findForwarding.length,
      object_supply: objectSupply.length
    },
    observations: {
      connections,
      find_forwarding: findForwarding,
      object_supply: objectSupply
    }
  };
}

export async function pruneExpiredObservations(now = Date.now()): Promise<void> {
  const db = await openDatabase();
  for (const [storeName, retentionMs, maxRecords] of [
    [PEER_CONNECTION_OBSERVATION_STORE, CONNECTION_OBSERVATION_RETENTION_MS, MAX_CONNECTION_PEERS],
    [FIND_FORWARDING_OBSERVATION_STORE, FIND_OBSERVATION_RETENTION_MS, MAX_FIND_OBSERVATIONS],
    [OBJECT_SUPPLY_OBSERVATION_STORE, OBJECT_SUPPLY_RETENTION_MS, MAX_OBJECT_SUPPLY_OBSERVATIONS]
  ] as const) {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      pruneStore(transaction.objectStore(storeName), now, maxRecords);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Observation pruning transaction aborted'));
    });
  }
}

export async function recordConnectionOpened(
  peerId: string,
  sessionId: string,
  identity: PeerIdentityEvidence,
  now = Date.now()
): Promise<void> {
  validatePeerId(peerId);
  validateId(sessionId, 'session id', 256);
  validatePeerIdentity(peerId, identity);
  const timestamp = new Date(now).toISOString();
  await updateRecord<PeerConnectionObservation>(
    PEER_CONNECTION_OBSERVATION_STORE,
    peerId,
    (previous) => {
      const sessions = previous?.sessions ?? [];
      if (sessions.some((session) => session.id === sessionId)) return previous!;
      const mostRecentSuccess = laterTimestamp(previous?.most_recent_success, timestamp);
      const updatedAt = laterTimestamp(previous?.updated_at, timestamp);
      return {
        id: peerId,
        peer_id: peerId,
        success_count: (previous?.success_count ?? 0) + 1,
        most_recent_success: mostRecentSuccess,
        recent_failures: previous?.recent_failures ?? [],
        most_recent_failure: previous?.most_recent_failure,
        most_recent_disconnect: previous?.most_recent_disconnect,
        sessions: [...sessions, {
          id: sessionId,
          opened_at: timestamp,
          identity
        }].slice(-MAX_CONNECTION_SESSIONS_PER_PEER),
        updated_at: updatedAt,
        expires_at: new Date(Date.parse(updatedAt) + CONNECTION_OBSERVATION_RETENTION_MS).toISOString()
      };
    },
    now,
    MAX_CONNECTION_PEERS
  );
}

export async function recordConnectionFailure(
  peerId: string,
  failureId: string,
  now = Date.now()
): Promise<void> {
  validatePeerId(peerId);
  validateId(failureId, 'connection failure id', 256);
  const timestamp = new Date(now).toISOString();
  await updateRecord<PeerConnectionObservation>(
    PEER_CONNECTION_OBSERVATION_STORE,
    peerId,
    (previous) => {
      const failures = previous?.recent_failures ?? [];
      if (failures.some((failure) => failure.id === failureId)) return previous!;
      const updatedAt = laterTimestamp(previous?.updated_at, timestamp);
      return {
        id: peerId,
        peer_id: peerId,
        success_count: previous?.success_count ?? 0,
        most_recent_success: previous?.most_recent_success,
        recent_failures: [...failures, {
          id: failureId,
          occurred_at: timestamp,
          identity: { kind: 'session' as const, peerId }
        }]
          .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at))
          .slice(-MAX_RECENT_CONNECTION_FAILURES_PER_PEER),
        most_recent_failure: laterTimestamp(previous?.most_recent_failure, timestamp),
        most_recent_disconnect: previous?.most_recent_disconnect,
        sessions: previous?.sessions ?? [],
        updated_at: updatedAt,
        expires_at: new Date(Date.parse(updatedAt) + CONNECTION_OBSERVATION_RETENTION_MS).toISOString()
      };
    },
    now,
    MAX_CONNECTION_PEERS
  );
}

export async function recordConnectionClosed(
  peerId: string,
  sessionId: string,
  now = Date.now()
): Promise<void> {
  validatePeerId(peerId);
  validateId(sessionId, 'session id', 256);
  const timestamp = new Date(now).toISOString();
  await updateRecord<PeerConnectionObservation>(
    PEER_CONNECTION_OBSERVATION_STORE,
    peerId,
    (previous) => {
      if (!previous) return previous;
      const sessionIndex = previous.sessions.findIndex((session) => session.id === sessionId);
      if (sessionIndex < 0 || previous.sessions[sessionIndex].closed_at) return previous;
      const session = previous.sessions[sessionIndex];
      const sessions = [...previous.sessions];
      sessions[sessionIndex] = {
        ...session,
        closed_at: timestamp,
        duration_ms: currentConnectionDurationMs(session, now)
      };
      const mostRecentDisconnect = laterTimestamp(previous.most_recent_disconnect, timestamp);
      const updatedAt = laterTimestamp(previous.updated_at, timestamp);
      return {
        ...previous,
        most_recent_disconnect: mostRecentDisconnect,
        sessions,
        updated_at: updatedAt,
        expires_at: new Date(Date.parse(updatedAt) + CONNECTION_OBSERVATION_RETENTION_MS).toISOString()
      };
    },
    now,
    MAX_CONNECTION_PEERS
  );
}

export async function recordFindForwarding(
  requestId: string,
  incomingPeerId: string,
  childPeerId: string,
  status: FindForwardingObservation['status'] = 'pending',
  now = Date.now()
): Promise<void> {
  validateId(requestId, 'FIND request id', 128);
  validatePeerId(incomingPeerId);
  validatePeerId(childPeerId);
  if (incomingPeerId === childPeerId) throw new Error('FIND forwarding peers must be distinct');
  if (!['pending', 'responded', 'failed'].includes(status)) throw new Error('Invalid FIND observation status');
  const id = `${encodeURIComponent(requestId)}|${encodeURIComponent(incomingPeerId)}|${encodeURIComponent(childPeerId)}`;
  const timestamp = new Date(now).toISOString();
  await updateRecord<FindForwardingObservation>(
    FIND_FORWARDING_OBSERVATION_STORE,
    id,
    (previous) => previous
      ? {
          ...previous,
          status: previous.status === 'responded'
            ? 'responded'
            : status === 'pending' && previous.status !== 'pending'
              ? previous.status
              : status,
          updated_at: timestamp,
          expires_at: new Date(now + FIND_OBSERVATION_RETENTION_MS).toISOString()
        }
      : {
          id,
          request_id: requestId,
          incoming_peer_id: incomingPeerId,
          incoming_peer_identity_kind: 'session',
          child_peer_id: childPeerId,
          child_peer_identity_kind: 'session',
          status,
          observed_at: timestamp,
          updated_at: timestamp,
          expires_at: new Date(now + FIND_OBSERVATION_RETENTION_MS).toISOString()
        },
    now,
    MAX_FIND_OBSERVATIONS
  );
}

export async function recordValidatedObjectSupply(
  supplierPeerId: string,
  objectId: string,
  objectAuthor: string,
  now = Date.now()
): Promise<void> {
  validatePeerId(supplierPeerId);
  validateId(objectId, 'object id', 256);
  validateId(objectAuthor, 'object author', 512);
  const id = `${encodeURIComponent(supplierPeerId)}|${encodeURIComponent(objectId)}`;
  const timestamp = new Date(now).toISOString();
  await updateRecord<ObjectSupplyObservation>(
    OBJECT_SUPPLY_OBSERVATION_STORE,
    id,
    (previous) => {
      if (previous && now - Date.parse(previous.last_observed_at) < OBJECT_SUPPLY_DEDUPE_MS) {
        return previous;
      }
      return {
        id,
        supplier_peer_id: supplierPeerId,
        supplier_identity_kind: 'session',
        object_id: objectId,
        object_author: objectAuthor,
        object_author_verified: true,
        validated: true,
        first_observed_at: previous?.first_observed_at ?? timestamp,
        last_observed_at: timestamp,
        updated_at: timestamp,
        expires_at: new Date(now + OBJECT_SUPPLY_RETENTION_MS).toISOString()
      };
    },
    now,
    MAX_OBJECT_SUPPLY_OBSERVATIONS
  );
}

async function updateRecord<T extends { id: string; updated_at: string; expires_at: string }>(
  storeName: string,
  id: string,
  update: (previous: T | undefined) => T | undefined,
  now: number,
  maxRecords: number
): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.get(id);
    request.onsuccess = () => {
      const previous = request.result as T | undefined;
      const isExpired = previous && Date.parse(previous.expires_at) <= now;
      if (isExpired) store.delete(id);
      const next = update(isExpired ? undefined : previous);
      if (next) store.put(next);
      pruneStore(store, now, maxRecords);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Observation transaction aborted'));
  });
}

async function loadUnexpiredRecords<T extends { expires_at: string }>(storeName: string, now: number): Promise<T[]> {
  const db = await openDatabase();
  return new Promise<T[]>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => {
      const nowIso = new Date(now).toISOString();
      resolve((request.result as T[]).filter((record) => record.expires_at > nowIso));
    };
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function pruneStore(store: IDBObjectStore, expiredBefore: number, maxRecords: number): void {
  const index = store.index('expires_at');
  const expiredCursor = index.openCursor(IDBKeyRange.upperBound(new Date(expiredBefore).toISOString()));
  expiredCursor.onsuccess = () => {
    const cursor = expiredCursor.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
      return;
    }

    const countRequest = store.count();
    countRequest.onsuccess = () => {
      const excess = countRequest.result - maxRecords;
      if (excess <= 0) return;
      let removed = 0;
      const oldestCursor = index.openCursor();
      oldestCursor.onsuccess = () => {
        const oldest = oldestCursor.result;
        if (!oldest || removed >= excess) return;
        oldest.delete();
        removed += 1;
        oldest.continue();
      };
    };
  };
}

function validatePeerIdentity(peerId: string, identity: PeerIdentityEvidence): void {
  if (!identity || identity.peerId !== peerId) throw new Error('Peer identity must match the observed peer');
  if (identity.kind === 'session') return;
  if (identity.kind !== 'verified' || !identity.publicKey.trim()) throw new Error('Invalid verified peer identity');
}

function laterTimestamp(previous: string | undefined, current: string): string {
  return previous && previous > current ? previous : current;
}

function validatePeerId(peerId: string): void {
  validateId(peerId, 'peer id', 256);
}

function validateId(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
