import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair, signString } from '../crypto/identity';
import { canonicalizeObjectContent, calculateObjectId, createSignedObject, validateObject, validateDistributedObject, type ImmutableObjectContent } from './envelope';
import { createObjectIdentity } from './identity';
import { IndexedDbObjectStore } from './local-store';
import { buildFindPacket, buildFindResponseObjectsPacket, buildFindResponsePacket, buildObjectStorePacket, buildTimeRangeFindPacket, DEFAULT_REPLICATION_BUDGET, filterObjectsByFindQuery, findObject, FindAggregation, getFindObjectIds, getReplicationBudget, receiveObjectPacket, replicateObject, respondToFindPacket, selectFindPeers, shouldRetainFindRequestRoute, validateFindResponseObjects } from './transport';
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
        }, 'peer-b', new Map());
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
        const response = await buildFindResponsePacket('peer-b', 'peer-a', packet.payload.object_id, packet.payload.requestId);
        handlers.forEach((handler) => handler('peer-b', response));
      }
    };

    await expect(findObject('peer-a', 'peer-b', 'f'.repeat(64), transport, localStore)).resolves.toBeNull();
    expect(await localStore.query()).toEqual([]);
  });

  it('accepts a valid future request deadline and keeps the deadline unchanged across forwarding', async () => {
    const object = await createFixtureObject({
      object_type: 'deadline-valid',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'ok' },
      replication_policy: {}
    });
    const store = createMemoryStore();
    const cache = new Map<string, number>();
    const sent: Array<{ packet: any }> = [];
    const originalDeadline = new Date(Date.now() + 30000).toISOString();
    const packet = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'deadline-valid', 2, 'peer-a', originalDeadline);
    const result = await respondToFindPacket(packet, store, async (response) => {
      sent.push({ packet: response });
    }, 'peer-b', cache, async (request) => {
      sent.push({ packet: request });
    });
    expect(result).toBe(true);
    expect(packet.payload.expiresAt).toBe(originalDeadline);
    if (sent[0]?.packet?.expiresAt) {
      expect(sent[0].packet.expiresAt).toBe(originalDeadline);
    }
  });

  it('rejects an already-expired request before lookup or forwarding', async () => {
    const object = await createFixtureObject({
      object_type: 'deadline-expired',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'expired' },
      replication_policy: {}
    });
    const store = createMemoryStore();
    await store.put(object);
    const sent = vi.fn(async () => undefined);
    const cache = new Map<string, number>();
    const packet = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'deadline-expired', 3, 'peer-a', new Date(Date.now() - 1000).toISOString());

    expect(await respondToFindPacket(packet, store, sent, 'peer-b', cache, async () => undefined)).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(cache.has('deadline-expired')).toBe(false);
  });

  it('stops a request whose deadline expires while forwarding', async () => {
    vi.useFakeTimers();
    const object = await createFixtureObject({
      object_type: 'deadline-midflight',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'midflight' },
      replication_policy: {}
    });
    const store = createMemoryStore();
    await store.put(object);
    const cache = new Map<string, number>();
    const forwarded = vi.fn(async () => undefined);
    const packet = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'deadline-midflight', 2, 'peer-a', new Date(Date.now() + 1000).toISOString());

    vi.advanceTimersByTime(2000);
    expect(await respondToFindPacket(packet, store, async () => undefined, 'peer-b', cache, forwarded)).toBe(false);
    expect(forwarded).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('treats TTL and request deadline as independent limits', async () => {
    const object = await createFixtureObject({
      object_type: 'deadline-vs-ttl',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'ttl-check' },
      replication_policy: {}
    });
    const store = createMemoryStore();
    await store.put(object);
    const cache = new Map<string, number>();
    const forwarded = vi.fn(async () => undefined);
    const packet = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'deadline-vs-ttl', 0, 'peer-a', new Date(Date.now() + 60000).toISOString());

    expect(await respondToFindPacket(packet, store, async () => undefined, 'peer-b', cache, forwarded)).toBe(true);
    expect(forwarded).not.toHaveBeenCalled();
    expect(packet.payload.ttl).toBe(0);
    expect(new Date(packet.payload.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('removes expired request state from dedup and route caches', async () => {
    vi.useFakeTimers();
    const cache = new Map<string, number>();
    const route = new Map<string, { upstreamPeer: string; expiresAt: number }>();
    const now = Date.now();
    cache.set('expired-request', now - 1);
    route.set('expired-request', { upstreamPeer: 'peer-a', expiresAt: now - 1 });

    for (const [requestId, expiresAt] of cache.entries()) {
      if (expiresAt <= now) cache.delete(requestId);
    }
    for (const [requestId, routeEntry] of route.entries()) {
      if (routeEntry.expiresAt <= now) route.delete(requestId);
    }

    expect(cache.has('expired-request')).toBe(false);
    expect(route.has('expired-request')).toBe(false);
    vi.useRealTimers();
  });

  it('does not leave unbounded request state behind when forwarding fails', async () => {
    const cache = new Map<string, number>();
    const route = new Map<string, { upstreamPeer: string; expiresAt: number }>();
    const requestId = 'failed-forward-request';

    cache.set(requestId, Date.now() + 5000);
    route.set(requestId, { upstreamPeer: 'peer-a', expiresAt: Date.now() + 5000 });

    try {
      throw new Error('forward failed');
    } catch {
      cache.delete(requestId);
      route.delete(requestId);
    }

    expect(cache.has(requestId)).toBe(false);
    expect(route.has(requestId)).toBe(false);
  });

  it('correlates FIND responses by request ID and gives each request a unique ID', async () => {
    const first = await buildFindPacket('peer-a', 'peer-b', 'a'.repeat(64));
    const second = await buildFindPacket('peer-a', 'peer-b', 'a'.repeat(64));
    expect(first.payload.requestId).not.toBe(second.payload.requestId);
    expect(first.payload.ttl).toBe(1);
    expect((await buildFindResponsePacket('peer-b', 'peer-a', first.payload.object_id, first.payload.requestId)).payload.requestId).toBe(first.payload.requestId);
  });

  it('performs a final local lookup at FIND TTL zero but never forwards', async () => {
    const object = await createFixtureObject({ object_type: 'ttl-zero', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 'final-hop' }, replication_policy: {} });
    const lookup = vi.fn(async () => object);
    const send = vi.fn(async (_response: ObjectPacket) => undefined);
    const forward = vi.fn(async () => undefined);
    const store = { get: lookup } as unknown as ObjectStore;
    const packet = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'ttl-zero-final-lookup', 0, 'peer-a');

    expect(await respondToFindPacket(packet, store, send, 'peer-b', new Map(), forward)).toBe(true);
    expect(lookup).toHaveBeenCalledWith(object.object_id);
    expect(forward).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    const response = send.mock.calls[0][0];
    expect(response.type).toBe('FIND_RESPONSE');
    if (response.type === 'FIND_RESPONSE') {
      expect(response.payload.object).toEqual(object);
    }
  });

  it('deduplicates the same request ID, even when a later copy asks for another object', async () => {
    const firstObject = await createFixtureObject({ object_type: 'find-test', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 1 }, replication_policy: {} });
    const secondObject = await createFixtureObject({ object_type: 'find-test', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 2 }, replication_policy: {} });
    const cache = new Map<string, number>();
    const store = createMemoryStore();
    await store.put(firstObject);
    await store.put(secondObject);
    const send = vi.fn(async () => undefined);
    const firstPacket = await buildFindPacket('peer-a', 'peer-b', firstObject.object_id);
    const secondPacket = { ...firstPacket, payload: { ...firstPacket.payload, object_id: secondObject.object_id } };

    expect(await respondToFindPacket(firstPacket, store, send, 'peer-b', cache)).toBe(true);
    expect(await respondToFindPacket(secondPacket, store, send, 'peer-b', cache)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows different request IDs for the same object and rejects an expired request after cleanup', async () => {
    vi.useFakeTimers();
    const object = await createFixtureObject({ object_type: 'find-test', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 1 }, replication_policy: {} });
    const store = createMemoryStore();
    await store.put(object);
    const cache = new Map<string, number>();
    const send = vi.fn(async () => undefined);
    const first = await buildFindPacket('peer-a', 'peer-b', object.object_id);
    const second = await buildFindPacket('peer-a', 'peer-b', object.object_id);

    await respondToFindPacket(first, store, send, 'peer-b', cache);
    await respondToFindPacket(second, store, send, 'peer-b', cache);
    expect(send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.parse(first.payload.expiresAt) + 1);
    expect(await respondToFindPacket(first, store, send, 'peer-b', cache)).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('ignores a response with an unknown request ID and expires the pending FIND', async () => {
    vi.useFakeTimers();
    const store = createMemoryStore();
    const handlers = new Set<(peerId: string, packet: ObjectPacket) => void>();
    const transport = {
      connectedPeers: () => ['peer-b'],
      onPacket: (handler: (peerId: string, packet: ObjectPacket) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      send: async (_peerId: string, packet: ObjectPacket) => {
        if (packet.type !== 'FIND') return;
        const response = await buildFindResponsePacket('peer-b', 'peer-a', packet.payload.object_id, 'unknown-request');
        handlers.forEach((handler) => handler('peer-b', response));
      }
    };

    const result = findObject('peer-a', 'peer-b', 'f'.repeat(64), transport, store);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBeNull();
    expect(await store.query()).toEqual([]);
    vi.useRealTimers();
  });

  it('forwards a FIND recursively while preserving the original request ID and origin', async () => {
    const object = await createFixtureObject({
      object_type: 'recursive-find',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'found-at-c' },
      replication_policy: {}
    });
    const bStore = createMemoryStore();
    const cStore = createMemoryStore();
    await cStore.put(object);
    const bCache = new Map<string, number>();
    const cCache = new Map<string, number>();
    const forwarded: Array<{ objectId: string; requestId: string; ttl: number; fromPeer: string; origin: string }> = [];

    const requestId = 'recursive-request-1';
    const requestPacket = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, requestId, 2, 'peer-a');

    expect(await respondToFindPacket(requestPacket, bStore, async () => undefined, 'peer-b', bCache, async (request) => {
      forwarded.push(request);
    })).toBe(true);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].fromPeer).toBe('peer-a');
    expect(forwarded[0].requestId).toBe(requestId);
    expect(forwarded[0].ttl).toBe(1);
    expect(forwarded[0].origin).toBe('peer-a');

    const response = await buildFindResponsePacket('peer-c', 'peer-b', object.object_id, requestId, object, undefined, 'peer-a');
    const relayed = await buildFindResponsePacket('peer-b', 'peer-a', object.object_id, requestId, object, undefined, 'peer-a');
    expect(response.payload.requestId).toBe(requestId);
    expect(response.payload.origin).toBe('peer-a');
    expect(relayed.payload.requestId).toBe(requestId);
    expect(relayed.payload.origin).toBe('peer-a');
  });

  it('stops forwarding once TTL reaches zero and ignores duplicate forwarded requests', async () => {
    const object = await createFixtureObject({
      object_type: 'ttl-test',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'ttl' },
      replication_policy: {}
    });
    const store = createMemoryStore();
    await store.put(object);
    const cache = new Map<string, number>();
    const forwarded: Array<string> = [];

    const zeroTtlPacket = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'ttl-zero', 0, 'peer-a');
    expect(await respondToFindPacket(zeroTtlPacket, store, async () => undefined, 'peer-b', cache, async () => {
      forwarded.push('peer-c');
    })).toBe(true);
    expect(forwarded).toEqual([]);

    const duplicatePacket = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'ttl-dupe', 1, 'peer-a');
    await respondToFindPacket(duplicatePacket, store, async () => undefined, 'peer-b', cache, async () => {
      forwarded.push('peer-c');
    });
    expect(await respondToFindPacket({ ...duplicatePacket, payload: { ...duplicatePacket.payload, ttl: 1 } }, store, async () => undefined, 'peer-b', cache, async () => {
      forwarded.push('peer-c');
    })).toBe(false);
    expect(forwarded.length).toBeLessThanOrEqual(1);
  });

  it('does not route a forwarded request back toward the peer it arrived from', async () => {
    const object = await createFixtureObject({
      object_type: 'route-test',
      author: '',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { value: 'route' },
      replication_policy: {}
    });
    const store = createMemoryStore();
    const cache = new Map<string, number>();
    const attemptedPeers: string[] = [];

    const packet = await buildFindPacket('peer-a', 'peer-b', object.object_id, undefined, 'route-request', 2, 'peer-a');
    await respondToFindPacket(packet, store, async () => undefined, 'peer-b', cache, async (request) => {
      attemptedPeers.push(request.fromPeer);
    });

    expect(attemptedPeers).toEqual(['peer-a']);
    expect(attemptedPeers).not.toContain('peer-b');
  });

  it('routes a FIND_RESPONSE back along the request path without broadcasting to every peer', async () => {
    const requestId = 'reverse-request';
    const routeMap = new Map<string, { origin: string; upstreamPeer: string; expiresAt: number }>([
      [requestId, { origin: 'peer-a', upstreamPeer: 'peer-a', expiresAt: Date.now() + 5000 }]
    ]);

    const response = await buildFindResponsePacket('peer-c', 'peer-b', 'b'.repeat(64), requestId, undefined, undefined, 'peer-a');
    const forwardTo = routeMap.get(requestId)?.upstreamPeer;

    expect(forwardTo).toBe('peer-a');
    expect(Array.from(routeMap.keys())).toEqual([requestId]);
    expect(response.payload.requestId).toBe(requestId);
    expect(response.payload.object_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('constructs canonical multi-object FIND packets and parses legacy single-object packets', async () => {
    const objectIds = ['a'.repeat(64), 'b'.repeat(64)];
    const packet = await buildFindPacket('peer-a', 'peer-b', objectIds, undefined, 'multi-request');
    expect(packet.payload.requested_objects).toEqual(objectIds);
    expect(getFindObjectIds(packet)).toEqual(objectIds);
    const legacy = { ...packet, payload: { ...packet.payload, requested_objects: undefined as unknown as string[], object_id: objectIds[0] } };
    expect(getFindObjectIds(legacy)).toEqual([objectIds[0]]);
  });

  it('supports time-range author queries across multiple peers while preserving existing FIND(object_id) behavior', async () => {
    const peerBKeys = await generateIdentityKeyPair();
    const peerBAuthor = await exportPublicKey(peerBKeys.publicKey);
    const peerBIdentity = createObjectIdentity({ id: 'peer-b', publicKey: peerBAuthor, privateKey: await exportPrivateKey(peerBKeys.privateKey) });
    const peerXKeys = await generateIdentityKeyPair();
    const peerXAuthor = await exportPublicKey(peerXKeys.publicKey);
    const peerXIdentity = createObjectIdentity({ id: 'peer-x', publicKey: peerXAuthor, privateKey: await exportPrivateKey(peerXKeys.privateKey) });

    const inRangePeerA = await createSignedObject({ object_type: 'time-range-query', created_at: '2026-08-25T00:00:00.000Z', payload: { pair: 'a' }, replication_policy: {} }, peerBIdentity);
    const inRangePeerC = await createSignedObject({ object_type: 'time-range-query', created_at: '2026-08-25T00:05:00.000Z', payload: { pair: 'c' }, replication_policy: {} }, peerBIdentity);
    const outOfRange = await createSignedObject({ object_type: 'time-range-query', created_at: '2026-08-25T00:20:00.000Z', payload: { pair: 'out' }, replication_policy: {} }, peerBIdentity);
    const otherAuthor = await createSignedObject({ object_type: 'time-range-query', created_at: '2026-08-25T00:03:00.000Z', payload: { pair: 'other' }, replication_policy: {} }, peerXIdentity);

    const peerAStore = createMemoryStore();
    const peerCStore = createMemoryStore();
    const queryStore = createMemoryStore();
    await peerAStore.put(inRangePeerA);
    await peerAStore.put(outOfRange);
    await peerCStore.put(inRangePeerC);
    await peerCStore.put(outOfRange);
    await queryStore.put(otherAuthor);

    const queryPacket = await buildTimeRangeFindPacket(
      'peer-a',
      'peer-c',
      peerBAuthor,
      '2026-08-25T00:00:00.000Z',
      '2026-08-25T00:10:00.000Z',
      undefined,
      'time-range-request',
      1,
      'peer-a',
      new Date(Date.now() + 5000).toISOString(),
      [inRangePeerA.object_id, inRangePeerC.object_id]
    );

    const responseObjects = await validateFindResponseObjects(await buildFindResponseObjectsPacket(
      'peer-c',
      'peer-a',
      'time-range-request',
      [inRangePeerA, inRangePeerC, outOfRange],
      undefined,
      'peer-a'
    ), 'time-range-request', new Set([inRangePeerA.object_id, inRangePeerC.object_id]));

    expect(responseObjects.map((object) => object.object_id)).toEqual([inRangePeerA.object_id, inRangePeerC.object_id]);

    const aggregate = new FindAggregation([inRangePeerA.object_id, inRangePeerC.object_id], Date.now() + 5000, async () => undefined);
    aggregate.addChild('peer-a');
    aggregate.addChild('peer-c');
    await aggregate.addChildObjects('peer-a', [inRangePeerA]);
    await aggregate.addChildObjects('peer-c', [inRangePeerC, inRangePeerC]);
    expect(aggregate.aggregateSize()).toBe(2);
    expect(await filterObjectsByFindQuery(peerAStore, { author: peerBAuthor, created_after: '2026-08-25T00:00:00.000Z', created_before: '2026-08-25T00:10:00.000Z' })).toEqual([inRangePeerA]);
    expect(await filterObjectsByFindQuery(peerCStore, { author: peerBAuthor, created_after: '2026-08-25T00:00:00.000Z', created_before: '2026-08-25T00:10:00.000Z' })).toEqual([inRangePeerC]);
    expect(await filterObjectsByFindQuery(peerCStore, { author: peerBAuthor, created_after: '2026-08-25T00:05:00.000Z', created_before: '2026-08-25T00:05:00.000Z' })).toEqual([inRangePeerC]);

    let packetHandler: ((peerId: string, packet: ObjectPacket) => void) | null = null;
    const transport = {
      connectedPeers: () => ['peer-c'],
      onPacket: (handler: (peerId: string, packet: ObjectPacket) => void) => {
        packetHandler = handler;
        return () => { packetHandler = null; };
      },
      send: async (_peerId: string, packet: ObjectPacket) => {
        if (packet.type === 'FIND' && packetHandler) {
          const response = await buildFindResponsePacket('peer-c', 'peer-a', packet.payload.object_id, packet.payload.requestId, inRangePeerC, undefined, 'peer-a');
          packetHandler('peer-c', response);
        }
      }
    };

    await expect(findObject('peer-a', 'peer-c', inRangePeerC.object_id, transport, peerAStore)).resolves.toEqual(inRangePeerC);
    expect(queryPacket.payload.author).toBe(peerBAuthor);
    expect(queryPacket.payload.created_after).toBe('2026-08-25T00:00:00.000Z');
    expect(queryPacket.payload.created_before).toBe('2026-08-25T00:10:00.000Z');
    expect(responseObjects.some((object) => object.object_id === outOfRange.object_id)).toBe(false);
  });

  it('aggregates local and child results, deduplicating strictly by object ID', async () => {
    const first = await createFixtureObject({ object_type: 'aggregate', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 1 }, replication_policy: {} });
    const second = await createFixtureObject({ object_type: 'aggregate', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 2 }, replication_policy: {} });
    const third = await createFixtureObject({ object_type: 'aggregate', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 3 }, replication_policy: {} });
    const results: DistributedObject[][] = [];
    const aggregation = new FindAggregation([first.object_id, second.object_id, third.object_id], Date.now() + 5000, async (objects) => { results.push(objects); });
    aggregation.addChild('peer-c');
    aggregation.addChild('peer-d');
    aggregation.addLocal([first]);
    await aggregation.addChildObjects('peer-c', [first, second]);
    expect(results).toEqual([]);
    await aggregation.addChildObjects('peer-d', [second, third]);
    expect(results[0].map((object) => object.object_id)).toEqual([first.object_id, second.object_id, third.object_id]);
  });

  it('does not complete on the first partial child, but completes when all requested objects arrive', async () => {
    const ids = ['a'.repeat(64), 'b'.repeat(64)];
    const complete = vi.fn(async () => undefined);
    const aggregation = new FindAggregation(ids, Date.now() + 5000, complete);
    aggregation.addChild('peer-c');
    aggregation.addChild('peer-d');
    await aggregation.addChildObjects('peer-c', []);
    expect(complete).not.toHaveBeenCalled();
    await aggregation.addChildObjects('peer-d', []);
    expect(complete).toHaveBeenCalledWith([], 'all-children-responded-or-failed');
  });

  it('completes after the grace period, deadline, or child failure', async () => {
    vi.useFakeTimers();
    const graceComplete = vi.fn(async () => undefined);
    const grace = new FindAggregation(['a'.repeat(64)], Date.now() + 5000, graceComplete, 100);
    grace.addChild('peer-c');
    grace.startGracePeriod();
    await vi.advanceTimersByTimeAsync(100);
    expect(graceComplete).toHaveBeenCalledOnce();

    const deadlineComplete = vi.fn(async () => undefined);
    const deadline = new FindAggregation(['b'.repeat(64)], Date.now() + 100, deadlineComplete, 500);
    deadline.addChild('peer-c');
    deadline.startGracePeriod();
    await vi.advanceTimersByTimeAsync(100);
    expect(deadlineComplete).toHaveBeenCalledOnce();

    const failureComplete = vi.fn(async () => undefined);
    const failure = new FindAggregation(['c'.repeat(64)], Date.now() + 5000, failureComplete);
    failure.addChild('peer-c');
    failure.addChild('peer-d');
    await failure.failChild('peer-c');
    expect(failureComplete).not.toHaveBeenCalled();
    await failure.failChild('peer-d');
    expect(failureComplete).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('validates requested response objects and ignores invalid, unrequested, and late results', async () => {
    const valid = await createFixtureObject({ object_type: 'aggregate-validation', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 1 }, replication_policy: {} });
    const unrequested = await createFixtureObject({ object_type: 'aggregate-validation', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 2 }, replication_policy: {} });
    const response = await buildFindResponseObjectsPacket('peer-c', 'peer-b', 'validation-request', [valid, unrequested, { ...valid, signature: 'invalid' }]);
    const accepted = await validateFindResponseObjects(response, 'validation-request', new Set([valid.object_id]));
    expect(accepted).toEqual([valid]);

    const late = vi.fn(async () => undefined);
    const aggregation = new FindAggregation([valid.object_id], Date.now() + 5000, late);
    aggregation.addChild('peer-c');
    await aggregation.addChildObjects('peer-c', [valid]);
    await aggregation.addChildObjects('peer-c', [unrequested]);
    expect(late).toHaveBeenCalledOnce();
  });

  it('selects at most two forwarding children and excludes the incoming peer and itself', () => {
    expect(selectFindPeers(['peer-a', 'peer-b', 'peer-c', 'peer-d'], 'peer-a', 'peer-b')).toEqual(['peer-c', 'peer-d']);
  });

  it('keeps the upstream route until the final aggregate is sent', async () => {
    const object = await createFixtureObject({ object_type: 'aggregate-route', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value: 1 }, replication_policy: {} });
    const sent: ObjectPacket[] = [];
    const aggregation = new FindAggregation([object.object_id, 'b'.repeat(64)], Date.now() + 5000, async (objects) => {
      sent.push(await buildFindResponseObjectsPacket('peer-b', 'peer-a', 'route-aggregate', objects));
    });
    aggregation.addChild('peer-c');
    aggregation.addChild('peer-d');
    await aggregation.addChildObjects('peer-c', [object]);
    expect(sent).toHaveLength(0);
    await aggregation.addChildObjects('peer-d', []);
    expect(sent).toHaveLength(1);
    expect(sent[0].type === 'FIND_RESPONSE' && sent[0].payload.objects).toEqual([object]);
  });

  it('keeps relayed FIND routes alive while the request is still aggregating child responses', () => {
    const aggregation = new FindAggregation(['a'.repeat(64), 'b'.repeat(64)], Date.now() + 5000, async () => undefined);
    aggregation.addChild('peer-c');

    expect(shouldRetainFindRequestRoute('peer-c', { upstreamPeer: 'peer-a', expiresAt: Date.now() + 5000 }, { aggregation })).toBe(true);
    expect(shouldRetainFindRequestRoute('peer-a', { upstreamPeer: 'peer-a', expiresAt: Date.now() + 5000 }, undefined)).toBe(false);
  });

  it('returns partial results when four of five requested objects exist', async () => {
    const objects = await Promise.all([1, 2, 3, 4].map((value) => createFixtureObject({ object_type: 'partial-aggregate', author: '', created_at: '2026-08-25T00:00:00.000Z', payload: { value }, replication_policy: {} })));
    const missingId = 'f'.repeat(64);
    const returned: Array<{ objects: DistributedObject[]; reason: string }> = [];
    const aggregation = new FindAggregation(objects.map((object) => object.object_id).concat(missingId), Date.now() + 5000, async (found, reason) => {
      returned.push({ objects: found, reason });
    });
    aggregation.addChild('peer-c');
    aggregation.addChild('peer-d');
    await aggregation.addChildObjects('peer-c', objects.slice(0, 3));
    expect(returned).toHaveLength(0);
    await aggregation.addChildObjects('peer-d', [objects[3]]);
    expect(returned).toHaveLength(1);
    expect(returned[0].objects).toHaveLength(4);
    expect(returned[0].reason).toBe('all-children-responded-or-failed');
  });

  describe('Phase 8: replication budgets', () => {
    function createFakeTransport(peerIds: string[]) {
      const sent: Array<{ peerId: string; object: DistributedObject }> = [];
      const stores = new Map<string, ObjectStore>(peerIds.map((peerId) => [peerId, createMemoryStore()]));
      const transport = {
        connectedPeers: () => peerIds,
        onPacket: () => () => {},
        send: async (peerId: string, packet: ObjectPacket) => {
          if (packet.type !== 'OBJECT_STORE') return;
          const peerStore = stores.get(peerId);
          if (!peerStore) throw new Error(`unknown peer: ${peerId}`);
          await receiveObjectPacket(packet, peerStore);
          sent.push({ peerId, object: packet.payload.object });
        }
      };
      return { transport, stores, sent };
    }

    it('uses the object\'s explicit replication_budget as a target replica count, not a hop count', async () => {
      const object = await createFixtureObject({
        object_type: 'phase8-replication',
        author: '',
        created_at: '2026-08-25T00:00:00.000Z',
        payload: { value: 'budget-2' },
        replication_policy: { replication_budget: 2 }
      });
      const { transport, stores, sent } = createFakeTransport(['peer-b', 'peer-c', 'peer-d']);
      const logs: string[] = [];

      const result = await replicateObject('peer-a', object, transport, undefined, new Set(), (message) => logs.push(message));

      expect(getReplicationBudget(object)).toBe(2);
      expect(result.budget).toBe(2);
      // Bounded: exactly 2 peers were targeted even though 3 peers were connected (budget is a replica target, not a hop count).
      expect(result.stored).toHaveLength(2);
      expect(result.targeted).toEqual(result.stored);
      expect(await stores.get('peer-b')!.get(object.object_id)).toEqual(object);
      expect(await stores.get('peer-c')!.get(object.object_id)).toEqual(object);
      expect(await stores.get('peer-d')!.get(object.object_id)).toBeNull();
      expect(sent).toHaveLength(2);

      expect(logs.some((line) => line.includes(`REPLICATION considering object_id=${object.object_id} budget=2`))).toBe(true);
      expect(logs.some((line) => line.startsWith(`REPLICATION target selected object_id=${object.object_id} peer=peer-b`))).toBe(true);
      expect(logs.some((line) => line.startsWith(`REPLICATION target selected object_id=${object.object_id} peer=peer-c`))).toBe(true);
      expect(logs.some((line) => line.includes('REPLICATION budget reached') && line.includes('stopping'))).toBe(true);
      expect(logs.some((line) => line.includes('REPLICATION complete') && line.includes('newReplicas=2'))).toBe(true);
    });

    it('falls back to the default replication budget for objects without an explicit policy value', async () => {
      const object = await createFixtureObject({
        object_type: 'phase8-replication-default',
        author: '',
        created_at: '2026-08-25T00:00:00.000Z',
        payload: { value: 'no-explicit-budget' },
        replication_policy: {}
      });
      expect(getReplicationBudget(object)).toBe(DEFAULT_REPLICATION_BUDGET);

      const { transport, sent } = createFakeTransport(['peer-b']);
      const logs: string[] = [];
      const result = await replicateObject('peer-a', object, transport, undefined, new Set(), (message) => logs.push(message));

      expect(result.budget).toBe(DEFAULT_REPLICATION_BUDGET);
      expect(result.stored).toEqual(['peer-b']);
      expect(sent).toHaveLength(1);
      expect(logs.some((line) => line.includes('(defaulted)'))).toBe(true);
    });

    it('does not re-store a duplicate on a peer that already holds the object and stops once the target is met', async () => {
      const object = await createFixtureObject({
        object_type: 'phase8-replication-dedup',
        author: '',
        created_at: '2026-08-25T00:00:00.000Z',
        payload: { value: 'dedup' },
        replication_policy: { replication_budget: 1 }
      });
      const { transport, stores, sent } = createFakeTransport(['peer-b', 'peer-c']);

      const first = await replicateObject('peer-a', object, transport);
      expect(first.stored).toEqual(['peer-b']);
      expect(sent).toHaveLength(1);

      // Re-running with local knowledge that peer-b already holds a replica must not duplicate storage there,
      // and must recognize the budget is already satisfied without contacting any other peer.
      const logs: string[] = [];
      const second = await replicateObject('peer-a', object, transport, undefined, new Set(first.stored), (message) => logs.push(message));
      expect(second.stored).toHaveLength(0);
      expect(second.targeted).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(await stores.get('peer-c')!.get(object.object_id)).toBeNull();
      expect(logs.some((line) => line.includes('already satisfied') && line.includes('stopping'))).toBe(true);

      // A single peer's local store never ends up with more than one copy of the same object_id.
      const peerBObjects = (await stores.get('peer-b')!.query()).filter((stored) => stored.object_id === object.object_id);
      expect(peerBObjects).toHaveLength(1);
    });
  });
});