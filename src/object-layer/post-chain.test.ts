import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createSignedObject } from './envelope';
import { ensurePostChainCached, expandObjectsWithPostChains } from './post-ancestry';
import { receiveBatchAndReplicate, sendObjectBatches } from './transport';
import type { DistributedObject, ObjectContent, ObjectStore, ObjectTransport } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const identityPromise = (async () => {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  return createObjectIdentity({ id: 'peer-a', publicKey, privateKey });
})();

async function makePost(content: string, parentId?: string): Promise<DistributedObject> {
  const identity = await identityPromise;
  const payload = {
    content,
    ...(parentId === undefined ? {} : { reply_to: parentId })
  };
  return await createSignedObject({
    object_type: 'mycelium.post',
    created_at: new Date('2026-10-01T00:00:00.000Z').toISOString(),
    payload,
    replication_policy: {}
  } as ObjectContent, identity);
}

function createMemoryStore(initial: DistributedObject[] = []): ObjectStore {
  const objects = new Map(initial.map((object) => [object.object_id, object]));
  return {
    put: async (object) => {
      const isNew = !objects.has(object.object_id);
      objects.set(object.object_id, object);
      return isNew;
    },
    get: async (objectId) => objects.get(objectId) ?? null,
    delete: async (objectId) => { objects.delete(objectId); },
    query: async () => [...objects.values()]
  };
}

function createTransport(peers: string[] = ['peer-b', 'peer-d']) {
  const sent: Array<{ peerId: string; packet: Parameters<ObjectTransport['send']>[1] }> = [];
  const transport: ObjectTransport = {
    connectedPeers: () => peers,
    send: async (peerId, packet) => { sent.push({ peerId, packet }); },
    onPacket: () => () => {}
  };
  return { transport, sent };
}

