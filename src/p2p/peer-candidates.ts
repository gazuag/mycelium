import { openDatabase, PEER_CANDIDATE_STORE } from '../storage/idb';

export const PEER_CANDIDATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PEER_CANDIDATES = 500;
export const MAX_PEER_CANDIDATES_PER_SOURCE = 50;
export const MAX_PEER_CANDIDATE_SOURCES = 50;
export const PEER_CANDIDATE_OBSERVATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_PEER_CANDIDATE_OBSERVATION_COUNT = 1_000;

const PEER_FINGERPRINT_PATTERN = /^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$/i;

export interface PeerCandidateSource {
  peerId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCountedAt: string;
}

export interface PeerCandidate {
  peerId: string;
  sourcePeerId: string;
  sourceType: 'directly-connected';
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  lastSourcePeerId: string;
  sources: PeerCandidateSource[];
}

export function normalizePeerFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return PEER_FINGERPRINT_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

export async function addPeerCandidates(
  candidatePeerIds: readonly unknown[],
  sourcePeerId: unknown,
  localPeerId?: unknown,
  now = Date.now()
): Promise<void> {
  const sourceId = normalizePeerFingerprint(sourcePeerId);
  if (!sourceId) throw new Error('Invalid peer-candidate source fingerprint');
  const localId = localPeerId === undefined ? null : normalizePeerFingerprint(localPeerId);
  if (localPeerId !== undefined && !localId) throw new Error('Invalid local peer fingerprint');
  if (!Array.isArray(candidatePeerIds)) throw new Error('Peer candidates must be an array');
  if (!isValidNow(now)) throw new Error('Invalid peer-candidate timestamp');

  const candidateIds = [...new Set(candidatePeerIds
    .map(normalizePeerFingerprint)
    .filter((peerId): peerId is string => peerId !== null && peerId !== sourceId && peerId !== localId))];

  await updateCandidateStore(now, (candidates) => {
    const sourceCounts = countActiveSourceCandidates(candidates, now);
    const timestamp = new Date(now).toISOString();
    const retentionCutoff = now - PEER_CANDIDATE_RETENTION_MS;

    for (const peerId of candidateIds) {
      const previous = candidates.get(peerId);
      const sourceObservations = previous?.sources ?? [];
      let sourceObservation = sourceObservations.find((source) => source.peerId === sourceId);
      if (!sourceObservation && (sourceCounts.get(sourceId) ?? 0) >= MAX_PEER_CANDIDATES_PER_SOURCE) {
        continue;
      }

      const sources = [...sourceObservations];
      let observationCount = previous?.observationCount ?? 0;
      if (sourceObservation) {
        const index = sources.indexOf(sourceObservation);
        const shouldCount = now - Date.parse(sourceObservation.lastCountedAt)
          >= PEER_CANDIDATE_OBSERVATION_INTERVAL_MS;
        sourceObservation = {
          ...sourceObservation,
          lastSeenAt: timestamp,
          lastCountedAt: shouldCount ? timestamp : sourceObservation.lastCountedAt
        };
        sources[index] = sourceObservation;
        if (shouldCount) observationCount = Math.min(observationCount + 1, MAX_PEER_CANDIDATE_OBSERVATION_COUNT);
      } else {
        sourceObservation = {
          peerId: sourceId,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastCountedAt: timestamp
        };
        sources.push(sourceObservation);
        sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1);
        observationCount = Math.min(observationCount + 1, MAX_PEER_CANDIDATE_OBSERVATION_COUNT);
      }

      while (sources.length > MAX_PEER_CANDIDATE_SOURCES) {
        const oldestIndex = sources.reduce((oldest, source, index, list) => (
          Date.parse(source.lastSeenAt) < Date.parse(list[oldest].lastSeenAt) ? index : oldest
        ), 0);
        const [removed] = sources.splice(oldestIndex, 1);
        if (Date.parse(removed.lastSeenAt) > retentionCutoff) {
          sourceCounts.set(removed.peerId, Math.max(0, (sourceCounts.get(removed.peerId) ?? 1) - 1));
        }
      }

      candidates.set(peerId, {
        peerId,
        sourcePeerId: previous?.sourcePeerId ?? sourceId,
        sourceType: 'directly-connected',
        firstSeenAt: previous?.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp,
        observationCount,
        lastSourcePeerId: sourceId,
        sources
      });
    }
  });
}

export async function listPeerCandidates(now = Date.now()): Promise<PeerCandidate[]> {
  if (!isValidNow(now)) throw new Error('Invalid peer-candidate timestamp');
  let candidates: PeerCandidate[] = [];
  await updateCandidateStore(now, (candidateMap) => {
    candidates = [...candidateMap.values()].sort((left, right) => (
      right.lastSeenAt.localeCompare(left.lastSeenAt) || left.peerId.localeCompare(right.peerId)
    ));
  });
  return candidates;
}

export async function removePeerCandidate(peerId: unknown, now = Date.now()): Promise<void> {
  const normalizedPeerId = normalizePeerFingerprint(peerId);
  if (!normalizedPeerId) throw new Error('Invalid peer-candidate fingerprint');
  if (!isValidNow(now)) throw new Error('Invalid peer-candidate timestamp');
  await updateCandidateStore(now, (candidates, store) => {
    candidates.delete(normalizedPeerId);
    store.delete(normalizedPeerId);
  });
}

