import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveFingerprint } from './crypto/identity';
import { createLocalIdentityRecord, loadOrCreateLocalIdentity } from './identity-lifecycle';
import { clearAllLocalData, deleteIdentity, loadIdentity, saveIdentity } from './storage/idb';
import { fingerprintToHumanName } from './utils/fingerprintNames';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const DATABASE_NAME = 'mycelium_p2p';

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Identity test database deletion was blocked.'));
  });
}

describe('local identity initialization', () => {
  beforeEach(async () => {
    await deleteDatabase();
  });

  it('creates and stores a signing identity when none exists', async () => {
    const result = await loadOrCreateLocalIdentity();

    expect(result.created).toBe(true);
    expect(result.identity.id).toBe(await deriveFingerprint(result.identity.publicKey));
    expect(result.identity.metadataSequence).toBe(0);
    expect(fingerprintToHumanName(result.identity.id)).not.toBe('Peer');
    await expect(loadIdentity()).resolves.toMatchObject({
      publicKey: result.identity.publicKey,
      privateKey: result.identity.privateKey,
      encryptionPublicKey: result.identity.encryptionPublicKey,
      encryptionPrivateKey: result.identity.encryptionPrivateKey,
      metadataSequence: 0
    });
  });

  it('preserves an existing identity instead of generating over it', async () => {
    const original = await createLocalIdentityRecord();
    await saveIdentity(original);

    const result = await loadOrCreateLocalIdentity();

    expect(result.created).toBe(false);
    expect(result.identity.publicKey).toBe(original.publicKey);
    expect(result.identity.privateKey).toBe(original.privateKey);
    await expect(loadIdentity()).resolves.toMatchObject({
      publicKey: original.publicKey,
      privateKey: original.privateKey
    });
  });

  it('uses the first identity saved when startup initialization races', async () => {
    const results = await Promise.all([
      loadOrCreateLocalIdentity(),
      loadOrCreateLocalIdentity()
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].identity.publicKey).toBe(results[1].identity.publicKey);
    await expect(loadIdentity()).resolves.toMatchObject({
      publicKey: results[0].identity.publicKey
    });
  });

  it('creates a fresh identity through the normal startup lifecycle after clearing the previous one', async () => {
    const previous = await loadOrCreateLocalIdentity();
    await deleteIdentity();
    await clearAllLocalData();

    const replacement = await loadOrCreateLocalIdentity();

    expect(replacement.created).toBe(true);
    expect(replacement.identity.publicKey).not.toBe(previous.identity.publicKey);
    await expect(loadIdentity()).resolves.toMatchObject({
      publicKey: replacement.identity.publicKey
    });
  });
});
