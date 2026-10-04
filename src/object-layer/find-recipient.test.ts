import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createSignedObject } from './envelope';
import { IndexedDbObjectStore } from './local-store';
import {
  buildFindPacket,
  FindAggregation,
  filterObjectsByFindQuery,
  getFindQueryCriteria,
  MAX_FIND_QUERY_LIMIT,
  prepareFindQueryResponse,
  respondToFindPacket
} from './transport';
import type { DistributedObject, ObjectContent } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const openStores: IndexedDbObjectStore[] = [];
const storedObjectIds: string[] = [];

function createStore(): IndexedDbObjectStore {
  const store = new IndexedDbObjectStore();
  openStores.push(store);
  return store;
}

async function createObject(options: {
  recipient?: string;
  objectType?: string;
  createdAt?: string;
} = {}): Promise<DistributedObject> {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  const content: ObjectContent = {
    object_type: options.objectType ?? 'mycelium.dm',
    created_at: options.createdAt ?? '2026-09-30T12:00:00.000Z',
    ...(options.recipient === undefined ? {} : { recipient: options.recipient }),
    payload: { content: 'opaque' },
    replication_policy: {}
  };
  return await createSignedObject(content, createObjectIdentity({ id: 'find-recipient-test', publicKey, privateKey }));
}

afterEach(async () => {
  for (const store of openStores) {
    for (const objectId of storedObjectIds) await store.delete(objectId);
    const database = await (store as unknown as { databasePromise: Promise<IDBDatabase> }).databasePromise;
    database.close();
  }
  openStores.length = 0;
  storedObjectIds.length = 0;
});

describe('recipient FIND queries', () => {
  it('round-trips recipient through a FIND packet', async () => {
    const packet = await buildFindPacket('requester', 'peer-a', [], undefined, 'recipient-round-trip', 1, 'requester', undefined, {
      recipient: 'recipient-signing-key',
      since: '2026-09-30T11:00:00.000Z'
    });

    expect(packet.payload.recipient).toBe('recipient-signing-key');
    expect(getFindQueryCriteria(packet)).toMatchObject({ recipient: 'recipient-signing-key', since: '2026-09-30T11:00:00.000Z' });
  });

  it('rejects an invalid recipient criterion instead of answering it', async () => {
    const store = createStore();
    const packet = await buildFindPacket('requester', 'local', [], undefined, 'invalid-recipient', 0, 'requester');
    const invalidPacket = { ...packet, payload: { ...packet.payload, recipient: '   ' } };
    const responses: unknown[] = [];

    await expect(respondToFindPacket(invalidPacket, store, async (response) => { responses.push(response); }, 'local'))
      .resolves.toBe(false);
    expect(responses).toEqual([]);
  });

  it('answers a local FIND with only objects addressed to its recipient criterion', async () => {
    const store = createStore();
    const addressed = await createObject({ recipient: 'recipient-a' });
    const otherRecipient = await createObject({ recipient: 'recipient-b' });
    const noRecipient = await createObject();
    for (const object of [addressed, otherRecipient, noRecipient]) {
      await store.put(object);
      storedObjectIds.push(object.object_id);
    }
    const packet = await buildFindPacket('requester', 'local', [], undefined, 'local-recipient-query', 0, 'requester', undefined, {
      object_type: 'mycelium.dm',
      recipient: 'recipient-a'
    });
    const responses: Array<{ payload: { objects: readonly DistributedObject[] } }> = [];

    await expect(respondToFindPacket(packet, store, async (response) => { responses.push(response); }, 'local'))
      .resolves.toBe(true);
    expect(responses[0]?.payload.objects).toEqual([addressed]);
  });

  it('combines recipient and inclusive created_after bounds', async () => {
    const store = createStore();
    const atBound = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T12:00:00.000Z' });
    const beforeBound = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T11:59:59.999Z' });
    for (const object of [atBound, beforeBound]) {
      await store.put(object);
      storedObjectIds.push(object.object_id);
    }

    const result = await filterObjectsByFindQuery(store, {
      recipient: 'recipient-a',
      created_after: '2026-09-30T12:00:00.000Z'
    });
    expect(result).toEqual([atBound]);
  });

  it('combines recipient and object type filters', async () => {
    const store = createStore();
    const dm = await createObject({ recipient: 'recipient-a', objectType: 'mycelium.dm' });
    const post = await createObject({ recipient: 'recipient-a', objectType: 'mycelium.post' });
    for (const object of [dm, post]) {
      await store.put(object);
      storedObjectIds.push(object.object_id);
    }

    await expect(filterObjectsByFindQuery(store, { recipient: 'recipient-a', object_type: 'mycelium.dm' }))
      .resolves.toEqual([dm]);
  });

  it('respects created_at_desc ordering before applying limit', async () => {
    const store = createStore();
    const older = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T12:00:00.000Z' });
    const newest = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T12:00:02.000Z' });
    const middle = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T12:00:01.000Z' });
    for (const object of [older, newest, middle]) {
      await store.put(object);
      storedObjectIds.push(object.object_id);
    }

    await expect(filterObjectsByFindQuery(store, {
      recipient: 'recipient-a',
      order: 'created_at_desc',
      limit: 2
    })).resolves.toEqual([newest, middle]);
  });

  it('merges child results, deduplicates, scopes recipient, validates, and caps the final set', async () => {
    const first = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T12:00:00.000Z' });
    const second = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T12:00:01.000Z' });
    const third = await createObject({ recipient: 'recipient-a', createdAt: '2026-09-30T12:00:02.000Z' });
    const unrelated = await createObject({ recipient: 'recipient-b', createdAt: '2026-09-30T12:00:03.000Z' });
    let completed: DistributedObject[] = [];
    const aggregation = new FindAggregation([], Date.now() + 5000, async (objects) => {
      completed = await prepareFindQueryResponse(objects, {
        recipient: 'recipient-a',
        order: 'created_at_desc',
        limit: 2
      });
    }, undefined, true);
    aggregation.addChild('peer-a');
    aggregation.addChild('peer-b');

    await aggregation.addChildObjects('peer-a', [first, second]);
    await aggregation.addChildObjects('peer-b', [second, third, unrelated]);

    expect(completed).toEqual([third, second]);
    expect(new Set(completed.map((object) => object.object_id)).size).toBe(2);
  });

  it('never matches objects without an envelope recipient', async () => {
    const store = createStore();
    const unaddressed = await createObject();
    await store.put(unaddressed);
    storedObjectIds.push(unaddressed.object_id);

    await expect(filterObjectsByFindQuery(store, { recipient: 'recipient-a' })).resolves.toEqual([]);
  });

  it('caps criteria query limits at the configured maximum', async () => {
    const packet = await buildFindPacket('requester', 'peer-a', [], undefined, 'oversized-limit', 1, 'requester', undefined, {
      object_type: 'mycelium.dm',
      limit: MAX_FIND_QUERY_LIMIT + 1000
    });

    expect(getFindQueryCriteria(packet)?.limit).toBe(MAX_FIND_QUERY_LIMIT);
    const noLimitPacket = await buildFindPacket('requester', 'peer-a', [], undefined, 'default-limit', 1, 'requester', undefined, {
      recipient: 'recipient-a'
    });
    expect(getFindQueryCriteria(noLimitPacket)?.limit).toBe(MAX_FIND_QUERY_LIMIT);
  });
});
