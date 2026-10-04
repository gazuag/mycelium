export const VAULT_MIN_ITERATIONS = 100_000;
export const VAULT_DEFAULT_ITERATIONS = 600_000;
export const VAULT_MAX_ITERATIONS = 10_000_000;

const VAULT_VERSION = 1 as const;
const VAULT_KDF = 'PBKDF2-SHA256' as const;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const UNLOCK_ERROR = 'Unable to unlock';

export interface KeyBundle {
  signingPrivateKey: string;
  encryptionPrivateKey: string;
}

export interface VaultBlob {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface WrapKeyBundleOptions {
  iterations?: number;
}

export async function wrapKeyBundle(
  bundle: KeyBundle,
  secret: string,
  options: WrapKeyBundleOptions = {}
): Promise<VaultBlob> {
  try {
    if (!isKeyBundle(bundle) || typeof secret !== 'string') throw new Error(UNLOCK_ERROR);
    const iterations = options.iterations ?? VAULT_DEFAULT_ITERATIONS;
    validateIterations(iterations);

    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const saltBase64 = bytesToBase64(salt);
    const wrappingKey = await deriveWrappingKey(secret, salt, iterations);
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(createAdditionalData(iterations, saltBase64))
    }, wrappingKey, new TextEncoder().encode(JSON.stringify(bundle)));

    return {
      v: VAULT_VERSION,
      kdf: VAULT_KDF,
      iterations,
      salt: saltBase64,
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
  } catch {
    throw new Error(UNLOCK_ERROR);
  }
}

export async function unwrapKeyBundle(blob: VaultBlob, secret: string): Promise<KeyBundle> {
  try {
    if (!isVaultBlob(blob) || typeof secret !== 'string') throw new Error(UNLOCK_ERROR);
    validateIterations(blob.iterations);
    const salt = base64ToBytes(blob.salt);
    const nonce = base64ToBytes(blob.nonce);
    const ciphertext = base64ToBytes(blob.ciphertext);
    if (salt.length !== SALT_LENGTH || nonce.length !== NONCE_LENGTH || ciphertext.length < 16) {
      throw new Error(UNLOCK_ERROR);
    }

    const wrappingKey = await deriveWrappingKey(secret, salt, blob.iterations);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(createAdditionalData(blob.iterations, blob.salt))
    }, wrappingKey, toArrayBuffer(ciphertext));
    const bundle: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (!isKeyBundle(bundle)) throw new Error(UNLOCK_ERROR);
    return bundle;
  } catch {
    throw new Error(UNLOCK_ERROR);
  }
}

export async function importPrivateKeysNonExtractable(bundle: KeyBundle): Promise<{
  signingKey: CryptoKey;
  encryptionKey: CryptoKey;
}> {
  try {
    if (!isKeyBundle(bundle)) throw new Error(UNLOCK_ERROR);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      toArrayBuffer(base64ToBytes(bundle.signingPrivateKey)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const encryptionKey = await crypto.subtle.importKey(
      'pkcs8',
      toArrayBuffer(base64ToBytes(bundle.encryptionPrivateKey)),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    );
    return { signingKey, encryptionKey };
  } catch {
    throw new Error(UNLOCK_ERROR);
  }
}

export function assessSecretStrength(secret: string): 'rejected' | 'weak' | 'ok' | 'strong' {
  if (secret.length < 6) return 'rejected';
  if (/^\d+$/.test(secret) && secret.length < 10) return 'weak';
  if (/^(.)\1+$/.test(secret) || secret.length < 8) return 'weak';
  if (secret.length >= 12 && countCharacterClasses(secret) >= 3) return 'strong';
  return 'ok';
}

async function deriveWrappingKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function createAdditionalData(iterations: number, salt: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: VAULT_VERSION, kdf: VAULT_KDF, iterations, salt }));
}

function validateIterations(iterations: number): void {
  if (!Number.isSafeInteger(iterations) || iterations < VAULT_MIN_ITERATIONS || iterations > VAULT_MAX_ITERATIONS) {
    throw new Error(UNLOCK_ERROR);
  }
}

function isKeyBundle(value: unknown): value is KeyBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.signingPrivateKey === 'string'
    && candidate.signingPrivateKey.length > 0
    && typeof candidate.encryptionPrivateKey === 'string'
    && candidate.encryptionPrivateKey.length > 0;
}

function isVaultBlob(value: unknown): value is VaultBlob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === VAULT_VERSION
    && candidate.kdf === VAULT_KDF
    && typeof candidate.iterations === 'number'
    && typeof candidate.salt === 'string'
    && typeof candidate.nonce === 'string'
    && typeof candidate.ciphertext === 'string';
}

function countCharacterClasses(secret: string): number {
  return Number(/[a-z]/.test(secret))
    + Number(/[A-Z]/.test(secret))
    + Number(/\d/.test(secret))
    + Number(/[^a-zA-Z\d]/.test(secret));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(UNLOCK_ERROR);
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}