export function createPeerCandidateIntake(
  localPeerId: string,
  onStorageError: (sourcePeerId: string, error: unknown) => void
): (sourcePeerId: string, candidatePeerIds: readonly string[]) => void {
  return (sourcePeerId, candidatePeerIds) => {
    void addPeerCandidates(candidatePeerIds, sourcePeerId, localPeerId)
      .catch((error: unknown) => onStorageError(sourcePeerId, error));
  };
}

async function updateCandidateStore(
  now: number,
  update: (candidates: Map<string, PeerCandidate>, store: IDBObjectStore) => void
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PEER_CANDIDATE_STORE, 'readwrite');
    const store = transaction.objectStore(PEER_CANDIDATE_STORE);
    const recordsRequest = store.getAll();
    const keysRequest = store.getAllKeys();
    let records: unknown[] | undefined;
    let keys: IDBValidKey[] | undefined;
    let processed = false;

    const processRecords = () => {
      if (processed || !records || !keys) return;
      processed = true;
      try {
        const candidates = new Map<string, PeerCandidate>();
        const cutoff = now - PEER_CANDIDATE_RETENTION_MS;
        records.forEach((record, index) => {
          const candidate = parsePeerCandidate(record);
          if (!candidate || Date.parse(candidate.lastSeenAt) <= cutoff) {
            store.delete(keys![index]);
            return;
          }
          const activeSources = candidate.sources.filter((source) => Date.parse(source.lastSeenAt) > cutoff);
          if (activeSources.length !== candidate.sources.length) {
            candidate.sources = activeSources;
            store.put(candidate);
          }
          candidates.set(candidate.peerId, candidate);
        });

        update(candidates, store);
        const excess = candidates.size - MAX_PEER_CANDIDATES;
        if (excess > 0) {
          const oldest = [...candidates.values()]
            .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt) || left.peerId.localeCompare(right.peerId))
            .slice(0, excess);
          oldest.forEach((candidate) => {
            candidates.delete(candidate.peerId);
            store.delete(candidate.peerId);
          });
        }

        for (const candidate of candidates.values()) store.put(candidate);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
        reject(error);
      }
    };

    recordsRequest.onsuccess = () => {
      records = recordsRequest.result;
      processRecords();
    };
    keysRequest.onsuccess = () => {
      keys = keysRequest.result;
      processRecords();
    };
    recordsRequest.onerror = () => reject(recordsRequest.error);
    keysRequest.onerror = () => reject(keysRequest.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Peer-candidate transaction aborted'));
  });
}

function parsePeerCandidate(value: unknown): PeerCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PeerCandidate>;
  const peerId = normalizePeerFingerprint(candidate.peerId);
  const sourcePeerId = normalizePeerFingerprint(candidate.sourcePeerId);
  const lastSourcePeerId = normalizePeerFingerprint(candidate.lastSourcePeerId);
  if (!peerId || !sourcePeerId || !lastSourcePeerId
    || candidate.sourceType !== 'directly-connected'
    || !isTimestamp(candidate.firstSeenAt)
    || !isTimestamp(candidate.lastSeenAt)
    || Date.parse(candidate.firstSeenAt) > Date.parse(candidate.lastSeenAt)
    || !Number.isSafeInteger(candidate.observationCount)
    || candidate.observationCount! < 1
    || candidate.observationCount! > MAX_PEER_CANDIDATE_OBSERVATION_COUNT
    || !Array.isArray(candidate.sources)
    || candidate.sources.length > MAX_PEER_CANDIDATE_SOURCES) return null;

  const sources: PeerCandidateSource[] = [];
  const seenSourceIds = new Set<string>();
  for (const source of candidate.sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const sourceRecord = source as Partial<PeerCandidateSource>;
    const sourceId = normalizePeerFingerprint(sourceRecord.peerId);
    if (!sourceId || seenSourceIds.has(sourceId)
      || !isTimestamp(sourceRecord.firstSeenAt)
      || !isTimestamp(sourceRecord.lastSeenAt)
      || !isTimestamp(sourceRecord.lastCountedAt)
      || Date.parse(sourceRecord.firstSeenAt) > Date.parse(sourceRecord.lastSeenAt)
      || Date.parse(sourceRecord.lastCountedAt) > Date.parse(sourceRecord.lastSeenAt)
      || Date.parse(sourceRecord.lastSeenAt) > Date.parse(candidate.lastSeenAt)
      || Date.parse(sourceRecord.firstSeenAt) < Date.parse(candidate.firstSeenAt)) return null;
    seenSourceIds.add(sourceId);
    sources.push({
      peerId: sourceId,
      firstSeenAt: sourceRecord.firstSeenAt!,
      lastSeenAt: sourceRecord.lastSeenAt!,
      lastCountedAt: sourceRecord.lastCountedAt!
    });
  }
  if (sources.length === 0 || !seenSourceIds.has(lastSourcePeerId)) return null;
  return {
    peerId,
    sourcePeerId,
    sourceType: 'directly-connected',
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    observationCount: candidate.observationCount!,
    lastSourcePeerId,
    sources
  };
}

function countActiveSourceCandidates(
  candidates: ReadonlyMap<string, PeerCandidate>,
  now: number
): Map<string, number> {
  const cutoff = now - PEER_CANDIDATE_RETENTION_MS;
  const counts = new Map<string, number>();
  for (const candidate of candidates.values()) {
    for (const source of candidate.sources) {
      if (Date.parse(source.lastSeenAt) > cutoff) {
        counts.set(source.peerId, (counts.get(source.peerId) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isValidNow(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}
