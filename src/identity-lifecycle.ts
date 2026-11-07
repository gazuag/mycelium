import { deriveFingerprint, exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from './crypto/identity';
import {
  ensureIdentityEncryptionKeyPair,
  loadIdentity,
  saveIdentity,
  saveIdentityIfAbsent,
  type CompleteLocalIdentityRecord
} from './storage/idb';

export async function createLocalIdentityRecord(): Promise<CompleteLocalIdentityRecord & { id: string }> {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  const id = await deriveFingerprint(publicKey);
  const identity = await ensureIdentityEncryptionKeyPair({ key: 'local', publicKey, privateKey, id });
  return { ...identity, id };
}

export async function loadOrCreateLocalIdentity(): Promise<{
  identity: CompleteLocalIdentityRecord & { id: string };
  created: boolean;
}> {
  const stored = await loadIdentity();
  if (stored) {
    return {
      identity: { ...stored, id: stored.id ?? await deriveFingerprint(stored.publicKey) },
      created: false
    };
  }

  const candidate = await createLocalIdentityRecord();
  const result = await saveIdentityIfAbsent(candidate);
  const identity = await ensureIdentityEncryptionKeyPair(result.identity);
  if (!result.identity.encryptionPublicKey || !result.identity.encryptionPrivateKey) {
    await saveIdentity(identity);
  }

  return {
    identity: { ...identity, id: identity.id ?? await deriveFingerprint(identity.publicKey) },
    created: result.created
  };
}
