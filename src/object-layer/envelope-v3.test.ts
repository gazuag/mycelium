import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { canonicalize, canonicalizeV3 } from '../p2p/protocol';
import { createObjectIdentity } from './identity';
import {
  calculateAuthorBoundObjectId,
  calculateObjectId,
  canonicalizeObjectContent,
  createSignedObject,
  validateDistributedObject
} from './envelope';
import { IndexedDbObjectStore } from './local-store';
import { buildFindResponsePacket, receiveAndReplicate, receiveFindResponsePacket } from './transport';
import type { DistributedObject, ObjectIdentity, ObjectPacket, ObjectTransport } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

async function createIdentity(): Promise<ObjectIdentity> {
  const pair = await generateIdentityKeyPair();
  return createObjectIdentity({
    id: 'v3-test-author',
    publicKey: await exportPublicKey(pair.publicKey),
    privateKey: await exportPrivateKey(pair.privateKey)
  });
}

describe('version-3 object identity', () => {
  it('creates 64-character lowercase hex IDs using cryptographic randomness', async () => {
    const identity = await createIdentity();
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');
    const object = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-01T12:00:00.000Z',
      payload: { content: 'secure object ID' },
      replication_policy: {}
    }, identity);

    expect(object.object_id_version).toBe(3);
    expect(object.object_id).toMatch(/^[0-9a-f]{64}$/);
    expect(getRandomValues).toHaveBeenCalled();
    expect(getRandomValues.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(32);
    getRandomValues.mockRestore();
  });

  it('allows identical immutable content to have distinct IDs and the same content hash', async () => {
    const identity = await createIdentity();
    const content = {
      object_type: 'mycelium.v3-identity-test',
      created_at: '2026-10-01T12:00:00.000Z',
      payload: { content: 'same content' },
      replication_policy: {}
    };
    const first = await createSignedObject(content, identity);
    const second = await createSignedObject(content, identity);

    expect(first.object_id).not.toBe(second.object_id);
    expect(first.content_hash).toBe(second.content_hash);
    expect(first.content_hash).toBe(await calculateObjectId({ ...content, author: identity.publicKey }));
  });

  it('canonicalizes v3 JSON using locale-independent UTF-16 key ordering', async () => {
    const identity = await createIdentity();
    const localeSort = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-sensitive sorting must not be used by v3');
    });
    try {
      expect(canonicalizeV3({
        z: 1,
        'ä': 2,
        '2': 'two',
        '10': 'ten',
        A: 3,
        a: { 'é': true, b: false }
      })).toBe('{"10":"ten","2":"two","A":3,"a":{"b":false,"é":true},"z":1,"ä":2}');

      const object = await createSignedObject({
        object_type: 'mycelium.v3-canonicalization-test',
        created_at: '2026-10-01T12:00:00.000Z',
        payload: { z: 1, 'ä': 2, '2': 'two', '10': 'ten', A: 3, a: { 'é': true, b: false } },
        replication_policy: {}
      }, identity);
      expect(await validateDistributedObject(object)).toBe(true);
    } finally {
      localeSort.mockRestore();
    }
  });

  it('rejects content, content-hash, ID, and author tampering', async () => {
    const identity = await createIdentity();
    const otherIdentity = await createIdentity();
    const object = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-01T12:00:00.000Z',
      payload: { content: 'signed v3 content' },
      replication_policy: {}
    }, identity);

    expect(await validateDistributedObject(object)).toBe(true);
    expect(await validateDistributedObject({ ...object, payload: { content: 'modified' } })).toBe(false);
    expect(await validateDistributedObject({ ...object, content_hash: '0'.repeat(64) })).toBe(false);
    expect(await validateDistributedObject({ ...object, object_id: '0'.repeat(64) })).toBe(false);
    expect(await validateDistributedObject({ ...object, author: otherIdentity.publicKey })).toBe(false);
  });

  it('admits valid v3 objects and rejects invalid objects through IndexedDB storage', async () => {
    const identity = await createIdentity();
    const store = new IndexedDbObjectStore();
    const object = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-01T12:00:00.000Z',
      payload: { content: 'admitted v3 object' },
      replication_policy: {}
    }, identity);

    await expect(store.put(object)).resolves.toBe(true);
    expect(await store.get(object.object_id)).toEqual(object);
    await expect(store.put({ ...object, object_id: 'f'.repeat(64) })).rejects.toThrow('Invalid distributed object');
  });

  it('keeps identical-content v3 instances separate and retrieves them by ID through FIND', async () => {
    const identity = await createIdentity();
    const content = {
      object_type: 'mycelium.v3-identity-test',
      created_at: '2026-10-01T12:00:00.000Z',
      payload: { content: 'same immutable content' },
      replication_policy: {}
    };
    const first = await createSignedObject(content, identity);
    const second = await createSignedObject(content, identity);
    const store = new IndexedDbObjectStore();

    expect(first.object_id).not.toBe(second.object_id);
    expect(await store.put(first)).toBe(true);
    expect(await store.put(second)).toBe(true);
    expect(await store.query({ object_type: 'mycelium.v3-identity-test' })).toHaveLength(2);

    const response = await buildFindResponsePacket(
      'v3-source-peer',
      'v3-local-peer',
      second.object_id,
      'v3-find-request',
      second
    );
    await store.delete(second.object_id);
    const receivingStore = new IndexedDbObjectStore();
    expect(await receiveFindResponsePacket(response, receivingStore, 'v3-find-request')).toEqual(second);
    expect(await receivingStore.get(second.object_id)).toEqual(second);
  });

  it('replicates a v3 object through the existing object transport', async () => {
    const identity = await createIdentity();
    const object = await createSignedObject({
      object_type: 'mycelium.v3-replication-test',
      created_at: '2026-10-01T12:00:00.000Z',
      payload: { content: 'replicated by object ID' },
      replication_policy: {}
    }, identity);
    const sent: { peerId: string; packet: ObjectPacket }[] = [];
    const transport: ObjectTransport = {
      connectedPeers: () => ['v3-replica'],
      send: async (peerId, packet) => { sent.push({ peerId, packet }); },
      onPacket: () => () => {}
    };
    const store = new IndexedDbObjectStore();

    expect(await receiveAndReplicate(object, 'v3-source', store, transport, 'v3-local')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.peerId).toBe('v3-replica');
    const replicatedPacket = sent[0]?.packet;
    expect(replicatedPacket?.type).toBe('OBJECT_STORE');
    if (replicatedPacket?.type === 'OBJECT_STORE') {
      expect(replicatedPacket.payload.object.object_id).toBe(object.object_id);
    }
    expect(await store.get(object.object_id)).toEqual(object);
  });

  it('continues to validate an existing version-2 object format', async () => {
    const identity = await createIdentity();
    const content = {
      object_type: 'mycelium.post',
      author: identity.publicKey,
      created_at: '2026-10-01T12:00:00.000Z',
      payload: { content: 'version-2 fixture' },
      replication_policy: {}
    };
    const contentHash = await calculateObjectId(content);
    const objectId = await calculateAuthorBoundObjectId(identity.publicKey, contentHash);
    const authorProof = await identity.sign(canonicalize({
      domain: 'mycelium.object-author-proof.v2',
      author: identity.publicKey,
      content_hash: contentHash
    }));
    const object: DistributedObject = {
      ...content,
      object_id: objectId,
      object_id_version: 2,
      content_hash: contentHash,
      author_proof: authorProof,
      signature: await identity.sign(canonicalizeObjectContent(content))
    };

    expect(await validateDistributedObject(object)).toBe(true);
  });
});
