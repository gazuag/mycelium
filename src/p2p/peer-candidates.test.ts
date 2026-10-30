import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, PEER_CANDIDATE_STORE } from '../storage/idb';
import {
  addPeerCandidates,
  createPeerCandidateIntake,
  listPeerCandidates,
  MAX_PEER_CANDIDATES,
  MAX_PEER_CANDIDATES_PER_SOURCE,
  MAX_PEER_CANDIDATE_SOURCES,
  PEER_CANDIDATE_OBSERVATION_INTERVAL_MS,
  PEER_CANDIDATE_RETENTION_MS,
  removePeerCandidate
} from './peer-candidates';

const LOCAL_PEER = peerId(1);
const SOURCE_A = peerId(2);
const SOURCE_B = peerId(3);

function peerId(value: number): string {
  const hex = BigInt(value).toString(16).padStart(16, '0');
  return hex.match(/.{2}/g)!.join(':');
}

async function clearCandidateStore(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PEER_CANDIDATE_STORE, 'readwrite');
    transaction.objectStore(PEER_CANDIDATE_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Candidate test cleanup aborted'));
  });
  database.close();
}

beforeEach(clearCandidateStore);

describe('persistent peer candidates', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');

  it('stores a valid candidate with a local timestamp and direct-source provenance', async () => {
    const candidateId = peerId(10);
    await addPeerCandidates([candidateId], SOURCE_A, LOCAL_PEER, now);

    await expect(listPeerCandidates(now)).resolves.toEqual([{
      peerId: candidateId,
      sourcePeerId: SOURCE_A,
      sourceType: 'directly-connected',
      firstSeenAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      observationCount: 1,
      lastSourcePeerId: SOURCE_A,
      sources: [{
        peerId: SOURCE_A,
        firstSeenAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        lastCountedAt: new Date(now).toISOString()
      }]
    }]);
  });

  it('rejects malformed candidate fingerprints and filters the local and source peers', async () => {
    await addPeerCandidates(['not-a-fingerprint', peerId(11), LOCAL_PEER, SOURCE_A], SOURCE_A, LOCAL_PEER, now);

    await expect(listPeerCandidates(now)).resolves.toMatchObject([{ peerId: peerId(11) }]);
    await expect(addPeerCandidates([peerId(11)], 'bad-source', LOCAL_PEER, now)).rejects.toThrow('source fingerprint');
  });

  it('deduplicates repeats, refreshes last-seen time, and preserves first-seen time', async () => {
    const candidateId = peerId(12);
    const firstTime = now;
    const repeatedTime = now + 60_000;
    await addPeerCandidates([candidateId, candidateId], SOURCE_A, LOCAL_PEER, firstTime);
    await addPeerCandidates([candidateId], SOURCE_A, LOCAL_PEER, repeatedTime);

    const [candidate] = await listPeerCandidates(repeatedTime);
    expect(candidate.firstSeenAt).toBe(new Date(firstTime).toISOString());
    expect(candidate.lastSeenAt).toBe(new Date(repeatedTime).toISOString());
    expect(candidate.observationCount).toBe(1);
    expect(await listPeerCandidates(repeatedTime)).toHaveLength(1);
  });

  it('tracks independent sources and rate-limits each source observation count', async () => {
    const candidateId = peerId(13);
    await addPeerCandidates([candidateId], SOURCE_A, LOCAL_PEER, now);
    await addPeerCandidates([candidateId], SOURCE_A, LOCAL_PEER, now + 60_000);
    await addPeerCandidates([candidateId], SOURCE_B, LOCAL_PEER, now + 60_000);
    await addPeerCandidates(
      [candidateId],
      SOURCE_A,
      LOCAL_PEER,
      now + PEER_CANDIDATE_OBSERVATION_INTERVAL_MS + 1
    );

    const [candidate] = await listPeerCandidates(now + PEER_CANDIDATE_OBSERVATION_INTERVAL_MS + 1);
    expect(candidate.observationCount).toBe(3);
    expect(candidate.sourcePeerId).toBe(SOURCE_A);
    expect(candidate.lastSourcePeerId).toBe(SOURCE_A);
    expect(candidate.sources.map(({ peerId: sourceId }) => sourceId).sort()).toEqual([SOURCE_A, SOURCE_B].sort());
  });

  it('bounds the number of source records retained for one candidate', async () => {
    const candidateId = peerId(14);
    for (let source = 100; source < 100 + MAX_PEER_CANDIDATE_SOURCES + 1; source += 1) {
      await addPeerCandidates([candidateId], peerId(source), LOCAL_PEER, now + source);
    }

    const [candidate] = await listPeerCandidates(now + 100 + MAX_PEER_CANDIDATE_SOURCES);
    expect(candidate.sources).toHaveLength(MAX_PEER_CANDIDATE_SOURCES);
    expect(candidate.sources.some(({ peerId: sourceId }) => sourceId === peerId(100))).toBe(false);
    expect(candidate.lastSourcePeerId).toBe(peerId(100 + MAX_PEER_CANDIDATE_SOURCES));
  });

  it('limits each source to 50 distinct active candidates', async () => {
    const candidates = Array.from({ length: MAX_PEER_CANDIDATES_PER_SOURCE + 1 }, (_, index) => peerId(1_000 + index));
    await addPeerCandidates(candidates, SOURCE_A, LOCAL_PEER, now);

    const stored = await listPeerCandidates(now);
    expect(stored).toHaveLength(MAX_PEER_CANDIDATES_PER_SOURCE);
    expect(stored.some(({ peerId: candidateId }) => candidateId === candidates[MAX_PEER_CANDIDATES_PER_SOURCE])).toBe(false);
  });

  it('expires candidates seven days after their last report and deletes expired records', async () => {
    await addPeerCandidates([peerId(15)], SOURCE_A, LOCAL_PEER, now);
    const afterExpiry = now + PEER_CANDIDATE_RETENTION_MS + 1;

    await expect(listPeerCandidates(afterExpiry)).resolves.toEqual([]);
    const database = await openDatabase();
    const remaining = await new Promise<number>((resolve, reject) => {
      const request = database.transaction(PEER_CANDIDATE_STORE, 'readonly')
        .objectStore(PEER_CANDIDATE_STORE)
        .count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(remaining).toBe(0);
    database.close();
  });

  it('caps the store at 500 candidates and evicts the oldest first', async () => {
    let value = 2_000;
    for (let sourceIndex = 0; sourceIndex < 10; sourceIndex += 1) {
      const candidates = Array.from({ length: 50 }, () => peerId(value++));
      await addPeerCandidates(candidates, peerId(3_000 + sourceIndex), LOCAL_PEER, now + sourceIndex * 1_000);
    }
    const finalCandidates = [peerId(value++), peerId(value++), peerId(value++)];
    await addPeerCandidates(finalCandidates, peerId(4_000), LOCAL_PEER, now + 20_000);

    const stored = await listPeerCandidates(now + 20_000);
    expect(stored).toHaveLength(MAX_PEER_CANDIDATES);
    expect(stored.some(({ peerId: candidateId }) => candidateId === peerId(2_000))).toBe(false);
    expect(stored.map(({ peerId: candidateId }) => candidateId)).toEqual(expect.arrayContaining(finalCandidates));
  });

  it('removes a candidate and discards malformed records during normal listing', async () => {
    const candidateId = peerId(16);
    await addPeerCandidates([candidateId], SOURCE_A, LOCAL_PEER, now);
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PEER_CANDIDATE_STORE, 'readwrite');
      transaction.objectStore(PEER_CANDIDATE_STORE).put({ peerId: peerId(17), lastSeenAt: 'invalid' });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(listPeerCandidates(now)).resolves.toMatchObject([{ peerId: candidateId }]);
    await removePeerCandidate(candidateId, now);
    await expect(listPeerCandidates(now)).resolves.toEqual([]);
    await expect(removePeerCandidate('invalid')).rejects.toThrow('fingerprint');
  });

  it('reports storage failure asynchronously without throwing from gossip intake', async () => {
    const failure = new Error('IndexedDB unavailable');
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw failure;
    });
    const onStorageError = vi.fn();
    const intake = createPeerCandidateIntake(LOCAL_PEER, onStorageError);

    expect(() => intake(SOURCE_A, [peerId(18)])).not.toThrow();
    await vi.waitFor(() => expect(onStorageError).toHaveBeenCalledWith(SOURCE_A, failure));
    openSpy.mockRestore();
  });
});
