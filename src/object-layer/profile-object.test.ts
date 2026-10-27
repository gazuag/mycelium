import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEncryptionKeyBinding, exportEncryptionPublicKey, generateEncryptionKeyPair } from '../crypto/dm-crypto';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { buildObjectBatchPacket, receiveObjectBatchPacket, receiveObjectPacket, replicateObject, sendObjectBatches } from './transport';
import { createObjectIdentity } from './identity';
import { createSignedIdentityObject, validateIdentityObject, type IdentityObject } from './identity-object';
import { IndexedDbObjectStore } from './local-store';
import { getLatestIdentityObject, getLatestIdentityObjects } from './profile-object';
import type { DistributedObject, ObjectStore, ObjectTransport } from './types';
import { createSignedObject, validateObject } from './envelope';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

interface TestIdentity {
  id: string;
  publicKey: string;
  privateKey: string;
  encryptionPublicKey: string;
  objectIdentity: ReturnType<typeof createObjectIdentity>;
}

async function createTestIdentity(): Promise<TestIdentity> {
  const [signingPair, encryptionPair] = await Promise.all([
    generateIdentityKeyPair(),
    generateEncryptionKeyPair()
  ]);
  const publicKey = await exportPublicKey(signingPair.publicKey);
  const privateKey = await exportPrivateKey(signingPair.privateKey);
  return {
    id: 'test-peer',
    publicKey,
    privateKey,
    encryptionPublicKey: await exportEncryptionPublicKey(encryptionPair.publicKey),
    objectIdentity: createObjectIdentity({ id: 'test-peer', publicKey, privateKey })
  };
}

async function createProfile(
  identity: TestIdentity,
  displayName: string,
  createdAt: string,
  metadata?: Record<string, string>
): Promise<IdentityObject> {
  return await createSignedIdentityObject({
    display_name: displayName,
    bio: `Bio for ${displayName}`,
    encryption_public_key: identity.encryptionPublicKey,
    encryption_key_binding: await createEncryptionKeyBinding(identity),
    created_at: createdAt,
    ...(metadata ? { metadata } : {})
  }, identity.objectIdentity) as IdentityObject;
}

function createMemoryStore(): ObjectStore {
  const objects = new Map<string, DistributedObject>();
  return {
    put: async (object) => {
      if (!(await validateObject(object))) throw new Error('Invalid distributed object');
      const isNew = !objects.has(object.object_id);
      objects.set(object.object_id, object);
      return isNew;
    },
    get: async (objectId) => objects.get(objectId) ?? null,
    delete: async (objectId) => { objects.delete(objectId); },
    query: async (criteria = {}) => [...objects.values()].filter((object) =>
      (criteria.object_type === undefined || object.object_type === criteria.object_type)
      && (criteria.author === undefined || object.author === criteria.author)
    )
  };
}

function createTransport(
  peers: string[],
  onSend: ObjectTransport['send']
): ObjectTransport {
  return {
    connectedPeers: () => peers,
    send: onSend,
    onPacket: () => () => {}
  };
}

