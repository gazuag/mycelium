import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair,
  signString
} from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createDeleteRequest, acceptDeleteRequest } from './deletion';
import {
  calculateAuthorBoundObjectId,
  calculateObjectId,
  canonicalizeObjectContent,
  createSignedObject,
  isObjectExpired,
  validateDistributedObject
} from './envelope';
import { canonicalize } from '../p2p/protocol';
import { IndexedDbObjectStore, IndexedDbOutboxStore } from './local-store';
import { createOutboxService } from './outbox-service';
import { buildFindResponsePacket, findObject, receiveAndReplicate, receiveFindResponsePacket } from './transport';
import type { DistributedObject, JsonValue, ObjectContent, ObjectIdentity, ObjectTransport } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-10-05T12:00:00.000Z');

async function createIdentity(id: string): Promise<ObjectIdentity & { privateKey: string }> {
  const pair = await generateIdentityKeyPair();
  const privateKey = await exportPrivateKey(pair.privateKey);
  return {
    ...createObjectIdentity({
      id,
      publicKey: await exportPublicKey(pair.publicKey),
      privateKey
    }),
    privateKey
  };
}

async function createLegacyPost(
  identity: ObjectIdentity & { privateKey: string },
  content: string
): Promise<DistributedObject> {
  const immutableContent = {
    object_type: 'mycelium.post',
    author: identity.publicKey,
    created_at: NOW.toISOString(),
    payload: { content },
    replication_policy: {}
  };
  const objectId = await calculateObjectId(immutableContent);
  return {
    ...immutableContent,
    object_id: objectId,
    signature: await signString(identity.privateKey, canonicalizeObjectContent(immutableContent))
  };
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

async function createV2Object(
  content: ObjectContent,
  identity: ObjectIdentity
): Promise<DistributedObject> {
  const immutableContent = { ...content, author: identity.publicKey };
  const contentHash = await calculateObjectId(immutableContent);
  const objectId = await calculateAuthorBoundObjectId(identity.publicKey, contentHash);
  return {
    ...immutableContent,
    object_id: objectId,
    object_id_version: 2,
    content_hash: contentHash,
    author_proof: await identity.sign(canonicalize({
      domain: 'mycelium.object-author-proof.v2',
      author: identity.publicKey,
      content_hash: contentHash
    })),
    signature: await identity.sign(canonicalizeObjectContent(immutableContent))
  };
}

async function createV2Post(
  identity: ObjectIdentity,
  content: string
): Promise<DistributedObject> {
  return createV2Object({
    object_type: 'mycelium.post',
    created_at: NOW.toISOString(),
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

  it('rejects a Delete Request whose signed propagation lifetime exceeds three days', async () => {
    const author = await createIdentity('deletion-long-ttl-author');
    const store = new IndexedDbObjectStore();
    const target = await createPost(author, 'long-lived request target');
    const longLivedRequest = await createSignedObject({
      object_type: 'mycelium.delete-request',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      payload: {
        command: 'delete',
        target_object_id: target.object_id,
        target_object_type: target.object_type,
        target_author: target.author,
        target_created_at: target.created_at,
        ...(target.content_hash ? { target_content_hash: target.content_hash } : {}),
        ...(target.author_proof ? { target_author_proof: target.author_proof } : {})
      },
      replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
    }, author);

    expect(await validateDistributedObject(longLivedRequest)).toBe(true);
    expect(await acceptDeleteRequest(longLivedRequest, store, NOW)).toBe(false);
    expect(await store.getDeletionTombstone(target.object_id)).toBeNull();
  });

  it('requires legacy target content locally to verify ownership before deletion', async () => {
    const author = await createIdentity('legacy-deletion-author');
    const store = new IndexedDbObjectStore();
    const targetPresent = await createLegacyPost(author, 'legacy target present');
    const requestForPresent = await createDeleteRequest(targetPresent, author, () => NOW);

    expect(await store.put(targetPresent)).toBe(true);
    expect(await acceptDeleteRequest(requestForPresent, store, NOW)).toBe(true);
    expect(await store.getDeletionTombstone(targetPresent.object_id)).not.toBeNull();

    const targetAbsent = await createLegacyPost(author, 'legacy target absent');
    const requestForAbsent = await createDeleteRequest(targetAbsent, author, () => NOW);
    expect(await acceptDeleteRequest(requestForAbsent, store, NOW)).toBe(false);
    expect(await store.getDeletionTombstone(targetAbsent.object_id)).toBeNull();
  });

  it('authorizes absent v3 targets using the target object signature', async () => {
    const author = await createIdentity('v3-delete-author');
    const store = new IndexedDbObjectStore();
    const target = await createPost(author, 'target not stored locally');
    const request = await createDeleteRequest(target, author, () => NOW);

    expect(request.payload).toMatchObject({
      target_object_id_version: 3,
      target_object_id: target.object_id,
      target_content_hash: target.content_hash,
      target_author_proof: target.signature
    });
    expect(await acceptDeleteRequest(request, store, NOW)).toBe(true);
    expect(await store.get(target.object_id)).toBeNull();
    expect(await store.getDeletionTombstone(target.object_id)).not.toBeNull();
  });

  it('rejects v3 deletion by another author and forged target proofs or IDs', async () => {
    const author = await createIdentity('v3-delete-owner');
    const attacker = await createIdentity('v3-delete-attacker');
    const target = await createPost(author, 'protected target');
    const validRequest = await createDeleteRequest(target, author, () => NOW);
    const store = new IndexedDbObjectStore();
    const requestPayload = validRequest.payload as { [key: string]: JsonValue };

    const attackerRequest = await createSignedObject({
      object_type: 'mycelium.delete-request',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      payload: requestPayload,
      replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
    }, attacker);
    const forgedProofRequest = await createSignedObject({
      object_type: 'mycelium.delete-request',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      payload: { ...requestPayload, target_author_proof: 'forged-target-proof' },
      replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
    }, author);
    const modifiedIdRequest = await createSignedObject({
      object_type: 'mycelium.delete-request',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      payload: { ...requestPayload, target_object_id: '0'.repeat(64) },
      replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
    }, author);

    expect(await acceptDeleteRequest(attackerRequest, store, NOW)).toBe(false);
    expect(await acceptDeleteRequest(forgedProofRequest, store, NOW)).toBe(false);
    expect(await acceptDeleteRequest(modifiedIdRequest, store, NOW)).toBe(false);
    expect(await store.getDeletionTombstone(target.object_id)).toBeNull();
    expect(await store.getDeletionTombstone('0'.repeat(64))).toBeNull();
  });

  it('preserves version-2 target deletion proofs when the target is absent', async () => {
    const author = await createIdentity('v2-delete-author');
    const target = await createV2Post(author, 'version-2 target');
    const request = await createDeleteRequest(target, author, () => NOW);
    const store = new IndexedDbObjectStore();

    expect(request.payload).toMatchObject({ target_object_id_version: 2 });
    expect(await acceptDeleteRequest(request, store, NOW)).toBe(true);
    expect(await store.getDeletionTombstone(target.object_id)).not.toBeNull();
  });

  it('accepts existing version-2 Delete Requests without a target-version marker', async () => {
    const author = await createIdentity('legacy-v2-delete-author');
    const target = await createV2Post(author, 'version-2 target');
    if (!target.content_hash || !target.author_proof) throw new Error('Version-2 fixture lacks its target proof');
    const oldRequest = await createV2Object({
      object_type: 'mycelium.delete-request',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      payload: {
        command: 'delete',
        target_object_id: target.object_id,
        target_object_type: target.object_type,
        target_author: target.author,
        target_created_at: target.created_at,
        target_content_hash: target.content_hash,
        target_author_proof: target.author_proof
      },
      replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
    }, author);
    const store = new IndexedDbObjectStore();

    expect(oldRequest.object_id_version).toBe(2);
    expect(await acceptDeleteRequest(oldRequest, store, NOW)).toBe(true);
    expect(await store.getDeletionTombstone(target.object_id)).not.toBeNull();
  });

  it('continues to accept legacy-target Delete Requests only when the target is locally verifiable', async () => {
    const author = await createIdentity('legacy-v2-delete-request-author');
    const target = await createLegacyPost(author, 'legacy target');
    const oldRequest = await createV2Object({
      object_type: 'mycelium.delete-request',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      payload: {
        command: 'delete',
        target_object_id: target.object_id,
        target_object_type: target.object_type,
        target_author: target.author,
        target_created_at: target.created_at
      },
      replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
    }, author);
    const store = new IndexedDbObjectStore();

    expect(await acceptDeleteRequest(oldRequest, store, NOW)).toBe(false);
    expect(await store.put(target)).toBe(true);
    expect(await acceptDeleteRequest(oldRequest, store, NOW)).toBe(true);
    expect(await store.getDeletionTombstone(target.object_id)).not.toBeNull();
  });

  it('stores legacy, version-2, and version-3 objects together without changing their IDs', async () => {
    const author = await createIdentity('mixed-version-author');
    const legacy = await createLegacyPost(author, 'legacy');
    const version2 = await createV2Post(author, 'version 2');
    const version3 = await createPost(author, 'version 3');
    const store = new IndexedDbObjectStore();
    const ids = [legacy.object_id, version2.object_id, version3.object_id];

    expect(await store.put(legacy)).toBe(true);
    expect(await store.put(version2)).toBe(true);
    expect(await store.put(version3)).toBe(true);
    expect((await store.query()).map((object) => object.object_id).sort()).toEqual([...ids].sort());
    expect(await store.get(legacy.object_id)).toEqual(legacy);
    expect(await store.get(version2.object_id)).toEqual(version2);
    expect(await store.get(version3.object_id)).toEqual(version3);
  });

  it('removes a present target and keeps later copies suppressed', async () => {
    const author = await createIdentity('deletion-order-author');
    const store = new IndexedDbObjectStore();
    const targetBefore = await createPost(author, 'arrives first');
    const deleteAfter = await createDeleteRequest(targetBefore, author, () => NOW);

    expect(await store.put(targetBefore)).toBe(true);
    expect(await acceptDeleteRequest(deleteAfter, store, NOW)).toBe(true);
    expect(await store.get(targetBefore.object_id)).toBeNull();
    expect(await store.getDeletionTombstone(targetBefore.object_id)).not.toBeNull();
    expect(await store.put(targetBefore)).toBe(false);
    expect(await store.get(targetBefore.object_id)).toBeNull();

    const targetResponse = await buildFindResponsePacket(
      'deleted-target-peer',
      'local-peer',
      targetBefore.object_id,
      'deleted-target-find',
      targetBefore
    );
    expect(await receiveFindResponsePacket(targetResponse, store, 'deleted-target-find')).toBeNull();
    let findRequestsSent = 0;
    const transport: ObjectTransport = {
      connectedPeers: () => ['deleted-target-peer'],
      send: async () => { findRequestsSent += 1; },
      onPacket: () => () => {}
    };
    expect(await findObject('local-peer', 'deleted-target-peer', targetBefore.object_id, transport, store))
      .toBeNull();
    expect(findRequestsSent).toBe(0);
  });

  it('creates a tombstone when the target is absent and rejects its later arrival', async () => {
    const author = await createIdentity('deletion-before-target-author');
    const store = new IndexedDbObjectStore();
    const targetAfter = await createPost(author, 'arrives later');
    const deleteBefore = await createDeleteRequest(targetAfter, author, () => NOW);
    expect(await acceptDeleteRequest(deleteBefore, store, NOW)).toBe(true);
    expect(await store.get(targetAfter.object_id)).toBeNull();
    expect(await store.getDeletionTombstone(targetAfter.object_id)).not.toBeNull();
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

  it('deduplicates identical requests without repeating generic replication', async () => {
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
  });

  it('keeps the tombstone authoritative after request expiry and rejects a reappearing target', async () => {
    const author = await createIdentity('deletion-expiry-author');
    const store = new IndexedDbObjectStore();
    const createdAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const target = await createPost(author, 'resurrection candidate', createdAt.toISOString());
    const request = await createDeleteRequest(target, author, () => createdAt);
    expect(await acceptDeleteRequest(request, store, createdAt)).toBe(true);

    const afterPropagation = new Date(Date.parse(request.expires_at!) + 1);
    expect(isObjectExpired(request, afterPropagation)).toBe(true);
    expect(await store.get(request.object_id)).toBeNull();
    expect(await acceptDeleteRequest(request, store, afterPropagation)).toBe(false);
    const tombstoneAfterExpiry = await store.getDeletionTombstone(target.object_id);
    expect(tombstoneAfterExpiry).toMatchObject({
      target_object_id: target.object_id,
      delete_request_id: request.object_id
    });
    expect(tombstoneAfterExpiry).not.toHaveProperty('propagation_expires_at');
    const recoveredStore = new IndexedDbObjectStore();
    expect(await recoveredStore.getDeletionTombstone(target.object_id)).toEqual(tombstoneAfterExpiry);
    const transport: ObjectTransport = {
      connectedPeers: () => [],
      send: async () => {},
      onPacket: () => () => {}
    };
    expect(await receiveAndReplicate(target, 'late-peer', recoveredStore, transport, 'local-peer')).toBe(false);
    expect(await recoveredStore.get(target.object_id)).toBeNull();
  });

  it('does not send a tombstoned object from a previously queued outbox entry', async () => {
    const author = await createIdentity('deletion-outbox-author');
    const store = new IndexedDbObjectStore();
    const createdAt = new Date();
    const target = await createPost(author, 'queued target', createdAt.toISOString());
    const request = await createDeleteRequest(target, author, () => createdAt);
    expect(await store.put(target)).toBe(true);
    expect(await acceptDeleteRequest(request, store, createdAt)).toBe(true);

    const outbox = new IndexedDbOutboxStore();
    await outbox.add({
      object_id: target.object_id,
      created_at: target.created_at,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      attempts: 0,
      last_attempt_at: null
    });
    const sendDirect = async () => true;
    const replicate = async () => ['peer'];
    const service = createOutboxService({
      outbox,
      objectStore: store,
      sendDirect,
      replicate,
      resolveRecipientPeerId: () => null,
      connectedPeers: () => ['peer']
    });

    await service.flush();
    expect(await outbox.get(target.object_id)).toBeNull();
  });

  it('does not expose an independent timed tombstone collector', async () => {
    const store = new IndexedDbObjectStore();

    expect(store).not.toHaveProperty('collectDeletionTombstones');
    expect(store).not.toHaveProperty('expireDeletionTombstones');
  });
});
