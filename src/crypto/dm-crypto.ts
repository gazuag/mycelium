import { signString, signStringWithKey, verifySignedString } from './identity';

const DM_PROTOCOL_VERSION = 'mycelium-dm-v1';
const ENCRYPTION_KEY_BINDING_DOMAIN = 'mycelium-enc-key-binding-v1';
const DM_KDF_SALT = new TextEncoder().encode(DM_PROTOCOL_VERSION);
const AES_GCM_NONCE_LENGTH = 12;

export interface EncryptedDm {
  readonly ciphertext: string;
  readonly nonce: string;
}

export interface EncryptionKeyBinding {
  readonly signing_public_key: string;
  readonly encryption_public_key: string;
  readonly created_at: string;
  readonly signature: string;
}

interface EncryptionKeyBindingIdentityFields {
  readonly publicKey: string;
  readonly encryptionPublicKey: string;
}

export type EncryptionKeyBindingIdentity = EncryptionKeyBindingIdentityFields & (
  | { readonly privateKey: string; readonly signingKey?: never }
  | { readonly privateKey?: never; readonly signingKey: CryptoKey }
);

export interface ContactEncryptionKeyState {
  readonly encryptionPublicKey?: string;
  readonly encryptionKeyChanged?: boolean;
}

export interface EncryptionKeyBindingUpdate {
  readonly contactFields: ContactEncryptionKeyState;
  readonly accepted: boolean;
  readonly keyChanged: boolean;
}

export async function generateEncryptionKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  ) as CryptoKeyPair;
}

export async function exportEncryptionPublicKey(key: CryptoKey): Promise<string> {
  return arrayBufferToBase64(await crypto.subtle.exportKey('spki', key));
}

export async function importEncryptionPublicKey(base64: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

export async function exportEncryptionPrivateKey(key: CryptoKey): Promise<string> {
  return arrayBufferToBase64(await crypto.subtle.exportKey('pkcs8', key));
}

export async function importEncryptionPrivateKey(base64: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(base64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

export async function deriveDmKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  context: Uint8Array
): Promise<CryptoKey> {
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  new Uint8Array(sharedSecret).fill(0);

  return await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bytesToArrayBuffer(DM_KDF_SALT), info: bytesToArrayBuffer(context) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptDm(key: CryptoKey, plaintext: string, aad: Uint8Array): Promise<EncryptedDm> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(nonce), additionalData: bytesToArrayBuffer(aad) },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ciphertext: arrayBufferToBase64(ciphertext), nonce: bytesToBase64(nonce) };
}

export async function decryptDm(key: CryptoKey, encrypted: EncryptedDm, aad: Uint8Array): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(base64ToBytes(encrypted.nonce)), additionalData: bytesToArrayBuffer(aad) },
    key,
    base64ToArrayBuffer(encrypted.ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

export async function createEncryptionKeyBinding(identity: EncryptionKeyBindingIdentity): Promise<EncryptionKeyBinding> {
  const unsigned = {
    signing_public_key: identity.publicKey,
    encryption_public_key: identity.encryptionPublicKey,
    created_at: new Date().toISOString()
  };
  return {
    ...unsigned,
    signature: typeof identity.privateKey === 'string'
      ? await signString(identity.privateKey, canonicalizeEncryptionKeyBinding(unsigned))
      : await signStringWithKey(identity.signingKey, canonicalizeEncryptionKeyBinding(unsigned))
  };
}

export async function addEncryptionKeyBinding<T extends object>(
  metadata: T,
  identity: EncryptionKeyBindingIdentity
): Promise<T & { encryptionKeyBinding: EncryptionKeyBinding }> {
  return { ...metadata, encryptionKeyBinding: await createEncryptionKeyBinding(identity) };
}

export async function verifyEncryptionKeyBinding(binding: EncryptionKeyBinding): Promise<boolean> {
  if (!binding || typeof binding.signing_public_key !== 'string' || !binding.signing_public_key
    || typeof binding.encryption_public_key !== 'string' || !binding.encryption_public_key
    || typeof binding.created_at !== 'string' || !binding.created_at
    || typeof binding.signature !== 'string' || !binding.signature) return false;
  try {
    return await verifySignedString(binding.signing_public_key, canonicalizeEncryptionKeyBinding(binding), binding.signature);
  } catch {
    return false;
  }
}

export async function applyEncryptionKeyBinding(
  binding: EncryptionKeyBinding | undefined,
  metadataPublicKey: string | undefined,
  current: ContactEncryptionKeyState = {}
): Promise<EncryptionKeyBindingUpdate> {
  if (!binding || !metadataPublicKey || binding.signing_public_key !== metadataPublicKey
    || !(await verifyEncryptionKeyBinding(binding))) {
    return { contactFields: current, accepted: false, keyChanged: false };
  }

  if (current.encryptionPublicKey && current.encryptionPublicKey !== binding.encryption_public_key) {
    return {
      contactFields: { ...current, encryptionKeyChanged: true },
      accepted: true,
      keyChanged: true
    };
  }
  if (current.encryptionPublicKey === binding.encryption_public_key) {
    return { contactFields: current, accepted: true, keyChanged: false };
  }
  return {
    contactFields: { ...current, encryptionPublicKey: binding.encryption_public_key },
    accepted: true,
    keyChanged: false
  };
}

export function getContactEncryptionKey(contact: ContactEncryptionKeyState): string | null {
  return typeof contact.encryptionPublicKey === 'string' && contact.encryptionPublicKey.length > 0
    ? contact.encryptionPublicKey
    : null;
}

function canonicalizeEncryptionKeyBinding(binding: Omit<EncryptionKeyBinding, 'signature'>): string {
  return JSON.stringify({
    domain: ENCRYPTION_KEY_BINDING_DOMAIN,
    signing_public_key: binding.signing_public_key,
    encryption_public_key: binding.encryption_public_key,
    created_at: binding.created_at
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return bytesToArrayBuffer(base64ToBytes(base64));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}