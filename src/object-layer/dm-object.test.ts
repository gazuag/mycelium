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
import { createObjectIdentity } from './identity';
import { createSignedObject } from './envelope';
import { createDmObject, decryptDmObject, DM_REPLICATION_BUDGET, DM_TTL_MS, validateDmPayload } from './dm-object';
import { IndexedDbObjectStore } from './local-store';
import { buildObjectBatchPacket, buildObjectStorePacket, receiveObjectBatchPacket, receiveObjectPacket, replicateObject } from './transport';
import { queryFeedPage } from './feed-page';
import { deleteIdentity, loadIdentity, saveIdentity, type LocalIdentityRecord } from '../storage/idb';
import { fetchDiscovery, handleDiscoveryResult } from '../services/discovery';
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

async function useNonExtractableKeys(identity: Awaited<ReturnType<typeof createDmIdentity>>) {
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(identity.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const encryptionKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(identity.encryptionPrivateKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const {
    privateKey: _privateKey,
    encryptionPrivateKey: _encryptionPrivateKey,
    ...publicIdentity
  } = identity;
  return { ...publicIdentity, signingKey, encryptionKey };
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
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
    expect(object.recipient).toBe(recipient.publicKey);
    expect(validateDmPayload(object.payload)).toBe(true);
    expect(object.payload).not.toHaveProperty('recipient');
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

  it('creates and decrypts with non-extractable keys for both recipient and author roles', async () => {
    const sender = await useNonExtractableKeys(await createDmIdentity());
    const recipient = await useNonExtractableKeys(await createDmIdentity());
    const object = await createDmObject({
      identity: sender,
      recipientSigningKey: recipient.publicKey,
      recipientEncryptionKey: recipient.encryptionPublicKey,
      plaintext: 'non-extractable DM'
    });

    expect(sender.signingKey.extractable).toBe(false);
    expect(sender.encryptionKey.extractable).toBe(false);
    expect(recipient.signingKey.extractable).toBe(false);
    expect(recipient.encryptionKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', sender.signingKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', sender.encryptionKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', recipient.signingKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', recipient.encryptionKey)).rejects.toThrow();

    await expect(decryptDmObject({
      object,
      identity: recipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).resolves.toBe('non-extractable DM');
    await expect(decryptDmObject({ object, identity: sender })).resolves.toBe('non-extractable DM');
  });

  it('interoperates between string-based and CryptoKey-based DM identities', async () => {
    const sender = await useNonExtractableKeys(await createDmIdentity());
    const recipient = await createDmIdentity();
    const object = await createDmObject({
      identity: sender,
      recipientSigningKey: recipient.publicKey,
      recipientEncryptionKey: recipient.encryptionPublicKey,
      plaintext: 'mixed-key DM'
    });

    await expect(decryptDmObject({
      object,
      identity: recipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).resolves.toBe('mixed-key DM');
    await expect(decryptDmObject({ object, identity: sender })).resolves.toBe('mixed-key DM');
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

  it('rejects a DM payload that still contains a recipient field', async () => {
    const { recipient, object } = await sendDm();
    const payload = object.payload as Record<string, unknown>;

    expect(validateDmPayload({ ...payload, recipient: recipient.publicKey })).toBe(false);
    await expect(decryptDmObject({
      object: { ...object, payload: { ...payload, recipient: recipient.publicKey } },
      identity: recipient
    })).rejects.toThrow();
  });

  it('rejects a signed DM that has no envelope recipient', async () => {
    const { sender, recipient, object } = await sendDm();
    const unsignedContent = {
      object_type: object.object_type,
      created_at: object.created_at,
      expires_at: object.expires_at,
      payload: object.payload,
      replication_policy: object.replication_policy
    };
    const legacyObject = await createSignedObject(unsignedContent, createObjectIdentity({
      id: sender.id,
      publicKey: sender.publicKey,
      privateKey: sender.privateKey
    }));

    await expect(decryptDmObject({
      object: legacyObject,
      identity: recipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).rejects.toThrow('Direct-message recipient is missing');
  });

  it('rejects a tampered envelope recipient by signature and after re-signing by AAD', async () => {
    const { sender, recipient, object } = await sendDm();
    const changedSigningPair = await generateIdentityKeyPair();
    const changedRecipient = {
      ...recipient,
      publicKey: await exportPublicKey(changedSigningPair.publicKey),
      privateKey: await exportPrivateKey(changedSigningPair.privateKey)
    };
    const unsignedContent = {
      object_type: object.object_type,
      recipient: changedRecipient.publicKey,
      created_at: object.created_at,
      expires_at: object.expires_at,
      payload: object.payload,
      replication_policy: object.replication_policy
    };
    const resignedObject = await createSignedObject(unsignedContent, createObjectIdentity({
      id: changedRecipient.id,
      publicKey: sender.publicKey,
      privateKey: sender.privateKey
    }));

    await expect(decryptDmObject({
      object: { ...object, recipient: changedRecipient.publicKey },
      identity: recipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).rejects.toThrow('Invalid signed direct-message object');
    await expect(decryptDmObject({
      object: resignedObject,
      identity: changedRecipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).rejects.toThrow();
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
      recipient: recipient.publicKey,
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
    expect(stored?.recipient).toBe(recipient.publicKey);
    expect(await validateObject(stored)).toBe(true);
    await expect(decryptDmObject({
      object: stored!,
      identity: recipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).resolves.toBe('replicated ciphertext');
  });

  it('preserves recipient through an OBJECT_BATCH round trip', async () => {
    const { sender, recipient, object } = await sendDm('batch recipient');
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(object.object_id);
    const packet = await buildObjectBatchPacket(sender.id, recipient.id, [object]);

    await expect(receiveObjectBatchPacket(packet, store)).resolves.toEqual([true]);
    const stored = await store.get(object.object_id);
    expect(stored?.recipient).toBe(recipient.publicKey);
    expect(await validateObject(stored)).toBe(true);
  });

  it('adds feed page metadata only when supplied to the OBJECT_BATCH builder', async () => {
    const { sender, object } = await sendDm('batch page metadata');
    const page = {
      request_id: 'feed-request',
      next_cursor: { created_at: object.created_at, object_id: object.object_id },
      has_more: true
    };

    const feedPacket = await buildObjectBatchPacket(sender.id, 'peer-b', [object], undefined, page);
    const ordinaryPacket = await buildObjectBatchPacket(sender.id, 'peer-b', [object]);

    expect(feedPacket.payload).toEqual({ objects: [object], page });
    expect(ordinaryPacket.payload).toEqual({ objects: [object] });
  });

  it('preserves recipient through generic discovery result parsing', async () => {
    const { object, recipient } = await sendDm('discovery parser');
    const sentPackets: string[] = [];
    const socket = { readyState: 1, send: (packet: string) => sentPackets.push(packet) } as unknown as WebSocket;
    const discoveryPromise = fetchDiscovery(socket);
    await Promise.resolve();
    const request = JSON.parse(sentPackets[0] ?? '{}');

    expect(handleDiscoveryResult({
      protocol: 'mycelium',
      version: 1,
      id: 'result-id',
      type: 'DISCOVERY_RESULT',
      timestamp: object.created_at,
      sender: 'discovery-server',
      recipient: 'discovery-client',
      payload: { requestId: request.id, objects: [object] },
      signature: 'server-unsigned-v1'
    })).toBe(true);

    const [result] = await discoveryPromise;
    expect(result?.recipient).toBe(recipient.publicKey);
    expect(result).toEqual(object);
  });

  it('does not return DMs from the keyset feed query', async () => {
    const { sender, object } = await sendDm();
    const store = new IndexedDbObjectStore();
    storedObjectIds.push(object.object_id);
    await store.put(object);

    const results = await queryFeedPage(store, sender.publicKey);

    expect(results.objects).not.toContainEqual(object);
    expect(results.objects).toEqual([]);
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