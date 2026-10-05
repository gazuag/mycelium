import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportPublicKey, generateIdentityKeyPair } from './identity';
import { createSignedProfile, verifySignedProfile } from './signed';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('signed profiles', () => {
  it('creates a verifiable profile using a non-extractable signing key', async () => {
    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      await crypto.subtle.exportKey('pkcs8', pair.privateKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );

    const profile = await createSignedProfile('profile-id', publicKey, signingKey, 'Name');

    expect(signingKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', signingKey)).rejects.toThrow();
    expect(await verifySignedProfile(profile)).toBe(true);
  });
});
