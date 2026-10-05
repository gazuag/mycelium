import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createSignedObject } from './envelope';
import { IndexedDbObjectStore } from './local-store';
import type { DistributedObject, ObjectContent } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const DATABASE_NAME = 'mycelium_objects';
const RECIPIENT_CREATED_AT_INDEX = 'recipient_created_at';
const openStores: IndexedDbObjectStore[] = [];

function createStore(): IndexedDbObjectStore {
  const store = new IndexedDbObjectStore();
  openStores.push(store);
  return store;
}

async function closeStore(store: IndexedDbObjectStore): Promise<void> {
  const database = await (store as unknown as { databasePromise: Promise<IDBDatabase> }).databasePromise;
  database.close();
}

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion blocked by an open connection'));
  });
}

async function createObject(content: Partial<ObjectContent> & { recipient?: string } = {}): Promise<DistributedObject> {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  return await createSignedObject({
    object_type: content.object_type ?? 'recipient-index-test',
    created_at: content.created_at ?? '2026-09-30T12:00:00.000Z',
    payload: content.payload ?? { value: 'test' },
    replication_policy: content.replication_policy ?? {},
    ...(content.recipient === undefined ? {} : { recipient: content.recipient })
  }, createObjectIdentity({ id: 'recipient-index-test', publicKey, privateKey }));
}

afterEach(async () => {
  for (const store of openStores) await closeStore(store);
  openStores.length = 0;
  await deleteDatabase();
});

describe('IndexedDbObjectStore recipient index', () => {
  it('upgrades a version 3 database and preserves existing objects', async () => {
    const existingObject = await createObject();
    const request = indexedDB.open(DATABASE_NAME, 3);
    const legacyDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore('objects', { keyPath: 'object_id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = legacyDatabase.transaction('objects', 'readwrite');
      transaction.objectStore('objects').put(existingObject);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    legacyDatabase.close();

    const store = createStore();
    await expect(store.get(existingObject.object_id)).resolves.toEqual(existingObject);
    const upgraded = await (store as unknown as { databasePromise: Promise<IDBDatabase> }).databasePromise;
    expect(upgraded.version).toBe(5);
    expect(upgraded.transaction('objects').objectStore('objects').indexNames.contains(RECIPIENT_CREATED_AT_INDEX)).toBe(true);
  });

  it('creates the recipient index on a fresh database', async () => {
    const store = createStore();
    await store.query();
    const database = await (store as unknown as { databasePromise: Promise<IDBDatabase> }).databasePromise;

    expect(database.version).toBe(5);
    expect(database.transaction('objects').objectStore('objects').indexNames.contains(RECIPIENT_CREATED_AT_INDEX)).toBe(true);
  });

  it('does not return objects without a recipient in recipient queries', async () => {
    const store = createStore();
    const object = await createObject();
    await store.put(object);

    await expect(store.query({ recipient: 'recipient-a' })).resolves.toEqual([]);
  });

  it('returns only objects addressed to the requested recipient', async () => {
    const store = createStore();
    const addressed = await createObject({ recipient: 'recipient-a' });
    const other = await createObject({ recipient: 'recipient-b' });
    await store.put(addressed);
    await store.put(other);

    await expect(store.query({ recipient: 'recipient-a' })).resolves.toEqual([addressed]);
  });

  it('combines recipient and since with strict newer-than semantics', async () => {
    const store = createStore();
    const sameTime = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:00.000Z' });
    const newer = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:01.000Z' });
    const other = await createObject({ recipient: 'recipient-b', created_at: '2026-09-30T12:00:02.000Z' });
    await store.put(sameTime);
    await store.put(newer);
    await store.put(other);

    await expect(store.query({ recipient: 'recipient-a', since: '2026-09-30T12:00:00.000Z' })).resolves.toEqual([newer]);
  });

  it('combines recipient and object type criteria', async () => {
    const store = createStore();
    const matching = await createObject({ recipient: 'recipient-a', object_type: 'mycelium.dm' });
    const otherType = await createObject({ recipient: 'recipient-a', object_type: 'mycelium.post' });
    await store.put(matching);
    await store.put(otherType);

    await expect(store.query({ recipient: 'recipient-a', object_type: 'mycelium.dm' })).resolves.toEqual([matching]);
  });

  it('orders recipient results by created_at_desc', async () => {
    const store = createStore();
    const older = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:00.000Z' });
    const newer = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:02.000Z' });
    const middle = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:01.000Z' });
    await store.put(older);
    await store.put(newer);
    await store.put(middle);

    await expect(store.query({ recipient: 'recipient-a', order: 'created_at_desc' })).resolves.toEqual([newer, middle, older]);
  });

  it('applies recipient query limits after descending ordering', async () => {
    const store = createStore();
    const older = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:00.000Z' });
    const newest = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:02.000Z' });
    const middle = await createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:01.000Z' });
    await store.put(older);
    await store.put(newest);
    await store.put(middle);

    await expect(store.query({ recipient: 'recipient-a', order: 'created_at_desc', limit: 2 })).resolves.toEqual([newest, middle]);
  });

  it('matches a non-indexed filter for recipient and date criteria', async () => {
    const store = createStore();
    const objects = await Promise.all([
      createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:00.000Z', object_type: 'mycelium.dm' }),
      createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:01.000Z', object_type: 'mycelium.dm' }),
      createObject({ recipient: 'recipient-a', created_at: '2026-09-30T12:00:02.000Z', object_type: 'mycelium.post' }),
      createObject({ recipient: 'recipient-b', created_at: '2026-09-30T12:00:03.000Z', object_type: 'mycelium.dm' }),
      createObject({ created_at: '2026-09-30T12:00:04.000Z', object_type: 'mycelium.dm' })
    ]);
    for (const object of objects) await store.put(object);
    const criteria = {
      recipient: 'recipient-a',
      object_type: 'mycelium.dm',
      created_after: '2026-09-30T11:59:59.000Z',
      created_before: '2026-09-30T12:00:02.000Z',
      since: '2026-09-30T12:00:00.000Z',
      order: 'created_at_desc' as const,
      limit: 5
    };
    const allObjects = await store.query();
    const expected = allObjects
      .filter((object) => object.recipient === criteria.recipient)
      .filter((object) => object.object_type === criteria.object_type)
      .filter((object) => new Date(object.created_at).getTime() >= new Date(criteria.created_after).getTime())
      .filter((object) => new Date(object.created_at).getTime() <= new Date(criteria.created_before).getTime())
      .filter((object) => new Date(object.created_at).getTime() > new Date(criteria.since).getTime())
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
      .slice(0, criteria.limit);

    await expect(store.query(criteria)).resolves.toEqual(expected);
  });

  it('leaves non-recipient queries unchanged', async () => {
    const store = createStore();
    const first = await createObject({ recipient: 'recipient-a', object_type: 'recipient-query-test' });
    const second = await createObject({ recipient: 'recipient-b', object_type: 'recipient-query-test' });
    const noRecipient = await createObject({ object_type: 'recipient-query-test' });
    await store.put(first);
    await store.put(second);
    await store.put(noRecipient);

    await expect(store.query({ object_type: 'recipient-query-test' })).resolves.toHaveLength(3);
  });
});
