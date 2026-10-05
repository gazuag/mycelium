import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbOutboxStore, type OutboxEntry, type OutboxStore } from './local-store';
import { createOutboxService } from './outbox-service';
import type { DistributedObject } from './types';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const FUTURE = new Date('2026-11-05T12:00:00.000Z');

function makeObject(
  objectId: string,
  options: { recipient?: string; createdAt?: Date; expiresAt?: Date; payload?: Record<string, string> } = {}
): DistributedObject {
  return {
    object_id: objectId,
    object_type: 'mycelium.dm',
    author: 'author-signing-key',
    ...(options.recipient ? { recipient: options.recipient } : {}),
    created_at: (options.createdAt ?? NOW).toISOString(),
    expires_at: (options.expiresAt ?? FUTURE).toISOString(),
    payload: options.payload ?? { ciphertext: 'encrypted-content' },
    signature: 'signature',
    replication_policy: { replication_budget: 3 }
  };
}

function makeEntry(
  objectId: string,
  createdAt: Date,
  expiresAt = FUTURE
): OutboxEntry {
  return {
    object_id: objectId,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    replicated_to: [],
    delivered_direct: false,
    attempts: 0,
    last_attempt_at: null
  };
}

function makeMemoryOutbox(): OutboxStore {
  const entries = new Map<string, OutboxEntry>();
  return {
    async add(entry) {
      if (!entries.has(entry.object_id)) entries.set(entry.object_id, structuredClone(entry));
    },
    async get(objectId) {
      const entry = entries.get(objectId);
      return entry ? structuredClone(entry) : null;
    },
    async listPending(limit) {
      return [...entries.values()]
        .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },
    async update(entry) {
      entries.set(entry.object_id, structuredClone(entry));
    },
    async remove(objectId) {
      entries.delete(objectId);
    },
    async pruneExpired(now) {
      let count = 0;
      for (const entry of entries.values()) {
        if (Date.parse(entry.expires_at) <= now.getTime()) {
          entries.delete(entry.object_id);
          count += 1;
        }
      }
      return count;
    }
  };
}