describe('replicated identity profile objects', () => {
  it('creates signed profile versions with extensible metadata and signed timestamps', async () => {
    const identity = await createTestIdentity();
    const first = await createProfile(identity, 'Alice', '2026-10-01T00:00:00.000Z', {
      website_url: 'https://alice.example'
    });
    const updated = await createProfile(identity, 'Alice B', '2026-10-02T00:00:00.000Z');

    expect(await validateIdentityObject(first)).toBe(true);
    expect(first.author).toBe(identity.publicKey);
    expect(first.created_at).toBe('2026-10-01T00:00:00.000Z');
    expect(first.payload.metadata).toEqual({ website_url: 'https://alice.example' });
    expect(await validateIdentityObject(updated)).toBe(true);
    expect(updated.object_id).not.toBe(first.object_id);
  });

  it('rejects invalid identity payloads even when wrapped in a valid object signature', async () => {
    const identity = await createTestIdentity();
    const binding = await createEncryptionKeyBinding(identity);
    const invalid = await createSignedObject({
      object_type: 'mycelium.identity',
      created_at: '2026-10-01T00:00:00.000Z',
      payload: {
        bio: 'Missing required display name',
        encryption_public_key: identity.encryptionPublicKey,
        encryption_key_binding: {
          signing_public_key: binding.signing_public_key,
          encryption_public_key: binding.encryption_public_key,
          created_at: binding.created_at,
          signature: binding.signature
        }
      },
      replication_policy: {}
    }, identity.objectIdentity);

    expect(await validateObject(invalid)).toBe(false);
    await expect(new IndexedDbObjectStore().put(invalid)).rejects.toThrow('Invalid distributed object');
  });

  it('stores a valid signed profile object in the ordinary object store', async () => {
    const identity = await createTestIdentity();
    const profile = await createProfile(identity, 'Stored Profile', '2026-10-03T00:00:00.000Z');
    const store = new IndexedDbObjectStore();

    await expect(store.put(profile)).resolves.toBe(true);
    await expect(store.get(profile.object_id)).resolves.toEqual(profile);
    await expect(getLatestIdentityObject(store, identity.publicKey)).resolves.toEqual(profile);
  });

  it('selects a newer profile version and does not regress when an older version arrives later', async () => {
    const identity = await createTestIdentity();
    const older = await createProfile(identity, 'Old Name', '2026-10-04T00:00:00.000Z');
    const newer = await createProfile(identity, 'Current Name', '2026-10-05T00:00:00.000Z');
    const store = createMemoryStore();

    await store.put(newer);
    await store.put(older);

    await expect(getLatestIdentityObject(store, identity.publicKey)).resolves.toMatchObject({
      object_id: newer.object_id,
      payload: { display_name: 'Current Name' }
    });
    await expect(getLatestIdentityObjects(store)).resolves.toEqual([newer]);
  });

  it('replicates the profile through ordinary object packets and serves it from a cache while the author is offline', async () => {
    const identity = await createTestIdentity();
    const authorStore = createMemoryStore();
    const cacheStore = createMemoryStore();
    const browserStore = createMemoryStore();
    const profile = await createProfile(identity, 'Offline Author', '2026-10-06T00:00:00.000Z');
    await authorStore.put(profile);

    const authorTransport = createTransport(['cache-peer'], async (peerId, packet) => {
      expect(peerId).toBe('cache-peer');
      await receiveObjectPacket(packet, cacheStore);
    });
    await replicateObject(identity.id, profile, authorTransport);
    expect(await cacheStore.get(profile.object_id)).toEqual(profile);

    const cacheTransport = createTransport(['browser-peer'], async (peerId, packet) => {
      expect(peerId).toBe('browser-peer');
      await receiveObjectBatchPacket(packet, browserStore);
    });
    const cachedProfiles = await getLatestIdentityObjects(cacheStore);
    await sendObjectBatches('cache-peer', 'browser-peer', cachedProfiles, cacheTransport);

    const cachedProfile = await getLatestIdentityObject(browserStore, identity.publicKey);
    expect(cachedProfile?.payload.display_name).toBe('Offline Author');
    expect(cachedProfile?.author).toBe(identity.publicKey);
  });

  it('does not trust an ordinary browser batch or cache as profile authority', async () => {
    const identity = await createTestIdentity();
    const profile = await createProfile(identity, 'Verified Name', '2026-10-07T00:00:00.000Z');
    const cacheStore = createMemoryStore();
    const validPacket = await buildObjectBatchPacket('cache-peer', 'browser-peer', [profile]);
    const tamperedPacket = {
      ...validPacket,
      payload: {
        ...validPacket.payload,
        objects: [{
          ...profile,
          payload: Object.assign({}, profile.payload, { display_name: 'Forged Name' })
        }]
      }
    };

    await expect(receiveObjectBatchPacket(tamperedPacket, cacheStore)).resolves.toEqual([false]);
    await expect(receiveObjectBatchPacket(validPacket, cacheStore)).resolves.toEqual([true]);
    await expect(getLatestIdentityObject(cacheStore, identity.publicKey)).resolves.toMatchObject({
      payload: { display_name: 'Verified Name' }
    });
  });
});
