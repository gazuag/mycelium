import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair
} from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createDeleteRequest, acceptDeleteRequest } from './deletion';
import { createSignedObject, isObjectExpired, validateDistributedObject } from './envelope';
import { IndexedDbObjectStore } from './local-store';
import { buildFindResponsePacket, receiveAndReplicate, receiveFindResponsePacket } from './transport';
import type { DistributedObject, ObjectIdentity, ObjectTransport } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-10-05T12:00:00.000Z');

async function createIdentity(id: string): Promise<ObjectIdentity> {
  const pair = await generateIdentityKeyPair();
  return createObjectIdentity({
    id,
    publicKey: await exportPublicKey(pair.publicKey),
    privateKey: await exportPrivateKey(pair.privateKey)
  });
}

async function createPost(
  identity: ObjectIdentity,
  content: string,
  createdAt = NOW.toISOString()
): Promise<DistributedObject> {
  return createSignedObject({
    object_type: 'mycelium.post',
    created_at: createdAt,
    payload: { content },
    replication_policy: {}
  }, identity);
}

describe('decentralized deletion', () => {
  it('allows the verified author to delete their own object and removes it from storage', async () => {
    const author = await createIdentity('deletion-author');
    const store = new IndexedDbObjectStore();
    const target = await createPost(author, 'owned post');
    const request = await createDeleteRequest(target, author, () => NOW);

    expect(await store.put(target)).toBe(true);
    expect(await acceptDeleteRequest(request, store, NOW)).toBe(true);
    expect(await store.get(target.object_id)).toBeNull();
    expect(await store.getDeletionTombstone(target.object_id)).toMatchObject({
      target_object_id: target.object_id,
      target_author: author.publicKey,
      delete_request_id: request.object_id
    });
    expect(JSON.stringify(await store.getDeletionTombstone(target.object_id)))
      .not.toContain('owned post');
  });

  it("rejects a correctly signed request from another peer and rejects an invalid signature", async () => {
    const author = await createIdentity('deletion-owner');
    const attacker = await createIdentity('deletion-attacker');
    const store = new IndexedDbObjectStore();
    const target = await createPost(author, 'private target');
    const ownerRequest = await createDeleteRequest(target, author, () => NOW);

    await expect(createDeleteRequest(target, attacker, () => NOW))
      .rejects.toThrow('Only the verified author can delete this object');

    const forgedRequest = await createSignedObject({
      object_type: 'mycelium.delete-request',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      payload: {
        ...(ownerRequest.payload as Record<string, string>),
        target_object_id: target.object_id
      },
      replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
    }, attacker);
    expect(await validateDistributedObject(forgedRequest)).toBe(true);
    expect(await acceptDeleteRequest(forgedRequest, store, NOW)).toBe(false);

    const invalidSignature = { ...ownerRequest, signature: 'not-a-valid-signature' };
    expect(await acceptDeleteRequest(invalidSignature, store, NOW)).toBe(false);
    expect(await store.getDeletionTombstone(target.object_id)).toBeNull();
  });

  it('deletes an already stored target and blocks a target that arrives after its request', async () => {
    const author = await createIdentity('deletion-order-author');
    const store = new IndexedDbObjectStore();
    const targetBefore = await createPost(author, 'arrives first');
    const deleteAfter = await createDeleteRequest(targetBefore, author, () => NOW);

    expect(await store.put(targetBefore)).toBe(true);
    expect(await acceptDeleteRequest(deleteAfter, store, NOW)).toBe(true);
    expect(await store.get(targetBefore.object_id)).toBeNull();

    const targetAfter = await createPost(author, 'arrives later');
    const deleteBefore = await createDeleteRequest(targetAfter, author, () => NOW);
    expect(await acceptDeleteRequest(deleteBefore, store, NOW)).toBe(true);
    expect(await store.put(targetAfter)).toBe(false);
    expect(await store.get(targetAfter.object_id)).toBeNull();
  });

  it('applies a valid Delete Request received as a FIND response', async () => {
    const author = await createIdentity('deletion-find-author');
    const store = new IndexedDbObjectStore();
    const createdAt = new Date();
    const target = await createPost(author, 'found through synchronization', createdAt.toISOString());
    const request = await createDeleteRequest(target, author, () => createdAt);
    const packet = await buildFindResponsePacket(
      'deletion-peer',
      'local-peer',
      request.object_id,
      'deletion-find-request',
      request
    );

    expect(await receiveFindResponsePacket(packet, store, 'deletion-find-request')).toEqual(request);
    expect(await store.getDeletionTombstone(target.object_id)).not.toBeNull();
  });

  it('deduplicates the same request, propagates new requests through generic replication, and retains tombstones after request expiry', async () => {
    const author = await createIdentity('deletion-propagation-author');
    const store = new IndexedDbObjectStore();
    const createdAt = new Date();
    const target = await createPost(author, 'network target', createdAt.toISOString());
    const request = await createDeleteRequest(target, author, () => createdAt);
    const sentTo: string[] = [];
    const transport: ObjectTransport = {
      connectedPeers: () => ['source-peer', 'peer-one', 'peer-two'],
      send: async (peerId) => { sentTo.push(peerId); },
      onPacket: () => () => {}
    };

    expect(await receiveAndReplicate(request, 'source-peer', store, transport, 'local-peer')).toBe(true);
    expect(sentTo).toEqual(['peer-one', 'peer-two']);
    expect(await receiveAndReplicate(request, 'source-peer', store, transport, 'local-peer')).toBe(false);
    expect(sentTo).toEqual(['peer-one', 'peer-two']);
    expect(await acceptDeleteRequest(request, store, createdAt)).toBe(false);
    expect((await store.queryDeletionTombstones())
      .filter((tombstone) => tombstone.target_object_id === target.object_id)).toHaveLength(1);
    expect(await store.query({ object_type: 'mycelium.delete-request' })).toContainEqual(request);

    const afterPropagation = new Date(Date.parse(request.expires_at!) + 1);
    expect(isObjectExpired(request, afterPropagation)).toBe(true);
    expect(await store.getDeletionTombstone(target.object_id)).not.toBeNull();
    expect(await store.put(target)).toBe(false);

    await store.collectDeletionTombstones(new Date(afterPropagation.getTime() + 29 * 24 * 60 * 60 * 1000));
    expect(await store.getDeletionTombstone(target.object_id)).not.toBeNull();
    expect(await store.collectDeletionTombstones(new Date(afterPropagation.getTime() + 31 * 24 * 60 * 60 * 1000)))
      .toBeGreaterThanOrEqual(1);
    expect(await store.getDeletionTombstone(target.object_id)).toBeNull();
  });
});
