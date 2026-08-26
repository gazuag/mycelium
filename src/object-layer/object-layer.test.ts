import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair, signString } from '../crypto/identity';
import { canonicalizeObjectContent, calculateObjectId, createSignedObject, validateObject, validateDistributedObject, type ImmutableObjectContent } from './envelope';
import { createObjectIdentity } from './identity';
import { IndexedDbObjectStore } from './local-store';
import { buildFindResponsePacket, buildObjectStorePacket, findObject, receiveObjectPacket, respondToFindPacket } from './transport';
import { PeerConnectionObjectTransport } from '../p2p/object-transport';
import type { DistributedObject, ObjectPacket, ObjectStore } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

async function createFixtureObject(content: ImmutableObjectContent): Promise<DistributedObject> {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  const unsigned = { ...content, author: publicKey };
  const objectId = await calculateObjectId(unsigned);
  const signature = await signString(privateKey, canonicalizeObjectContent({ ...unsigned, object_id: objectId, signature: '' }));
  return { ...unsigned, object_id: objectId, signature };
}

async function createSignedObjectWithPayload(payload: unknown): Promise<DistributedObject> {
  return createFixtureObject({
    object_type: 'example',
    author: '',
    created_at: '2026-08-25T00:00:00.000Z',
    payload: payload as ImmutableObjectContent['payload'],
    replication_policy: {}
  });
}

function createMemoryStore(): ObjectStore {
  const objects = new Map<string, DistributedObject>();
  return {
    put: async (object) => { objects.set(object.object_id, object); },
    get: async (objectId) => objects.get(objectId) ?? null,
    delete: async (objectId) => { objects.delete(objectId); },
    query: async () => [...objects.values()]
  };
}

