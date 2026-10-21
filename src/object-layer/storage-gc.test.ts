import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createSignedObject, createSignedRecommendationObject } from './envelope';
import { IndexedDbObjectStore } from './local-store';
import {
  DEFAULT_OBJECT_STORAGE_BYTES,
  DELETION_TOMBSTONE_GRACE_PERIOD_MS,
  MIN_OBJECT_STORAGE_BYTES,
  OWN_DELETION_TOMBSTONE_GRACE_PERIOD_MS,
  classifyObjectRetentionPriority,
  getObservationRecordByteSize,
  getStoredObjectByteSize,
  isDeletionTombstoneEligible,
  parseObjectStorageLimitMb,
  planObjectStorageGarbageCollection,
  validateObjectStorageGcOptions
} from './storage-gc';
import type { DeletionTombstone, DistributedObject } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-10-20T00:00:00.000Z');

function object(
  objectId: string,
  objectType: string,
  author: string,
  observedAt: string
): { object: DistributedObject; observedAt: string; byteSize: number } {
  return {
    object: {
      object_id: objectId,
      object_type: objectType,
      author,
      created_at: NOW.toISOString(),
      payload: {},
      signature: '',
      replication_policy: {}
    },
    observedAt,
    byteSize: 300
  };
}

function tombstone(targetAuthor: string, deletedAt: Date): DeletionTombstone {
  return {
    target_object_id: 'a'.repeat(64),
    target_object_type: 'mycelium.post',
    target_author: targetAuthor,
    target_created_at: NOW.toISOString(),
    delete_request_id: 'b'.repeat(64),
    deleted_at: deletedAt.toISOString()
  };
}

function plan(
  objects: ReturnType<typeof object>[],
  currentBytes: number,
  overrides: Partial<Parameters<typeof planObjectStorageGarbageCollection>[0]> = {}
) {
  return planObjectStorageGarbageCollection({
    currentBytes,
    maxStorageBytes: 1_000,
    highWaterRatio: 0.9,
    lowWaterRatio: 0.5,
    now: NOW,
    objects,
    tombstones: [],
    ...overrides
  });
}

