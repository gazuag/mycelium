import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEncryptionKeyBinding,
  exportEncryptionPublicKey,
  generateEncryptionKeyPair
} from '../crypto/dm-crypto';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createSignedObject } from './envelope';
import {
  createSignedIdentityObject,
  validateIdentityObject,
  type CreateSignedIdentityObjectOptions,
  type IdentityObjectPayload
} from './identity-object';
import type { ObjectIdentity } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

interface TestIdentity {
  objectIdentity: ObjectIdentity;
  publicKey: string;
  privateKey: string;
  encryptionPublicKey: string;
}

async function createTestIdentity(): Promise<TestIdentity> {
  const [signingPair, encryptionPair] = await Promise.all([
    generateIdentityKeyPair(),
    generateEncryptionKeyPair()
  ]);
  const publicKey = await exportPublicKey(signingPair.publicKey);
  const privateKey = await exportPrivateKey(signingPair.privateKey);
  return {
    objectIdentity: createObjectIdentity({ id: publicKey, publicKey, privateKey }),
    publicKey,
    privateKey,
    encryptionPublicKey: await exportEncryptionPublicKey(encryptionPair.publicKey)
  };
}

async function createOptions(identity: TestIdentity): Promise<CreateSignedIdentityObjectOptions> {
  return {
    display_name: 'Alice',
    bio: 'A test identity',
    encryption_public_key: identity.encryptionPublicKey,
    encryption_key_binding: await createEncryptionKeyBinding({
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      encryptionPublicKey: identity.encryptionPublicKey
    }),
    created_at: '2026-10-17T00:00:00.000Z'
  };
}

describe('signed identity objects', () => {
  it('accepts a valid object with a matching signed encryption-key binding', async () => {
    const identity = await createTestIdentity();
    const object = await createSignedIdentityObject(await createOptions(identity), identity.objectIdentity);

    expect(object.object_type).toBe('mycelium.identity');
    expect(await validateIdentityObject(object)).toBe(true);
  });

  it('rejects a payload tampered after object signing', async () => {
    const identity = await createTestIdentity();
    const object = await createSignedIdentityObject(await createOptions(identity), identity.objectIdentity);
    const tampered = {
      ...object,
      payload: { ...(object.payload as IdentityObjectPayload), bio: 'Changed after signing' }
    };

    expect(await validateIdentityObject(tampered)).toBe(false);
  });

  it('rejects a binding whose signature was made by a different signing key', async () => {
    const identity = await createTestIdentity();
    const otherIdentity = await createTestIdentity();
    const otherBinding = await createEncryptionKeyBinding({
      publicKey: otherIdentity.publicKey,
      privateKey: otherIdentity.privateKey,
      encryptionPublicKey: identity.encryptionPublicKey
    });
    const options = {
      ...await createOptions(identity),
      encryption_key_binding: {
        ...otherBinding,
        signing_public_key: identity.publicKey
      }
    };
    const object = await createSignedIdentityObject(options, identity.objectIdentity);

    expect(await validateIdentityObject(object)).toBe(false);
  });

  it('rejects a valid binding whose signing author differs from the object author', async () => {
    const identity = await createTestIdentity();
    const otherIdentity = await createTestIdentity();
    const object = await createSignedIdentityObject(
      await createOptions(otherIdentity),
      identity.objectIdentity
    );

    expect(await validateIdentityObject(object)).toBe(false);
  });

  it('rejects an object with a missing encryption-key binding', async () => {
    const identity = await createTestIdentity();
    const object = await createSignedObject({
      object_type: 'mycelium.identity',
      created_at: '2026-10-17T00:00:00.000Z',
      payload: {
        display_name: 'Alice',
        bio: 'A test identity',
        encryption_public_key: identity.encryptionPublicKey
      },
      replication_policy: {}
    }, identity.objectIdentity);

    expect(await validateIdentityObject(object)).toBe(false);
  });
});