describe('post ancestor caching and transfer', () => {
  it('accepts cached parent and grandparent objects without FIND and returns root-first order', async () => {
    const root = await makePost('root');
    const parent = await makePost('parent', root.object_id);
    const reply = await makePost('reply', parent.object_id);
    const resolve = vi.fn(async () => null);

    const result = await ensurePostChainCached(reply, createMemoryStore([root, parent, reply]), resolve);

    expect(result.complete).toBe(true);
    expect(result.objects.map((object) => object.object_id)).toEqual([root.object_id, parent.object_id, reply.object_id]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('retrieves a missing parent through another reachable peer and continues to the root', async () => {
    const root = await makePost('root');
    const parent = await makePost('parent', root.object_id);
    const reply = await makePost('reply', parent.object_id);
    const peerBObjects = new Map([[parent.object_id, parent], [root.object_id, root]]);
    const store = createMemoryStore([reply]);
    const findFromPeerB = vi.fn(async (objectId: string) => peerBObjects.get(objectId) ?? null);

    const result = await ensurePostChainCached(reply, store, findFromPeerB);

    expect(findFromPeerB).toHaveBeenCalledWith(parent.object_id);
    expect(findFromPeerB).toHaveBeenCalledWith(root.object_id);
    expect(result.complete).toBe(true);
    expect(result.objects.map((object) => object.object_id)).toEqual([root.object_id, parent.object_id, reply.object_id]);
    expect(await store.get(root.object_id)).toEqual(root);
    expect(await store.get(parent.object_id)).toEqual(parent);
  });

  it('reports a missing parent and preserves the valid partial chain for recovery', async () => {
    const reply = await makePost('reply', 'a'.repeat(64));
    const result = await ensurePostChainCached(reply, createMemoryStore([reply]), async () => null);

    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe('missing');
    expect(result.missingObjectId).toBe('a'.repeat(64));
    expect(result.objects.map((object) => object.object_id)).toEqual([reply.object_id]);
  });

  it('rejects malformed references, mismatched IDs, and invalid signatures without caching them', async () => {
    const malformed = await makePost('malformed', 'not-an-id');
    const malformedResult = await ensurePostChainCached(malformed, createMemoryStore(), async () => null);
    expect(malformedResult.stopReason).toBe('malformed-parent');

    const reply = await makePost('reply', 'c'.repeat(64));
    const wrongObject = await makePost('wrong-id');
    const mismatch = await ensurePostChainCached(reply, createMemoryStore([reply]), async () => wrongObject);
    expect(mismatch.stopReason).toBe('object-id-mismatch');

    const invalidSignature = { ...await makePost('invalid'), signature: 'invalid' };
    const invalidParentReply = await makePost('child', invalidSignature.object_id);
    const invalidParent = await ensurePostChainCached(
      invalidParentReply,
      createMemoryStore([invalidParentReply]),
      async () => invalidSignature
    );
    expect(invalidParent.stopReason).toBe('invalid-object');
    expect(invalidParent.objects.map((object) => object.object_id)).toEqual([invalidParentReply.object_id]);
  });

  it('stops at the configured depth limit while retaining every validated object reached', async () => {
    const root = await makePost('root');
    const parent = await makePost('parent', root.object_id);
    const reply = await makePost('reply', parent.object_id);
    const objects = new Map([[root.object_id, root], [parent.object_id, parent]]);

    const result = await ensurePostChainCached(reply, createMemoryStore([reply]), async (id) => objects.get(id) ?? null, 1);

    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe('depth-limit');
    expect(result.objects.map((object) => object.object_id)).toEqual([parent.object_id, reply.object_id]);
  });

  it('deduplicates shared ancestors when expanding multiple replies and keeps ancestors before replies', async () => {
    const root = await makePost('root');
    const firstReply = await makePost('first reply', root.object_id);
    const secondReply = await makePost('second reply', root.object_id);
    const store = createMemoryStore([root]);
    const expanded = await expandObjectsWithPostChains(
      [firstReply, secondReply],
      store,
      async () => null
    );

    expect(expanded.objects.map((object) => object.object_id)).toEqual([
      root.object_id,
      firstReply.object_id,
      secondReply.object_id
    ]);
    expect(new Set(expanded.objects.map((object) => object.object_id)).size).toBe(3);
  });

  it('sends push batches root-first and deduplicates repeated canonical objects', async () => {
    const root = await makePost('root');
    const parent = await makePost('parent', root.object_id);
    const reply = await makePost('reply', parent.object_id);
    const { transport, sent } = createTransport(['follower']);

    const count = await sendObjectBatches(
      'peer-a',
      'follower',
      [root, parent, reply, parent],
      transport
    );

    expect(count).toBe(3);
    expect(sent.map(({ packet }) => packet.type)).toEqual(['OBJECT_BATCH']);
    expect(sent[0]?.packet.type === 'OBJECT_BATCH' ? sent[0].packet.payload.objects.map((object) => object.object_id) : [])
      .toEqual([root.object_id, parent.object_id, reply.object_id]);
  });

  it('expands pull pages and attaches cursor metadata only to the final bounded batch', async () => {
    const root = await makePost('root');
    const parent = await makePost('parent', root.object_id);
    const reply = await makePost('reply', parent.object_id);
    const manyPosts = await Promise.all(Array.from({ length: 49 }, (_, index) => makePost(`unrelated-${index}`)));
    const expanded = await expandObjectsWithPostChains(
      [...manyPosts, reply],
      createMemoryStore([root, parent]),
      async () => null
    );
    const { transport, sent } = createTransport(['pulling-peer']);
    const page = { request_id: 'request-1', next_cursor: null, has_more: false };

    await sendObjectBatches('peer-a', 'pulling-peer', expanded.objects, transport, undefined, page);

    expect(sent.length).toBe(2);
    expect(sent[0]?.packet.type === 'OBJECT_BATCH' ? sent[0].packet.payload.objects : []).toHaveLength(50);
    expect(sent[0]?.packet.type === 'OBJECT_BATCH' ? sent[0].packet.payload.page : undefined).toBeUndefined();
    expect(sent[1]?.packet.type === 'OBJECT_BATCH' ? sent[1].packet.payload.page : undefined).toEqual(page);
    const transferredIds = sent.flatMap(({ packet }) => packet.type === 'OBJECT_BATCH'
      ? packet.payload.objects.map((object) => object.object_id)
      : []);
    expect(transferredIds.indexOf(root.object_id)).toBeLessThan(transferredIds.indexOf(parent.object_id));
    expect(transferredIds.indexOf(parent.object_id)).toBeLessThan(transferredIds.indexOf(reply.object_id));
  });

  it('replicates retrieved ancestors and keeps duplicate batch deliveries idempotent', async () => {
    const root = await makePost('root');
    const reply = await makePost('reply', root.object_id);
    const store = createMemoryStore();
    const { transport, sent } = createTransport(['peer-b']);
    const resolve = vi.fn(async (objectId: string) => objectId === root.object_id ? root : null);

    await receiveBatchAndReplicate([reply], 'source-peer', store, transport, 'local-peer', undefined, () => {}, resolve);
    const firstTransferCount = sent.length;
    const storedReply = await store.get(reply.object_id);
    expect(storedReply).toEqual(reply);
    expect(await store.get(root.object_id)).toEqual(root);
    expect(sent.some(({ packet }) => packet.type === 'OBJECT_STORE' && packet.payload.object.object_id === root.object_id)).toBe(true);

    const duplicateFlags = await receiveBatchAndReplicate([reply], 'source-peer', store, transport, 'local-peer', undefined, () => {}, resolve);
    expect(duplicateFlags).toEqual([false]);
    expect(sent).toHaveLength(firstTransferCount);
    expect(await store.query()).toHaveLength(2);
  });

  it('retries ancestry recovery on duplicate delivery and replicates newly recovered ancestors only', async () => {
    const parent = await makePost('parent');
    const parentId = parent.object_id;
    const reply = await makePost('reply', parentId);
    const store = createMemoryStore();
    const { transport, sent } = createTransport(['peer-b']);
    let parentAvailable = false;
    const resolve = vi.fn(async (objectId: string) => (
      parentAvailable && objectId === parentId ? parent : null
    ));

    await receiveBatchAndReplicate([reply], 'source-peer', store, transport, 'local-peer', undefined, () => {}, resolve);
    expect(await store.get(parentId)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);

    parentAvailable = true;
    const retryFlags = await receiveBatchAndReplicate([reply], 'source-peer', store, transport, 'local-peer', undefined, () => {}, resolve);

    expect(retryFlags).toEqual([false]);
    expect(await store.get(parentId)).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(sent.filter(({ packet }) => packet.type === 'OBJECT_STORE' && packet.payload.object.object_id === parentId)).toHaveLength(1);
    expect(sent.filter(({ packet }) => packet.type === 'OBJECT_STORE' && packet.payload.object.object_id === reply.object_id)).toHaveLength(1);
  });

  it('returns original posts as complete one-object chains and leaves retrieval failures explicit', async () => {
    const root = await makePost('root');
    const result = await ensurePostChainCached(root, createMemoryStore(), async () => null);

    expect(result.complete).toBe(true);
    expect(result.stopReason).toBe('no-parent');
    expect(result.objects).toEqual([root]);

    const reply = await makePost('reply', 'd'.repeat(64));
    const retrievalError = await ensurePostChainCached(
      reply,
      createMemoryStore([reply]),
      async () => { throw new Error('peer unavailable'); }
    );
    expect(retrievalError.stopReason).toBe('retrieval-failed');
    expect(retrievalError.error).toBe('peer unavailable');
  });
});
