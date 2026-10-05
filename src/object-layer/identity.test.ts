import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair
} from '../crypto/identity';
import { createObjectIdentity } from './identity';
import {
  calculateObjectId,
  canonicalizeObjectContent,
  createSignedObject,
  validateDistributedObject
} from './envelope';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('object identity signing', () => {
  it('signs valid objects with a non-extractable CryptoKey', async () => {
    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      await crypto.subtle.exportKey('pkcs8', pair.privateKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const object = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-01-02T03:04:05.000Z',
      payload: { content: 'CryptoKey object signature', tags: [] },
      replication_policy: {}
    }, createObjectIdentity({ id: 'crypto-key-author', publicKey, signingKey }));

    expect(signingKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', signingKey)).rejects.toThrow();
    expect(await validateDistributedObject(object)).toBe(true);
  });

  it('preserves legacy string signing and object IDs across signing-key forms', async () => {
    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const privateKey = await exportPrivateKey(pair.privateKey);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      await crypto.subtle.exportKey('pkcs8', pair.privateKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const content = {
      object_type: 'mycelium.post' as const,
      created_at: '2026-01-02T03:04:05.000Z',
      payload: { content: 'fixed canonical content', tags: ['test'] },
      replication_policy: {}
    };
    const legacyObject = await createSignedObject(
      content,
      createObjectIdentity({ id: 'same-author', publicKey, privateKey })
    );
    const cryptoKeyObject = await createSignedObject(
      content,
      createObjectIdentity({ id: 'same-author', publicKey, signingKey })
    );

    expect(await validateDistributedObject(legacyObject)).toBe(true);
    expect(await validateDistributedObject(cryptoKeyObject)).toBe(true);
    expect(canonicalizeObjectContent(legacyObject)).toBe(canonicalizeObjectContent(cryptoKeyObject));
    expect(legacyObject.object_id).toBe(cryptoKeyObject.object_id);
    expect(await calculateObjectId(legacyObject)).toBe(await calculateObjectId(cryptoKeyObject));
  });
});