describe('object-storage GC policy', () => {
  it('uses a single configurable allocation with a 100 MB minimum and 500 MB default', () => {
    expect(MIN_OBJECT_STORAGE_BYTES).toBe(100_000_000);
    expect(DEFAULT_OBJECT_STORAGE_BYTES).toBe(500_000_000);
    expect(() => validateObjectStorageGcOptions({ maxStorageBytes: MIN_OBJECT_STORAGE_BYTES - 1 })).toThrow(RangeError);
    expect(() => validateObjectStorageGcOptions({ maxStorageBytes: MIN_OBJECT_STORAGE_BYTES })).not.toThrow();
    expect(parseObjectStorageLimitMb(null)).toBe(500);
    expect(parseObjectStorageLimitMb('100')).toBe(100);
    expect(parseObjectStorageLimitMb('99')).toBe(500);
    expect(parseObjectStorageLimitMb('invalid')).toBe(500);
  });

  it('removes an old Level 4 object before a newer Level 3 object', () => {
    const oldSupporting = {
      ...object('supporting', 'mycelium.recommendation', 'peer', '2026-09-01T00:00:00.000Z'),
      byteSize: 400
    };
    const newerPost = object('ordinary', 'mycelium.post', 'peer', '2026-10-01T00:00:00.000Z');

    const result = plan([oldSupporting, newerPost], 950, {
      lowWaterRatio: 0.6
    });

    expect(result.removedObjectIds).toEqual(['supporting']);
    expect(result.bytesAfter).toBe(550);
  });

  it('allows a very old Level 3 object to rank ahead of a newer Level 4 object', () => {
    const veryOldPost = {
      ...object('very-old-post', 'mycelium.post', 'peer', '2026-01-01T00:00:00.000Z'),
      byteSize: 400
    };
    const recentSupporting = object('recent-support', 'mycelium.recommendation', 'peer', '2026-10-19T00:00:00.000Z');

    const result = plan([veryOldPost, recentSupporting], 950, {
      lowWaterRatio: 0.6
    });

    expect(result.removedObjectIds).toEqual(['very-old-post']);
  });

  it('strongly protects Level 1 content while other candidates can meet the target', () => {
    const ownPost = object('own-post', 'mycelium.post', 'local', '2026-01-01T00:00:00.000Z');
    const ordinaryPost = object('ordinary-post', 'mycelium.post', 'peer', '2026-09-01T00:00:00.000Z');
    const support = {
      ...object('support', 'mycelium.recommendation', 'peer', '2026-09-01T00:00:00.000Z'),
      byteSize: 400
    };

    expect(classifyObjectRetentionPriority(ownPost.object, { localAuthor: 'local' })).toBe(1);
    const result = plan([ownPost, ordinaryPost, support], 950, {
      maxStorageBytes: 1_000,
      lowWaterRatio: 0.7,
      context: { localAuthor: 'local' }
    });

    expect(result.removedObjectIds).toEqual(['support']);
    expect(result.removedObjectIds).not.toContain('own-post');
  });

  it('terminates and reports when Level 1 objects alone prevent reaching the low-water target', () => {
    const protectedObjects = [
      { ...object('own-post-a', 'mycelium.post', 'local', NOW.toISOString()), byteSize: 300 },
      { ...object('own-post-b', 'mycelium.post', 'local', NOW.toISOString()), byteSize: 300 }
    ];
    const belowSeverePressure = plan(protectedObjects, 950, {
      lowWaterRatio: 0.3,
      context: { localAuthor: 'local' }
    });

    expect(belowSeverePressure.targetReached).toBe(false);
    expect(belowSeverePressure.bytesAfter).toBe(950);
    expect(belowSeverePressure.removedObjectIds).toEqual([]);

    const severePressure = plan(protectedObjects, 1_010, {
      lowWaterRatio: 0.5,
      context: { localAuthor: 'local' }
    });
    expect(severePressure.targetReached).toBe(true);
    expect(severePressure.removedObjectIds).toHaveLength(2);
  });

  it('classifies direct messages sent by and addressed to the local user as Level 1', () => {
    const sent = {
      ...object('sent-dm', 'mycelium.dm', 'local', NOW.toISOString()).object,
      recipient: 'other'
    };
    const received = {
      ...object('received-dm', 'mycelium.dm', 'other', NOW.toISOString()).object,
      recipient: 'local'
    };

    expect(classifyObjectRetentionPriority(sent, { localAuthor: 'local' })).toBe(1);
    expect(classifyObjectRetentionPriority(received, { localAuthor: 'local' })).toBe(1);
  });

  it('runs at the high-water mark and plans removals down to the low-water mark', () => {
    const candidate = {
      ...object('candidate', 'mycelium.post', 'peer', '2026-09-01T00:00:00.000Z'),
      byteSize: 150
    };
    expect(plan([candidate], 899).triggered).toBe(false);
    const result = plan([candidate], 900, { lowWaterRatio: 0.78 });

    expect(result.triggered).toBe(true);
    expect(result.bytesAfter).toBe(750);
    expect(result.removedObjectIds).toEqual(['candidate']);
  });

  it('reevaluates against a changed budget: lowering can trigger collection and raising does not', () => {
    const candidate = {
      ...object('budget-candidate', 'mycelium.post', 'peer', '2026-09-01T00:00:00.000Z'),
      byteSize: 250
    };
    const currentBytes = 850;

    expect(plan([candidate], currentBytes, {
      maxStorageBytes: 1_000,
      highWaterRatio: 0.9,
      lowWaterRatio: 0.78
    }).triggered).toBe(false);
    const lowered = plan([candidate], currentBytes, {
      maxStorageBytes: 900,
      highWaterRatio: 0.9,
      lowWaterRatio: 0.78
    });
    const raised = plan([candidate], currentBytes, {
      maxStorageBytes: 1_200,
      highWaterRatio: 0.9,
      lowWaterRatio: 0.78
    });

    expect(lowered.triggered).toBe(true);
    expect(lowered.removedObjectIds).toEqual(['budget-candidate']);
    expect(raised.triggered).toBe(false);
    expect(raised.removedObjectIds).toEqual([]);
    expect(raised.bytesAfter).toBe(currentBytes);
  });

  it('keeps a deletion tombstone while its target is retained and allows collection after its grace period', () => {
    const record = tombstone('other-user', new Date(NOW.getTime() - DELETION_TOMBSTONE_GRACE_PERIOD_MS - 1));
    expect(isDeletionTombstoneEligible(record, true, 'local-user', NOW)).toBe(false);
    expect(isDeletionTombstoneEligible(
      { ...record, deleted_at: NOW.toISOString() },
      false,
      'local-user',
      NOW
    )).toBe(false);
    expect(isDeletionTombstoneEligible(record, false, 'local-user', NOW)).toBe(true);
  });

  it('does not plan to remove a retained target’s tombstone, but collects an expired record after the target is gone', () => {
    const record = tombstone('other-user', new Date(NOW.getTime() - DELETION_TOMBSTONE_GRACE_PERIOD_MS - 1));
    const retainedTarget = object(record.target_object_id, 'mycelium.post', 'other-user', NOW.toISOString());
    const protectedResult = plan([retainedTarget], 950, {
      tombstones: [{ tombstone: record, byteSize: 400, targetIsRetained: true }]
    });
    const collectibleResult = plan([], 950, {
      tombstones: [{ tombstone: record, byteSize: 400, targetIsRetained: false }]
    });

    expect(protectedResult.removedTombstoneIds).toEqual([]);
    expect(collectibleResult.removedTombstoneIds).toEqual([record.target_object_id]);
  });

  it('retains the local user’s deletion record longer than ordinary tombstones', () => {
    const deletedRecently = new Date(NOW.getTime() - DELETION_TOMBSTONE_GRACE_PERIOD_MS - 1);
    const ownRecord = tombstone('local-user', deletedRecently);
    const otherRecord = { ...ownRecord, target_author: 'other-user' };

    expect(isDeletionTombstoneEligible(otherRecord, false, 'local-user', NOW)).toBe(true);
    expect(isDeletionTombstoneEligible(ownRecord, false, 'local-user', NOW)).toBe(false);
    expect(OWN_DELETION_TOMBSTONE_GRACE_PERIOD_MS).toBeGreaterThan(DELETION_TOMBSTONE_GRACE_PERIOD_MS);
  });

  it('gives likes, followed authors, and local post interactions Level 2 priority', () => {
    const liked = object('liked', 'mycelium.post', 'peer', NOW.toISOString()).object;
    const followed = { ...liked, object_id: 'followed', author: 'followed-author' };
    const hidden = { ...liked, object_id: 'hidden' };
    expect(classifyObjectRetentionPriority(liked, { likedPostIds: new Set(['liked']) })).toBe(2);
    expect(classifyObjectRetentionPriority(followed, { followedAuthors: new Set(['followed-author']) })).toBe(2);
    expect(classifyObjectRetentionPriority(hidden)).toBe(3);
    expect(classifyObjectRetentionPriority(liked, {
      explicitlyValuableObjectIds: new Set(['liked'])
    })).toBe(2);
  });
});

