import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import {
  addEncryptionKeyBinding,
  createEncryptionKeyBinding,
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  generateEncryptionKeyPair,
  verifyEncryptionKeyBinding
} from '../crypto/dm-crypto';
import { isObjectExpired, validateObject } from './envelope';
import { createDmObject, decryptDmObject, DM_REPLICATION_BUDGET, DM_TTL_MS, validateDmPayload } from './dm-object';
import { IndexedDbObjectStore } from './local-store';
import { buildObjectStorePacket, queryFeedObjectsForPeer, receiveObjectPacket, replicateObject } from './transport';
import { deleteIdentity, loadIdentity, saveIdentity, type LocalIdentityRecord } from '../storage/idb';
import type { ObjectPacket, ObjectTransport } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const storedObjectIds: string[] = [];

afterEach(async () => {
  await deleteIdentity();
  if (storedObjectIds.length > 0) {
    const store = new IndexedDbObjectStore();
    await Promise.all(storedObjectIds.map((objectId) => store.delete(objectId)));
    storedObjectIds.length = 0;
  }
  vi.restoreAllMocks();
});

async function createDmIdentity(): Promise<LocalIdentityRecord & { id: string; encryptionPublicKey: string; encryptionPrivateKey: string }> {
  const signingKeys = await generateIdentityKeyPair();
  const encryptionKeys = await generateEncryptionKeyPair();
  return {
    key: 'local',
    id: await (await import('../crypto/identity')).deriveFingerprint(await exportPublicKey(signingKeys.publicKey)),
    publicKey: await exportPublicKey(signingKeys.publicKey),
    privateKey: await exportPrivateKey(signingKeys.privateKey),
    encryptionPublicKey: await exportEncryptionPublicKey(encryptionKeys.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(encryptionKeys.privateKey)
  };
}

async function sendDm(plaintext = 'private note', expiresInMs = DM_TTL_MS) {
  const sender = await createDmIdentity();
  const recipient = await createDmIdentity();
  const object = await createDmObject({
    identity: sender,
    recipientSigningKey: recipient.publicKey,
    recipientEncryptionKey: recipient.encryptionPublicKey,
    plaintext,
    expiresInMs
  });
  return { sender, recipient, object };
}

describe('mycelium.dm objects', () => {
  it('creates a valid signed DM object with top-level expiry', async () => {
    const { sender, recipient, object } = await sendDm();

    expect(object.object_type).toBe('mycelium.dm');
    expect(object.author).toBe(sender.publicKey);
    expect(await import('../object-layer/envelope').then(({ validateObject }) => validateObject(object))).toBe(true);
    expect(Date.parse(object.expires_at ?? '')).toBeGreaterThan(Date.now());
    expect(object.replication_policy).toEqual({ replication_budget: DM_REPLICATION_BUDGET });
    expect(validateDmPayload(object.payload)).toBe(true);
    expect((object.payload as { recipient: string }).recipient).toBe(recipient.publicKey);
  });

  it('does not include plaintext in the signed object', async () => {
    const plaintext = 'distinct confidential text';
    const { object } = await sendDm(plaintext);

    expect(JSON.stringify(object)).not.toContain(plaintext);
  });

  it('decrypts for the recipient when the expected sender encryption key matches', async () => {
    const { sender, recipient, object } = await sendDm();

    await expect(decryptDmObject({ object, identity: recipient, expectedSenderEncryptionKey: sender.encryptionPublicKey }))
      .resolves.toBe('private note');
  });

  it('decrypts for the author using the recipient encryption key', async () => {
    const { sender, object } = await sendDm('sender can read this');

    await expect(decryptDmObject({ object, identity: sender })).resolves.toBe('sender can read this');
  });

  it('rejects decryption by a third party', async () => {
    const { object } = await sendDm();
    const thirdParty = await createDmIdentity();

    await expect(decryptDmObject({ object, identity: thirdParty })).rejects.toThrow();
  });

  it('rejects a recipient-side expected sender encryption key mismatch', async () => {
    const { recipient, object } = await sendDm();

    await expect(decryptDmObject({ object, identity: recipient, expectedSenderEncryptionKey: 'different-key' }))
      .rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const { recipient, sender, object } = await sendDm();
    const payload = object.payload as Record<string, unknown>;
    const tampered = { ...object, payload: { ...payload, ciphertext: flipFirstBase64Byte(payload.ciphertext as string) } };

    await expect(decryptDmObject({ object: tampered, identity: recipient, expectedSenderEncryptionKey: sender.encryptionPublicKey }))
      .rejects.toThrow();
  });

  it('rejects a tampered recipient field', async () => {
    const { recipient, sender, object } = await sendDm();
    const payload = object.payload as Record<string, unknown>;
    const tampered = { ...object, payload: { ...payload, recipient: sender.publicKey } };

    await expect(decryptDmObject({ object: tampered, identity: recipient, expectedSenderEncryptionKey: sender.encryptionPublicKey }))
      .rejects.toThrow();
  });

  it('rejects a tampered encryption-key field', async () => {
    const { recipient, sender, object } = await sendDm();
    const payload = object.payload as Record<string, unknown>;
    const alternateKey = await createDmIdentity();
    const tampered = { ...object, payload: { ...payload, recipient_enc_key: alternateKey.encryptionPublicKey } };

    await expect(decryptDmObject({ object: tampered, identity: recipient, expectedSenderEncryptionKey: sender.encryptionPublicKey }))
      .rejects.toThrow();
  });

  it('rejects objects with the wrong object type', async () => {
    const { recipient, sender, object } = await sendDm();
    const wrongType = { ...object, object_type: 'mycelium.post' };

    await expect(decryptDmObject({ object: wrongType, identity: recipient, expectedSenderEncryptionKey: sender.encryptionPublicKey }))
      .rejects.toThrow('Unsupported direct-message object type');
  });

  it('rejects a malformed DM payload', async () => {
    const { sender, recipient } = await sendDm();
    const { createObjectIdentity } = await import('./identity');
    const { createSignedObject } = await import('./envelope');
    const malformed = await createSignedObject({
      object_type: 'mycelium.dm',
      created_at: new Date().toISOString(),
      payload: { v: 2, recipient: recipient.publicKey },
      replication_policy: { replication_budget: 1 }
    }, createObjectIdentity({ id: sender.id!, publicKey: sender.publicKey, privateKey: sender.privateKey }));

    await expect(decryptDmObject({ object: malformed, identity: recipient, expectedSenderEncryptionKey: sender.encryptionPublicKey }))
      .rejects.toThrow('Invalid direct-message payload');
  });

  it('uses the existing store expiry behavior for DMs', async () => {
    const { object } = await sendDm('expired note', -1000);

    expect(isObjectExpired(object)).toBe(true);
  });

  it('uses a fresh nonce when creating DMs with the same plaintext', async () => {
    const sender = await createDmIdentity();
    const recipient = await createDmIdentity();
    const options = {
      identity: sender,
      recipientSigningKey: recipient.publicKey,
      recipientEncryptionKey: recipient.encryptionPublicKey,
      plaintext: 'same plaintext'
    };
    const first = await createDmObject(options);
    const second = await createDmObject(options);

    expect((first.payload as { nonce: string }).nonce).not.toBe((second.payload as { nonce: string }).nonce);
  });

  it('attaches a valid binding through the metadata publisher helper', async () => {
    const sender = await createDmIdentity();
    const metadata = await addEncryptionKeyBinding({ author: sender.id, publicKey: sender.publicKey }, sender);

    expect(await verifyEncryptionKeyBinding(metadata.encryptionKeyBinding)).toBe(true);
    expect(metadata.encryptionKeyBinding.signing_public_key).toBe(metadata.publicKey);
  });

  it('clears a failed loadIdentity single-flight promise so a later load can retry', async () => {
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new Error('simulated IndexedDB open failure');
    });

    await expect(loadIdentity()).rejects.toThrow('simulated IndexedDB open failure');
    openSpy.mockRestore();
    await expect(loadIdentity()).resolves.toBeNull();
  });

  it('stores and retrieves a DM by object ID with its signature and payload intact', async () => {
    const { object } = await sendDm();
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(object.object_id);

    await store.put(object);
    const retrieved = await store.get(object.object_id);

    expect(retrieved).toEqual(object);
    expect(await validateObject(retrieved)).toBe(true);
    expect(retrieved?.payload).toEqual(object.payload);
  });

  it('persists a DM across object-store instances', async () => {
    const { object } = await sendDm();
    storedObjectIds.push(object.object_id);
    await new IndexedDbObjectStore().put(object);

    const reopenedStore = new IndexedDbObjectStore();
    await expect(reopenedStore.get(object.object_id)).resolves.toEqual(object);
  });

  it('evicts expired DMs and keeps unexpired DMs in the store', async () => {
    const expired = await sendDm('expired', -1000);
    const live = await sendDm('live');
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(expired.object.object_id, live.object.object_id);
    await store.put(expired.object);
    await store.put(live.object);

    await expect(store.get(expired.object.object_id)).resolves.toBeNull();
    await expect(store.get(live.object.object_id)).resolves.toEqual(live.object);
  });

  it('replicates a DM to connected peers only up to its replication budget', async () => {
    const { sender, object } = await sendDm();
    const sent: Array<{ peerId: string; packet: ObjectPacket }> = [];
    const transport: ObjectTransport = {
      connectedPeers: () => [sender.id, 'peer-a', 'peer-b', 'peer-c', 'peer-d'],
      send: async (peerId, packet) => { sent.push({ peerId, packet }); },
      onPacket: () => () => {}
    };
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(object.object_id);
    await store.put(object);

    const result = await replicateObject(sender.id, object, transport);

    expect(result.budget).toBe(3);
    expect(result.stored).toEqual(['peer-a', 'peer-b', 'peer-c']);
    expect(sent).toHaveLength(3);
    expect(sent.map(({ peerId }) => peerId)).toEqual(['peer-a', 'peer-b', 'peer-c']);
    expect(sent.every(({ packet }) => packet.type === 'OBJECT_STORE' && packet.payload.object.object_id === object.object_id)).toBe(true);
  });

  it('validates and stores an OBJECT_STORE replica that the recipient can decrypt', async () => {
    const { sender, recipient, object } = await sendDm('replicated ciphertext');
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(object.object_id);
    const packet = await buildObjectStorePacket(sender.id, recipient.id, object);

    await expect(receiveObjectPacket(packet, store)).resolves.toBe(true);
    const stored = await store.get(object.object_id);
    expect(stored).toEqual(object);
    expect(await validateObject(stored)).toBe(true);
    await expect(decryptDmObject({
      object: stored!,
      identity: recipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).resolves.toBe('replicated ciphertext');
  });

  it('does not return DMs from the post and recommendation feed query', async () => {
    const { sender, object } = await sendDm();
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(object.object_id);
    await store.put(object);

    const results = await queryFeedObjectsForPeer(store, sender.publicKey);

    expect(results).not.toContainEqual(object);
    expect(results).toEqual([]);
  });

  it('stores no plaintext in the IndexedDB DM object JSON', async () => {
    const plaintext = 'never persist this plaintext';
    const { object } = await sendDm(plaintext);
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(object.object_id);
    await store.put(object);
    const storedJson = JSON.stringify(await store.get(object.object_id));

    expect(storedJson).not.toContain(plaintext);
  });
});

function flipFirstBase64Byte(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  bytes[0] ^= 1;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}