function createHarness(options: {
  objects?: DistributedObject[];
  outbox?: OutboxStore;
  connectedPeers?: string[];
  resolvePeer?: (recipient: string) => string | null;
  sendDirect?: (peerId: string, object: DistributedObject) => Promise<boolean>;
  replicate?: (object: DistributedObject, alreadyReplicatedTo: Set<string>) => Promise<string[]>;
  config?: { maxPerFlush?: number };
} = {}) {
  const objects = new Map((options.objects ?? []).map((object) => [object.object_id, object]));
  const outbox = options.outbox ?? makeMemoryOutbox();
  const sendDirect = options.sendDirect ?? vi.fn(async () => true);
  const replicate = options.replicate ?? vi.fn(async () => []);
  const service = createOutboxService({
    outbox,
    objectStore: { get: async (objectId) => objects.get(objectId) ?? null },
    sendDirect,
    replicate,
    resolveRecipientPeerId: options.resolvePeer ?? (() => 'recipient-peer'),
    connectedPeers: () => options.connectedPeers ?? ['recipient-peer'],
    now: () => NOW,
    config: options.config
  });
  return { service, outbox, objects, sendDirect, replicate };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndexedDbOutboxStore and outbox service', () => {
  it('upgrades mycelium_objects v4 to v5 while preserving existing stores, indexes, and data', async () => {
    const request = indexedDB.open('mycelium_objects', 4);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const objects = request.result.createObjectStore('objects', { keyPath: 'object_id' });
        objects.createIndex('recipient_created_at', ['recipient', 'created_at'], { unique: false });
        request.result.createObjectStore('local_post_metadata', { keyPath: 'object_id' });
        request.result.createObjectStore('recommendation_sequences', { keyPath: 'author' });
        request.result.createObjectStore('outbox_legacy_marker', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['objects', 'local_post_metadata', 'recommendation_sequences', 'outbox_legacy_marker'], 'readwrite');
      transaction.objectStore('objects').put({ object_id: 'kept-object' });
      transaction.objectStore('local_post_metadata').put({ object_id: 'kept-metadata' });
      transaction.objectStore('recommendation_sequences').put({ author: 'kept-author' });
      transaction.objectStore('outbox_legacy_marker').put({ id: 'kept-marker' });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const outbox = new IndexedDbOutboxStore();
    await outbox.add(makeEntry('upgrade-check', NOW));
    const upgradedRequest = indexedDB.open('mycelium_objects', 5);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      upgradedRequest.onsuccess = () => resolve(upgradedRequest.result);
      upgradedRequest.onerror = () => reject(upgradedRequest.error);
    });
    expect(upgraded.objectStoreNames.contains('objects')).toBe(true);
    expect(upgraded.objectStoreNames.contains('local_post_metadata')).toBe(true);
    expect(upgraded.objectStoreNames.contains('recommendation_sequences')).toBe(true);
    expect(upgraded.objectStoreNames.contains('outbox')).toBe(true);
    const indexNames = [...upgraded.transaction('objects').objectStore('objects').indexNames];
    expect(indexNames).toContain('recipient_created_at');
    const preserved = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const transaction = upgraded.transaction(['objects', 'local_post_metadata', 'recommendation_sequences', 'outbox_legacy_marker'], 'readonly');
      const results: Record<string, unknown> = {};
      for (const name of ['objects', 'local_post_metadata', 'recommendation_sequences', 'outbox_legacy_marker']) {
        const key = name === 'objects' || name === 'local_post_metadata'
          ? name === 'objects' ? 'kept-object' : 'kept-metadata'
          : name === 'recommendation_sequences' ? 'kept-author' : 'kept-marker';
        transaction.objectStore(name).get(key).onsuccess = (event) => {
          results[name] = (event.target as IDBRequest).result;
        };
      }
      transaction.oncomplete = () => resolve(results);
      transaction.onerror = () => reject(transaction.error);
    });
    expect(preserved).toMatchObject({
      objects: { object_id: 'kept-object' },
      local_post_metadata: { object_id: 'kept-metadata' },
      recommendation_sequences: { author: 'kept-author' },
      outbox_legacy_marker: { id: 'kept-marker' }
    });
    upgraded.close();
  });

  it('supports outbox CRUD and idempotent add by object_id', async () => {
    const store = new IndexedDbOutboxStore();
    const entry = makeEntry('crud-entry', NOW);
    await store.add(entry);
    await store.add({ ...entry, attempts: 99 });
    expect(await store.get(entry.object_id)).toEqual(entry);
    const updated = { ...entry, attempts: 1, last_attempt_at: NOW.toISOString() };
    await store.update(updated);
    expect(await store.get(entry.object_id)).toEqual(updated);
    await store.remove(entry.object_id);
    expect(await store.get(entry.object_id)).toBeNull();
  });

  it('lists pending entries oldest first and respects the limit', async () => {
    const store = new IndexedDbOutboxStore();
    await store.add(makeEntry('list-later', new Date(NOW.getTime() - 24 * 60 * 60 * 1000 + 2000)));
    await store.add(makeEntry('list-oldest', new Date(NOW.getTime() - 24 * 60 * 60 * 1000)));
    await store.add(makeEntry('list-middle', new Date(NOW.getTime() - 24 * 60 * 60 * 1000 + 1000)));

    const result = await store.listPending(2);
    expect(result.map((entry) => entry.object_id)).toEqual(['list-oldest', 'list-middle']);
  });

  it('prunes expired entries while preserving unexpired entries', async () => {
    const store = new IndexedDbOutboxStore();
    await store.add(makeEntry('prune-expired', NOW, new Date(NOW.getTime() - 1)));
    await store.add(makeEntry('prune-future', NOW, FUTURE));

    await expect(store.pruneExpired(NOW)).resolves.toBe(1);
    expect(await store.get('prune-expired')).toBeNull();
    expect(await store.get('prune-future')).not.toBeNull();
  });

  it('sends directly to a connected recipient and records delivered_direct', async () => {
    const object = makeObject('direct-connected', { recipient: 'recipient-signing-key' });
    const { service, outbox, sendDirect } = createHarness({ objects: [object] });
    await service.enqueue(object);

    await service.flush();

    expect(sendDirect).toHaveBeenCalledWith('recipient-peer', object);
    expect(await outbox.get(object.object_id)).toMatchObject({ delivered_direct: true, attempts: 1 });
  });

  it('does not send directly when the resolved recipient peer is disconnected', async () => {
    const object = makeObject('direct-disconnected', { recipient: 'recipient-signing-key' });
    const { service, outbox, sendDirect } = createHarness({ objects: [object], connectedPeers: ['other-peer'] });
    await service.enqueue(object);

    await service.flush();

    expect(sendDirect).not.toHaveBeenCalled();
    expect(await outbox.get(object.object_id)).toMatchObject({ delivered_direct: false, attempts: 1 });
  });

  it('does not count a direct recipient send toward the replication budget', async () => {
    const object = makeObject('direct-not-replica', { recipient: 'recipient-signing-key' });
    const replicate = vi.fn(async (_object: DistributedObject, alreadyReplicatedTo: Set<string>) => {
      expect([...alreadyReplicatedTo]).toEqual([]);
      return [];
    });
    const { service, outbox } = createHarness({ objects: [object], replicate });
    await service.enqueue(object);

    await service.flush();

    expect(replicate).toHaveBeenCalledTimes(1);
    expect(await outbox.get(object.object_id)).toMatchObject({ delivered_direct: true, replicated_to: [] });
  });

  it('merges replication results and completes when the replication budget is met', async () => {
    const object = makeObject('replication-budget');
    const outbox = makeMemoryOutbox();
    await outbox.add({ ...makeEntry(object.object_id, NOW), replicated_to: ['existing-peer'] });
    const { service } = createHarness({
      objects: [object],
      outbox,
      replicate: async (_object, alreadyReplicatedTo) => {
        expect([...alreadyReplicatedTo]).toEqual(['existing-peer']);
        return ['peer-two', 'peer-three'];
      }
    });

    await expect(service.flush()).resolves.toEqual({ processed: 1, completed: 1 });
    expect(await outbox.get(object.object_id)).toBeNull();
  });

  it('completes after direct delivery plus one replica', async () => {
    const object = makeObject('direct-and-replica', { recipient: 'recipient-signing-key' });
    const { service, outbox } = createHarness({ objects: [object], replicate: async () => ['replica-peer'] });
    await service.enqueue(object);

    await expect(service.flush()).resolves.toMatchObject({ completed: 1 });
    expect(await outbox.get(object.object_id)).toBeNull();
  });

  it('leaves an entry pending without peers and increments its attempt metadata', async () => {
    const object = makeObject('no-peers', { recipient: 'recipient-signing-key' });
    const { service, outbox, sendDirect, replicate } = createHarness({ objects: [object], connectedPeers: [] });
    await service.enqueue(object);

    await service.flush();

    expect(sendDirect).not.toHaveBeenCalled();
    expect(replicate).toHaveBeenCalledTimes(1);
    expect(await outbox.get(object.object_id)).toMatchObject({
      attempts: 1,
      last_attempt_at: NOW.toISOString(),
      replicated_to: [],
      delivered_direct: false
    });
  });

  it('removes entries whose object is expired or missing', async () => {
    const expired = makeObject('object-expired', { expiresAt: new Date(NOW.getTime() - 1) });
    const missing = makeObject('object-missing');
    const outbox = makeMemoryOutbox();
    await outbox.add(makeEntry(expired.object_id, NOW, FUTURE));
    await outbox.add(makeEntry(missing.object_id, new Date(NOW.getTime() + 1), FUTURE));
    const { service } = createHarness({ objects: [expired], outbox });

    await expect(service.flush()).resolves.toEqual({ processed: 2, completed: 2 });
    expect(await outbox.get(expired.object_id)).toBeNull();
    expect(await outbox.get(missing.object_id)).toBeNull();
  });

  it('continues to other entries when direct send or replication throws', async () => {
    const failed = makeObject('failing-entry', { recipient: 'recipient-signing-key' });
    const succeeds = makeObject('following-entry', { recipient: 'recipient-signing-key' });
    const outbox = makeMemoryOutbox();
    const sendDirect = vi.fn(async (_peerId: string, object: DistributedObject) => {
      if (object.object_id === failed.object_id) throw new Error('send failed');
      return true;
    });
    const replicate = vi.fn(async (object: DistributedObject) => {
      if (object.object_id === failed.object_id) throw new Error('replication failed');
      return ['replica-peer'];
    });
    const { service } = createHarness({ objects: [failed, succeeds], outbox, sendDirect, replicate });
    await service.enqueue(failed);
    await service.enqueue(succeeds);

    await expect(service.flush()).resolves.toEqual({ processed: 2, completed: 1 });
    expect(await outbox.get(failed.object_id)).toMatchObject({ attempts: 1, delivered_direct: false });
    expect(await outbox.get(succeeds.object_id)).toBeNull();
  });

  it('shares one in-flight flush across overlapping calls', async () => {
    const object = makeObject('single-flight');
    let finishReplication!: (peers: string[]) => void;
    const replicate = vi.fn(() => new Promise<string[]>((resolve) => { finishReplication = resolve; }));
    const { service } = createHarness({ objects: [object], replicate });
    await service.enqueue(object);

    const first = service.flush();
    const second = service.flush();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(replicate).toHaveBeenCalledTimes(1));
    finishReplication([]);
    await Promise.all([first, second]);
  });

  it('limits the number of entries processed in a single flush', async () => {
    const objects = Array.from({ length: 52 }, (_, index) => makeObject(`bounded-${index}`));
    const { service, outbox } = createHarness({ objects, config: { maxPerFlush: 50 } });
    for (const object of objects) await service.enqueue(object);

    const result = await service.flush();

    expect(result.processed).toBe(50);
    expect((await outbox.listPending(100)).length).toBe(52);
  });

  it('stores no payload or plaintext in outbox entries', async () => {
    const plaintext = 'do-not-store-this-plaintext-in-outbox';
    const object = makeObject('outbox-no-payload', {
      recipient: 'recipient-signing-key',
      payload: { ciphertext: 'ciphertext-only' }
    });
    const { service, outbox } = createHarness({ objects: [object] });
    await service.enqueue(object);
    const entry = await outbox.get(object.object_id);

    expect(entry).not.toHaveProperty('payload');
    expect(JSON.stringify(entry)).not.toContain(plaintext);
    expect(JSON.stringify(entry)).not.toContain('ciphertext-only');
  });

  it('uses object expiry or defaults to thirty days after creation', async () => {
    const object = makeObject('expiry-default');
    const copyExpiryObject = makeObject('expiry-copy', { expiresAt: new Date(NOW.getTime() + 12_345) });
    const noExpiryObject = { ...object, object_id: 'expiry-default-no-expiry', expires_at: undefined };
    const { service, outbox } = createHarness({ objects: [noExpiryObject] });
    await service.enqueue(copyExpiryObject);
    await service.enqueue(noExpiryObject);

    expect(await outbox.get(copyExpiryObject.object_id)).toMatchObject({
      expires_at: copyExpiryObject.expires_at
    });
    expect(await outbox.get(noExpiryObject.object_id)).toMatchObject({
      created_at: object.created_at,
      expires_at: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
  });

  it('removes an entry when its attempt count reaches 200', async () => {
    const object = makeObject('attempt-cap');
    const outbox = makeMemoryOutbox();
    await outbox.add({ ...makeEntry(object.object_id, NOW), attempts: 199 });
    const { service } = createHarness({ objects: [object], outbox });

    await expect(service.flush()).resolves.toMatchObject({ completed: 1 });
    expect(await outbox.get(object.object_id)).toBeNull();
  });
});