describe('IndexedDbObjectStore garbage collection', () => {
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('mycelium_objects');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Object database deletion was blocked'));
    });
  });

  it('removes only the local copy and permits the object to be stored again normally', async () => {
    await deleteObjectDatabase();
    const pair = await generateIdentityKeyPair();
    const privateKey = await exportPrivateKey(pair.privateKey);
    const publicKey = await exportPublicKey(pair.publicKey);
    const identity = createObjectIdentity({ id: 'gc-local', publicKey, privateKey });
    const storedAt = new Date('2026-10-20T00:00:00.000Z');
    const settings = {
      maxStorageBytes: MIN_OBJECT_STORAGE_BYTES,
      highWaterRatio: 0.9,
      lowWaterRatio: 0.78,
      now: () => storedAt
    };
    const store = new IndexedDbObjectStore(settings);
    const post = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: storedAt.toISOString(),
      payload: { content: 'can be cached again' },
      replication_policy: {}
    }, identity);

    expect(await store.put(post)).toBe(true);
    expect(await store.get(post.object_id)).toEqual(post);

    settings.highWaterRatio = 0.000001;
    settings.lowWaterRatio = 0.0000005;
    const gcResult = await store.collectGarbage();
    expect(gcResult.removedObjectIds).toContain(post.object_id);
    expect(await store.get(post.object_id)).toBeNull();
    expect(await store.getDeletionTombstone(post.object_id)).toBeNull();

    settings.highWaterRatio = 0.9;
    settings.lowWaterRatio = 0.78;
    expect(await store.put(post)).toBe(true);
    expect(await store.get(post.object_id)).toEqual(post);
  });

  it('keeps observation records synchronized through repeated insert/delete/reinsert cycles', async () => {
    await deleteObjectDatabase();
    const pair = await generateIdentityKeyPair();
    const identity = createObjectIdentity({
      id: 'gc-observation-cycle',
      publicKey: await exportPublicKey(pair.publicKey),
      privateKey: await exportPrivateKey(pair.privateKey)
    });
    const store = new IndexedDbObjectStore();
    const post = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: NOW.toISOString(),
      payload: { content: 'observation cycle' },
      replication_policy: {}
    }, identity);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      expect(await store.put(post)).toBe(true);
      expect(await readObjectObservationCount()).toBe(1);
      await store.delete(post.object_id);
      expect(await readObjectObservationCount()).toBe(0);
    }

    expect(await store.put(post)).toBe(true);
    expect(await readObjectObservationCount()).toBe(1);
  });

  it('refreshes the usage estimate after insertions and deletions using object and observation records', async () => {
    await deleteObjectDatabase();
    const pair = await generateIdentityKeyPair();
    const identity = createObjectIdentity({
      id: 'gc-usage-callback',
      publicKey: await exportPublicKey(pair.publicKey),
      privateKey: await exportPrivateKey(pair.privateKey)
    });
    const usageUpdates: number[] = [];
    const store = new IndexedDbObjectStore({
      now: () => NOW,
      onStorageUsageChange: (bytes) => usageUpdates.push(bytes)
    });
    const post = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: NOW.toISOString(),
      payload: { content: 'usage callback' },
      replication_policy: {}
    }, identity);

    await store.put(post);
    expect(usageUpdates[usageUpdates.length - 1]).toBe(
      getStoredObjectByteSize(post) + getObservationRecordByteSize(post.object_id, NOW.toISOString())
    );
    const deletion = { ...tombstone(identity.publicKey, NOW), target_object_id: post.object_id };
    await store.applyDeletionTombstone(deletion);
    expect(usageUpdates[usageUpdates.length - 1]).toBe(getStoredObjectByteSize(deletion));
    expect(await store.get(post.object_id)).toBeNull();
    expect(await store.put(post)).toBe(false);
  });

  it('does not evict objects when the current usage is below a raised budget', async () => {
    await deleteObjectDatabase();
    const pair = await generateIdentityKeyPair();
    const identity = createObjectIdentity({
      id: 'gc-raised-budget',
      publicKey: await exportPublicKey(pair.publicKey),
      privateKey: await exportPrivateKey(pair.privateKey)
    });
    let budgetBytes = 500 * 1_000_000;
    const store = new IndexedDbObjectStore({ getMaxStorageBytes: () => budgetBytes });
    const post = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: NOW.toISOString(),
      payload: { content: 'must remain after raising limit' },
      replication_policy: {}
    }, identity);
    await store.put(post);
    budgetBytes = 750 * 1_000_000;

    const result = await store.collectGarbage();
    expect(result.triggered).toBe(false);
    expect(result.removedObjectIds).toEqual([]);
    expect(await store.get(post.object_id)).toEqual(post);
  });

  it('serializes concurrent GC runs without corrupting the reported storage total', async () => {
    await deleteObjectDatabase();
    const pair = await generateIdentityKeyPair();
    const identity = createObjectIdentity({
      id: 'gc-concurrent',
      publicKey: await exportPublicKey(pair.publicKey),
      privateKey: await exportPrivateKey(pair.privateKey)
    });
    const settings = { highWaterRatio: 0.9, lowWaterRatio: 0.78 };
    const store = new IndexedDbObjectStore(settings);
    const posts = await Promise.all(Array.from({ length: 4 }, (_, index) => createSignedObject({
      object_type: 'mycelium.post',
      created_at: NOW.toISOString(),
      payload: { content: `concurrent ${index}`, padding: 'x'.repeat(400) },
      replication_policy: {}
    }, identity)));
    await Promise.all(posts.map((post) => store.put(post)));

    settings.highWaterRatio = 0.000001;
    settings.lowWaterRatio = 0.0000005;
    const [first, second] = await Promise.all([
      store.collectGarbage(),
      store.collectGarbage()
    ]);
    const final = await store.collectGarbage();

    expect(first.bytesAfter).toBeGreaterThanOrEqual(0);
    expect(second.bytesAfter).toBeGreaterThanOrEqual(0);
    expect(final.targetReached).toBe(true);
    expect(final.bytesAfter).toBe(final.bytesBefore);
    expect(await readObjectObservationCount()).toBe((await store.query({ object_type: 'mycelium.post' })).length);
  });

  it('retains the local user’s latest recommendation action so rebuilding state cannot resurrect an old like', async () => {
    await deleteObjectDatabase();
    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const identity = createObjectIdentity({
      id: 'gc-recommendation-state',
      publicKey,
      privateKey: await exportPrivateKey(pair.privateKey)
    });
    const settings = {
      maxStorageBytes: MIN_OBJECT_STORAGE_BYTES,
      highWaterRatio: 0.9,
      lowWaterRatio: 0.78,
      getLocalAuthor: () => publicKey
    };
    const store = new IndexedDbObjectStore(settings);
    const postId = 'c'.repeat(64);
    const oldLike = await createSignedRecommendationObject(postId, 'recommend', 1, identity);
    const currentWithdrawal = await createSignedRecommendationObject(postId, 'withdraw', 2, identity);
    await store.put(oldLike);
    await store.put(currentWithdrawal);

    settings.highWaterRatio = 0.00001;
    settings.lowWaterRatio = 0.000009;
    const result = await store.collectGarbage();

    expect(result.removedObjectIds).toContain(oldLike.object_id);
    expect(result.removedObjectIds).not.toContain(currentWithdrawal.object_id);
    expect(await store.get(currentWithdrawal.object_id)).toEqual(currentWithdrawal);
  });
});

async function readObjectObservationCount(): Promise<number> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mycelium_objects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction('object_observations', 'readonly');
      const request = transaction.objectStore('object_observations').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

function deleteObjectDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('mycelium_objects');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Object database deletion was blocked'));
  });
}
