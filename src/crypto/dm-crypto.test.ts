import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from './identity';
import {
  addEncryptionKeyBinding,
  applyEncryptionKeyBinding,
  createEncryptionKeyBinding,
  decryptDm,
  deriveDmKey,
  encryptDm,
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  generateEncryptionKeyPair,
  getContactEncryptionKey,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
  verifyEncryptionKeyBinding
} from './dm-crypto';
import {
  deleteIdentity,
  ensureIdentityEncryptionKeyPair,
  identityBackupFields,
  loadIdentity,
  saveIdentity,
  type LocalIdentityRecord
} from '../storage/idb';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const context = new TextEncoder().encode('dm-context');
const aad = new TextEncoder().encode('conversation-id:message-id');

afterEach(async () => {
  await deleteIdentity();
});

async function createSigningIdentity(): Promise<LocalIdentityRecord> {
  const keyPair = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const privateKey = await exportPrivateKey(keyPair.privateKey);
  return { key: 'local', publicKey, privateKey, id: 'test-identity' };
}

async function createBindingIdentity() {
  const signingIdentity = await createSigningIdentity();
  const encryptionKeyPair = await generateEncryptionKeyPair();
  return {
    ...signingIdentity,
    encryptionPublicKey: await exportEncryptionPublicKey(encryptionKeyPair.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(encryptionKeyPair.privateKey)
  };
}

function flipBase64Byte(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  bytes[0] ^= 1;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('DM cryptography primitives', () => {
  it('generates an extractable ECDH P-256 keypair', async () => {
    const keyPair = await generateEncryptionKeyPair();

    expect(keyPair.privateKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(keyPair.publicKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(keyPair.privateKey.extractable).toBe(true);
    expect(keyPair.publicKey.extractable).toBe(true);
    expect(keyPair.privateKey.usages).toEqual(['deriveBits']);
    expect(keyPair.publicKey.usages).toEqual([]);
  });

  it('round-trips exported and imported public and private keys', async () => {
    const original = await generateEncryptionKeyPair();
    const publicKeyBase64 = await exportEncryptionPublicKey(original.publicKey);
    const privateKeyBase64 = await exportEncryptionPrivateKey(original.privateKey);
    const importedPublicKey = await importEncryptionPublicKey(publicKeyBase64);
    const importedPrivateKey = await importEncryptionPrivateKey(privateKeyBase64);

    expect(await exportEncryptionPublicKey(importedPublicKey)).toBe(publicKeyBase64);
    expect(await exportEncryptionPrivateKey(importedPrivateKey)).toBe(privateKeyBase64);
  });

  it('derives the same DM key from both sides of an ECDH exchange', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const aliceKey = await deriveDmKey(alice.privateKey, bob.publicKey, context);
    const bobKey = await deriveDmKey(bob.privateKey, alice.publicKey, context);
    const encrypted = await encryptDm(aliceKey, 'shared secret', aad);

    await expect(decryptDm(bobKey, encrypted, aad)).resolves.toBe('shared secret');
  });

  it('derives different DM keys for different contexts', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const keyOne = await deriveDmKey(alice.privateKey, bob.publicKey, context);
    const keyTwo = await deriveDmKey(alice.privateKey, bob.publicKey, new TextEncoder().encode('other-context'));
    const encrypted = await encryptDm(keyOne, 'context-bound', aad);

    await expect(decryptDm(keyTwo, encrypted, aad)).rejects.toThrow();
  });

  it('encrypts and decrypts unicode and empty plaintext', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const key = await deriveDmKey(alice.privateKey, bob.publicKey, context);

    for (const plaintext of ['Hello, 🌱 世界', '']) {
      const encrypted = await encryptDm(key, plaintext, aad);
      await expect(decryptDm(key, encrypted, aad)).resolves.toBe(plaintext);
    }
  });

  it('uses a fresh nonce for each encryption', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const key = await deriveDmKey(alice.privateKey, bob.publicKey, context);
    const first = await encryptDm(key, 'same plaintext', aad);
    const second = await encryptDm(key, 'same plaintext', aad);

    expect(first.nonce).not.toBe(second.nonce);
  });

  it('rejects decryption with the wrong key', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const mallory = await generateEncryptionKeyPair();
    const correctKey = await deriveDmKey(alice.privateKey, bob.publicKey, context);
    const wrongKey = await deriveDmKey(mallory.privateKey, bob.publicKey, context);
    const encrypted = await encryptDm(correctKey, 'secret', aad);

    await expect(decryptDm(wrongKey, encrypted, aad)).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const key = await deriveDmKey(alice.privateKey, bob.publicKey, context);
    const encrypted = await encryptDm(key, 'authenticated ciphertext', aad);

    await expect(decryptDm(key, { ...encrypted, ciphertext: flipBase64Byte(encrypted.ciphertext) }, aad)).rejects.toThrow();
  });

  it('rejects a tampered nonce', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const key = await deriveDmKey(alice.privateKey, bob.publicKey, context);
    const encrypted = await encryptDm(key, 'authenticated nonce', aad);

    await expect(decryptDm(key, { ...encrypted, nonce: flipBase64Byte(encrypted.nonce) }, aad)).rejects.toThrow();
  });

  it('rejects mismatched additional authenticated data', async () => {
    const alice = await generateEncryptionKeyPair();
    const bob = await generateEncryptionKeyPair();
    const key = await deriveDmKey(alice.privateKey, bob.publicKey, context);
    const encrypted = await encryptDm(key, 'authenticated metadata', aad);

    await expect(decryptDm(key, encrypted, new TextEncoder().encode('different-context'))).rejects.toThrow();
  });

  it('creates a local identity with an ECDH encryption keypair', async () => {
    const identity = await ensureIdentityEncryptionKeyPair(await createSigningIdentity());
    const publicKey = await importEncryptionPublicKey(identity.encryptionPublicKey);
    const privateKey = await importEncryptionPrivateKey(identity.encryptionPrivateKey);

    expect(publicKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(privateKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(identity.encryptionPublicKey).toBeTruthy();
    expect(identity.encryptionPrivateKey).toBeTruthy();
  });

  it('migrates a legacy identity on load and persists its encryption keys across reloads', async () => {
    await saveIdentity(await createSigningIdentity());

    const firstLoad = await loadIdentity();
    const secondLoad = await loadIdentity();

    expect(firstLoad?.encryptionPublicKey).toBeTruthy();
    expect(firstLoad?.encryptionPrivateKey).toBeTruthy();
    expect(secondLoad?.encryptionPublicKey).toBe(firstLoad?.encryptionPublicKey);
    expect(secondLoad?.encryptionPrivateKey).toBe(firstLoad?.encryptionPrivateKey);
  });

  it('concurrent loadIdentity calls share one persisted encryption keypair', async () => {
    await saveIdentity(await createSigningIdentity());

    const loadedIdentities = await Promise.all(Array.from({ length: 8 }, () => loadIdentity()));
    const persistedIdentity = await loadIdentity();

    expect(new Set(loadedIdentities.map((identity) => identity?.encryptionPublicKey)).size).toBe(1);
    expect(new Set(loadedIdentities.map((identity) => identity?.encryptionPrivateKey)).size).toBe(1);
    expect(persistedIdentity?.encryptionPublicKey).toBe(loadedIdentities[0]?.encryptionPublicKey);
    expect(persistedIdentity?.encryptionPrivateKey).toBe(loadedIdentities[0]?.encryptionPrivateKey);
  });

  it('preserves encryption keys through an identity backup round trip', async () => {
    const identity = await ensureIdentityEncryptionKeyPair(await createSigningIdentity());
    const backup = JSON.parse(JSON.stringify({ identity: identityBackupFields(identity) }));
    const restored = await ensureIdentityEncryptionKeyPair(backup.identity);

    expect(restored.encryptionPublicKey).toBe(identity.encryptionPublicKey);
    expect(restored.encryptionPrivateKey).toBe(identity.encryptionPrivateKey);
  });

  it('accepts an old identity backup without encryption keys', async () => {
    const oldBackupIdentity = await createSigningIdentity();
    const restored = await ensureIdentityEncryptionKeyPair(oldBackupIdentity);

    expect(restored.publicKey).toBe(oldBackupIdentity.publicKey);
    expect(restored.privateKey).toBe(oldBackupIdentity.privateKey);
    expect(restored.encryptionPublicKey).toBeTruthy();
    expect(restored.encryptionPrivateKey).toBeTruthy();
  });

  it('creates and verifies a signed encryption-key binding', async () => {
    const identity = await createBindingIdentity();
    const binding = await createEncryptionKeyBinding(identity);

    expect(binding).toMatchObject({
      signing_public_key: identity.publicKey,
      encryption_public_key: identity.encryptionPublicKey
    });
    expect(await verifyEncryptionKeyBinding(binding)).toBe(true);
  });

  it('creates verifiable encryption-key bindings with a non-extractable signing key', async () => {
    const identity = await createBindingIdentity();
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      Uint8Array.from(atob(identity.privateKey), (character) => character.charCodeAt(0)).buffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const binding = await createEncryptionKeyBinding({
      publicKey: identity.publicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
      signingKey
    });

    expect(signingKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', signingKey)).rejects.toThrow();
    expect(await verifyEncryptionKeyBinding(binding)).toBe(true);
  });

  it('rejects an encryption key swapped into a signed binding', async () => {
    const identity = await createBindingIdentity();
    const otherKeyPair = await generateEncryptionKeyPair();
    const binding = await createEncryptionKeyBinding(identity);
    const swapped = { ...binding, encryption_public_key: await exportEncryptionPublicKey(otherKeyPair.publicKey) };

    expect(await verifyEncryptionKeyBinding(swapped)).toBe(false);
  });

  it('rejects a signing key swapped into a signed binding', async () => {
    const identity = await createBindingIdentity();
    const otherSigningPair = await generateIdentityKeyPair();
    const swappedSigningKey = await exportPublicKey(otherSigningPair.publicKey);
    const binding = await createEncryptionKeyBinding(identity);

    expect(await verifyEncryptionKeyBinding({ ...binding, signing_public_key: swappedSigningKey })).toBe(false);
  });

  it('rejects a tampered binding creation timestamp', async () => {
    const identity = await createBindingIdentity();
    const binding = await createEncryptionKeyBinding(identity);
    const createdAt = new Date(Date.parse(binding.created_at) + 1000).toISOString();

    expect(await verifyEncryptionKeyBinding({ ...binding, created_at: createdAt })).toBe(false);
  });

  it('adds a signed encryption-key binding to outgoing peer metadata', async () => {
    const identity = await createBindingIdentity();
    const metadata = await addEncryptionKeyBinding({ author: identity.id, publicKey: identity.publicKey }, identity);

    expect(metadata.encryptionKeyBinding).toMatchObject({
      signing_public_key: identity.publicKey,
      encryption_public_key: identity.encryptionPublicKey
    });
    expect(await verifyEncryptionKeyBinding(metadata.encryptionKeyBinding)).toBe(true);
  });

  it('stores a valid binding key on a contact', async () => {
    const identity = await createBindingIdentity();
    const binding = await createEncryptionKeyBinding(identity);
    const update = await applyEncryptionKeyBinding(binding, identity.publicKey);

    expect(update.accepted).toBe(true);
    expect(update.contactFields.encryptionPublicKey).toBe(identity.encryptionPublicKey);
    expect(getContactEncryptionKey(update.contactFields)).toBe(identity.encryptionPublicKey);
  });

  it('rejects a binding with an invalid signature', async () => {
    const identity = await createBindingIdentity();
    const binding = await createEncryptionKeyBinding(identity);
    const update = await applyEncryptionKeyBinding({ ...binding, signature: 'invalid' }, identity.publicKey);

    expect(update.accepted).toBe(false);
    expect(getContactEncryptionKey(update.contactFields)).toBeNull();
  });

  it('rejects a binding whose signing key differs from metadata.publicKey', async () => {
    const identity = await createBindingIdentity();
    const binding = await createEncryptionKeyBinding(identity);
    const otherSigningPair = await generateIdentityKeyPair();
    const metadataPublicKey = await exportPublicKey(otherSigningPair.publicKey);
    const update = await applyEncryptionKeyBinding(binding, metadataPublicKey);

    expect(update.accepted).toBe(false);
    expect(getContactEncryptionKey(update.contactFields)).toBeNull();
  });

  it('leaves contacts usable without an encryption key when a binding is missing', async () => {
    const update = await applyEncryptionKeyBinding(undefined, undefined);

    expect(update.accepted).toBe(false);
    expect(getContactEncryptionKey(update.contactFields)).toBeNull();
  });

  it('treats a valid same-key rebind as a no-op', async () => {
    const identity = await createBindingIdentity();
    const binding = await createEncryptionKeyBinding(identity);
    const current = { encryptionPublicKey: identity.encryptionPublicKey };
    const update = await applyEncryptionKeyBinding(binding, identity.publicKey, current);

    expect(update.accepted).toBe(true);
    expect(update.keyChanged).toBe(false);
    expect(update.contactFields).toBe(current);
  });

  it('keeps a trusted key and flags a valid changed-key binding', async () => {
    const identity = await createBindingIdentity();
    const changedKeyPair = await generateEncryptionKeyPair();
    const changedIdentity = {
      ...identity,
      encryptionPublicKey: await exportEncryptionPublicKey(changedKeyPair.publicKey)
    };
    const binding = await createEncryptionKeyBinding(changedIdentity);
    const update = await applyEncryptionKeyBinding(binding, identity.publicKey, {
      encryptionPublicKey: identity.encryptionPublicKey
    });

    expect(update.accepted).toBe(true);
    expect(update.keyChanged).toBe(true);
    expect(update.contactFields.encryptionPublicKey).toBe(identity.encryptionPublicKey);
    expect(update.contactFields.encryptionKeyChanged).toBe(true);
  });

  it('adds a valid key to a legacy contact on its first binding', async () => {
    const identity = await createBindingIdentity();
    const binding = await createEncryptionKeyBinding(identity);
    const update = await applyEncryptionKeyBinding(binding, identity.publicKey, {});

    expect(update.accepted).toBe(true);
    expect(update.contactFields.encryptionPublicKey).toBe(identity.encryptionPublicKey);
    expect(getContactEncryptionKey(update.contactFields)).toBe(identity.encryptionPublicKey);
  });
});