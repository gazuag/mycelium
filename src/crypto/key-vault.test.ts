import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { assessSecretStrength, importPrivateKeysNonExtractable, VAULT_MIN_ITERATIONS, unwrapKeyBundle, wrapKeyBundle, type KeyBundle, type VaultBlob } from './key-vault';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const TEST_ITERATIONS = VAULT_MIN_ITERATIONS;
const TEST_SECRET = 'Vault test secret 2026!';
let bundle: KeyBundle;
let signingPublicKey: CryptoKey;

beforeAll(async () => {
  const signingPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;
  const encryptionPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  ) as CryptoKeyPair;
  signingPublicKey = signingPair.publicKey;
  bundle = {
    signingPrivateKey: await exportKeyBase64(signingPair.privateKey),
    encryptionPrivateKey: await exportKeyBase64(encryptionPair.privateKey)
  };
});

async function exportKeyBase64(key: CryptoKey): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
}

async function createBlob(): Promise<VaultBlob> {
  return wrapKeyBundle(bundle, TEST_SECRET, { iterations: TEST_ITERATIONS });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mutateBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  bytes[0] ^= 1;
  return bytesToBase64(bytes);
}

async function expectGenericUnlockFailure(blob: VaultBlob, secret = TEST_SECRET) {
  await expect(unwrapKeyBundle(blob, secret)).rejects.toThrow(/^Unable to unlock$/);
}

describe('key vault primitives', () => {
  it('wraps and unwraps a private-key bundle', async () => {
    const blob = await createBlob();

    expect(blob).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iterations: TEST_ITERATIONS });
    expect(atob(blob.salt)).toHaveLength(16);
    expect(atob(blob.nonce)).toHaveLength(12);
    await expect(unwrapKeyBundle(blob, TEST_SECRET)).resolves.toEqual(bundle);
  });

  it('uses fresh salt and nonce for each wrap', async () => {
    const first = await createBlob();
    const second = await createBlob();

    expect(second.salt).not.toBe(first.salt);
    expect(second.nonce).not.toBe(first.nonce);
  });

  it('rejects a wrong secret with the generic unlock error', async () => {
    await expectGenericUnlockFailure(await createBlob(), 'wrong passphrase');
  });

  it('rejects tampered ciphertext generically', async () => {
    const blob = await createBlob();
    await expectGenericUnlockFailure({ ...blob, ciphertext: mutateBase64(blob.ciphertext) });
  });

  it('rejects tampered nonce generically', async () => {
    const blob = await createBlob();
    await expectGenericUnlockFailure({ ...blob, nonce: mutateBase64(blob.nonce) });
  });

  it('rejects tampered salt generically', async () => {
    const blob = await createBlob();
    await expectGenericUnlockFailure({ ...blob, salt: mutateBase64(blob.salt) });
  });

  it('rejects tampered iterations generically', async () => {
    const blob = await createBlob();
    await expectGenericUnlockFailure({ ...blob, iterations: blob.iterations + 1 });
  });

  it('rejects iterations below the floor and above the maximum', async () => {
    const blob = await createBlob();
    await expectGenericUnlockFailure({ ...blob, iterations: VAULT_MIN_ITERATIONS - 1 });
    await expectGenericUnlockFailure({ ...blob, iterations: 10_000_001 });
  });

  it('rejects unsupported versions and KDF identifiers generically', async () => {
    const blob = await createBlob();
    await expectGenericUnlockFailure({ ...blob, v: 2 } as unknown as VaultBlob);
    await expectGenericUnlockFailure({ ...blob, kdf: 'PBKDF2-SHA512' } as unknown as VaultBlob);
  });

  it('serializes no private-key or secret material into the vault blob', async () => {
    const blob = await createBlob();
    const serialized = JSON.stringify(blob);

    expect(serialized).not.toContain(bundle.signingPrivateKey);
    expect(serialized).not.toContain(bundle.encryptionPrivateKey);
    expect(serialized).not.toContain(TEST_SECRET);
  });

  it('uses generic errors that reveal no key or secret material', async () => {
    const blob = await createBlob();
    const sensitiveValues = [bundle.signingPrivateKey, bundle.encryptionPrivateKey, TEST_SECRET];
    let message = '';
    try {
      await unwrapKeyBundle(blob, 'invalid ' + TEST_SECRET);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('Unable to unlock');
    for (const sensitiveValue of sensitiveValues) expect(message).not.toContain(sensitiveValue);
  });

  it('imports non-extractable private keys that can sign, verify, and derive', async () => {
    const imported = await importPrivateKeysNonExtractable(bundle);

    expect(imported.signingKey.extractable).toBe(false);
    expect(imported.signingKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(imported.signingKey.usages).toEqual(['sign']);
    expect(imported.encryptionKey.extractable).toBe(false);
    expect(imported.encryptionKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(imported.encryptionKey.usages).toEqual(['deriveBits']);
    await expect(crypto.subtle.exportKey('pkcs8', imported.signingKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', imported.encryptionKey)).rejects.toThrow();

    const data = new TextEncoder().encode('non-extractable signing test');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported.signingKey, data);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signingPublicKey, signature, data)).toBe(true);

    const peerPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    ) as CryptoKeyPair;
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPair.publicKey },
      imported.encryptionKey,
      256
    );
    expect(sharedBits.byteLength).toBe(32);
  });

  it('rejects secrets shorter than six characters', () => {
    expect(assessSecretStrength('abc12')).toBe('rejected');
  });

  it('grades numeric-short, repeated, and under-eight-character secrets weak', () => {
    expect(assessSecretStrength('12345678')).toBe('weak');
    expect(assessSecretStrength('zzzzzzzz')).toBe('weak');
    expect(assessSecretStrength('abcdefg')).toBe('weak');
  });

  it('grades eligible secrets ok unless they meet the strong threshold', () => {
    expect(assessSecretStrength('longpassphrase')).toBe('ok');
    expect(assessSecretStrength('Abcdef12!')).toBe('ok');
  });

  it('grades 12-character secrets with at least three classes strong', () => {
    expect(assessSecretStrength('Abcdef123!gh')).toBe('strong');
  });
});