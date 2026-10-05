import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair,
  signString,
  signStringWithKey,
  verifySignedString
} from './identity';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

async function importNonExtractableSigningKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const exported = await crypto.subtle.exportKey('pkcs8', privateKey);
  return await crypto.subtle.importKey(
    'pkcs8',
    exported,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

describe('identity signing helpers', () => {
  it('signStringWithKey signatures verify using the matching public key', async () => {
    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const signingKey = await importNonExtractableSigningKey(pair.privateKey);
    const data = 'CryptoKey-backed signature';
    const signature = await signStringWithKey(signingKey, data);

    expect(await verifySignedString(publicKey, data, signature)).toBe(true);
    await expect(crypto.subtle.exportKey('pkcs8', signingKey)).rejects.toThrow();
  });

  it('preserves verification for the legacy string-based signing path', async () => {
    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const privateKey = await exportPrivateKey(pair.privateKey);
    const data = 'legacy signature regression';
    const signature = await signString(privateKey, data);

    expect(await verifySignedString(publicKey, data, signature)).toBe(true);
  });
});