describe('distributed object foundation', () => {
  it('creates and validates objects through the existing P-256 identity implementation', async () => {
    const keys = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(keys.publicKey);
    const privateKey = await exportPrivateKey(keys.privateKey);
    const identity = createObjectIdentity({ id: 'node-1', publicKey, privateKey });
    const content = {
      object_type: 'example',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'hello' },
      replication_policy: {}
    } as const;

    const object = await createSignedObject(content, identity);
    expect(object.author).toBe(publicKey);
    expect(object.object_id).toBe(await calculateObjectId({ ...content, author: publicKey }));
    expect(await validateObject(object, identity)).toBe(true);
    expect(await validateObject({ ...object, payload: { value: 'changed' } }, identity)).toBe(false);
    expect(await validateObject({ ...object, object_id: '0'.repeat(64) }, identity)).toBe(false);
    expect(await validateObject({ ...object, signature: 'invalid' }, identity)).toBe(false);
    expect((await createSignedObject(content, identity)).object_id).toBe(object.object_id);
  });

  it('canonicalizes content and IDs independently of signatures', async () => {
    const base: ImmutableObjectContent = {
      object_type: 'example',
      author: 'author-key',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { z: 2, nested: { b: true, a: 'value' }, a: 1 },
      replication_policy: { replication_budget: 2 }
    };
    const reordered = {
      replication_policy: { replication_budget: 2 },
      payload: { a: 1, nested: { a: 'value', b: true }, z: 2 },
      created_at: base.created_at,
      author: base.author,
      object_type: base.object_type
    };

    expect(canonicalizeObjectContent(base)).toBe(canonicalizeObjectContent(reordered));
    const firstId = await calculateObjectId(base);
    expect(firstId).toBe(await calculateObjectId(reordered));
    expect(firstId).toMatch(/^[0-9a-f]{64}$/);
    expect(await calculateObjectId({ ...base, payload: { ...base.payload as Record<string, unknown>, changed: true } })).not.toBe(firstId);
    expect(await calculateObjectId({ ...base, signature: 'different-signature' } as DistributedObject)).toBe(firstId);
    expect(await validateDistributedObject({ ...await createFixtureObject(base), object_id: '0'.repeat(64) })).toBe(false);
  });

  it('validates signed objects and rejects malformed or incorrectly signed objects', async () => {
    const object = await createFixtureObject({
      object_type: 'example',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { message: 'hello' },
      replication_policy: {}
    });

    expect(await validateDistributedObject(object)).toBe(true);
    expect(await validateDistributedObject({ ...object, signature: 'invalid' })).toBe(false);
    expect(await validateDistributedObject({ ...object, object_id: 'invalid' })).toBe(false);
    expect(await validateDistributedObject({ ...object, payload: { message: 'changed' } })).toBe(false);
    const objectWithUnsupportedPayload = await createSignedObjectWithPayload({ unsupported: new Date() });
    expect(await validateDistributedObject(objectWithUnsupportedPayload)).toBe(false);
  });

  it('stores, deduplicates, queries, and deletes objects locally', async () => {
    const object = await createFixtureObject({
      object_type: 'example',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { message: 'stored' },
      replication_policy: {}
    });
    const store = new IndexedDbObjectStore();

    await store.put(object);
    await store.put(object);
    expect(await store.get(object.object_id)).toEqual(object);
    expect(await store.query({ object_type: 'example' })).toEqual([object]);
    await expect(store.put({ ...object, signature: 'invalid' })).rejects.toThrow('Invalid distributed object');
    await store.delete(object.object_id);
    expect(await store.get(object.object_id)).toBeNull();
  });

  it('delivers a generic object through the transport adapter and stores it at the receiver', async () => {
    const object = await createFixtureObject({
      object_type: 'transport-test',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'sent' },
      replication_policy: {}
    });
    const packet = await buildObjectStorePacket('peer-a', 'peer-b', object);
    const sentPackets: ObjectPacket[] = [];
    const manager = {
      isDataChannelOpen: () => true,
      sendObjectPacket: (sent: ObjectPacket) => sentPackets.push(sent)
    };
    const transport = new PeerConnectionObjectTransport(() => ({ 'peer-b': manager } as any));
    const store = new IndexedDbObjectStore();
    let resolveReceived: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    transport.onPacket((peerId, received) => {
      expect(peerId).toBe('peer-a');
      void receiveObjectPacket(received, store).then(() => resolveReceived?.());
    });

    await transport.send('peer-b', packet);
    await transport.send('peer-b', packet);
    expect(sentPackets).toEqual([packet, packet]);
    transport.handlePacket('peer-a', sentPackets[0]);
    transport.handlePacket('peer-a', sentPackets[1]);
    await received;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.get(object.object_id)).toEqual(object);
    expect(await store.query({ object_id: object.object_id })).toEqual([object]);
    expect(transport.connectedPeers()).toEqual(['peer-b']);
  });

  it('rejects malformed and tampered object packets without storing them', async () => {
    const object = await createFixtureObject({
      object_type: 'transport-test',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'original' },
      replication_policy: {}
    });
    const packet = await buildObjectStorePacket('peer-a', 'peer-b', object);
    const store = new IndexedDbObjectStore();

    expect(await receiveObjectPacket({ ...packet, payload: {} }, store)).toBe(false);
    expect(await receiveObjectPacket({ ...packet, payload: { object: { ...object, payload: { value: 'changed' } } } }, store)).toBe(false);
    expect(await receiveObjectPacket({ ...packet, payload: { object: { ...object, signature: 'invalid' } } }, store)).toBe(false);
    expect(await receiveObjectPacket({ ...packet, payload: { object: { ...object, object_id: '0'.repeat(64) } } }, store)).toBe(false);
    expect(await store.get(object.object_id)).toBeNull();
  });

  it('finds an object on a connected peer, validates it, and stores it locally', async () => {
    const object = await createFixtureObject({
      object_type: 'find-test',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'remote' },
      replication_policy: {}
    });
    const remoteStore = createMemoryStore();
    const localStore = createMemoryStore();
    await remoteStore.put(object);
    const handlers = new Set<(peerId: string, packet: ObjectPacket) => void>();
    const transport = {
      connectedPeers: () => ['peer-b'],
      onPacket: (handler: (peerId: string, packet: ObjectPacket) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      send: async (_peerId: string, packet: ObjectPacket) => {
        if (packet.type !== 'FIND') return;
        await respondToFindPacket(packet, remoteStore, async (response) => {
          handlers.forEach((handler) => handler('peer-b', response));
        }, 'peer-b');
      }
    };

    await expect(findObject('peer-a', 'peer-b', object.object_id, transport, localStore)).resolves.toEqual(object);
    expect(await localStore.get(object.object_id)).toEqual(object);
  });

  it('returns null when a connected peer does not have the requested object', async () => {
    const localStore = createMemoryStore();
    const remoteStore = createMemoryStore();
    const handlers = new Set<(peerId: string, packet: ObjectPacket) => void>();
    const transport = {
      connectedPeers: () => ['peer-b'],
      onPacket: (handler: (peerId: string, packet: ObjectPacket) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      send: async (_peerId: string, packet: ObjectPacket) => {
        if (packet.type !== 'FIND') return;
        const response = await buildFindResponsePacket('peer-b', 'peer-a', packet.payload.object_id);
        handlers.forEach((handler) => handler('peer-b', response));
      }
    };

    await expect(findObject('peer-a', 'peer-b', 'f'.repeat(64), transport, localStore)).resolves.toBeNull();
    expect(await localStore.query()).toEqual([]);
  });
});