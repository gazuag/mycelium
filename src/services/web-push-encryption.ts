import type { WebPushCapability } from '../types';

const AES128GCM_RECORD_SIZE = 4096;
const AES128GCM_HEADER_SIZE = 86;
const AES128GCM_RECORD_OVERHEAD = 17;
export const MAX_WEB_PUSH_PLAINTEXT_BYTES =
  AES128GCM_RECORD_SIZE - AES128GCM_HEADER_SIZE - AES128GCM_RECORD_OVERHEAD;

const encoder = new TextEncoder();
const AUTH_INFO = encoder.encode('WebPush: info\0');
const CONTENT_KEY_INFO = encoder.encode('Content-Encoding: aes128gcm\0');
const NONCE_INFO = encoder.encode('Content-Encoding: nonce\0');

export interface EncryptedWebPushRequest {
  readonly endpoint: string;
  readonly body: Uint8Array;
  readonly headers: {
    readonly 'Content-Encoding': 'aes128gcm';
    readonly 'Content-Type': 'application/octet-stream';
  };
}

export async function encryptWebPushPayload(
  payload: string | Uint8Array,
  subscription: WebPushCapability
): Promise<EncryptedWebPushRequest> {
  if (!subscription || typeof subscription.endpoint !== 'string') {
    throw new TypeError('Invalid Web Push subscription.');
  }
  try {
    if (new URL(subscription.endpoint).protocol !== 'https:') {
      throw new TypeError('Invalid Web Push subscription endpoint.');
    }
  } catch {
    throw new TypeError('Invalid Web Push subscription endpoint.');
  }

  const plaintext = typeof payload === 'string' ? encoder.encode(payload) : new Uint8Array(payload);
  if (plaintext.byteLength > MAX_WEB_PUSH_PLAINTEXT_BYTES) {
    throw new RangeError(`Web Push plaintext must not exceed ${MAX_WEB_PUSH_PLAINTEXT_BYTES} bytes.`);
  }

  const uaPublic = decodeBase64Url(subscription.p256dh);
  const authSecret = decodeBase64Url(subscription.auth);
  if (uaPublic.byteLength !== 65 || uaPublic[0] !== 0x04) {
    throw new TypeError('Invalid Web Push subscription public key.');
  }
  if (authSecret.byteLength !== 16) {
    throw new TypeError('Invalid Web Push subscription authentication secret.');
  }

  const subtle = crypto.subtle;
  let uaPublicKey: CryptoKey;
  try {
    uaPublicKey = await subtle.importKey(
      'raw',
      toArrayBuffer(uaPublic),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
  } catch {
    throw new TypeError('Invalid Web Push subscription public key.');
  }

  const ephemeralKeys = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  ) as CryptoKeyPair;
  const asPublic = new Uint8Array(await subtle.exportKey('raw', ephemeralKeys.publicKey));
  const ecdhSecret = new Uint8Array(await subtle.deriveBits(
    { name: 'ECDH', public: uaPublicKey },
    ephemeralKeys.privateKey,
    256
  ));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concatenate(AUTH_INFO, uaPublic, asPublic);
  const prkKey = await hmacSha256(subtle, authSecret, ecdhSecret);
  const ikm = await hkdfExpandOneBlock(subtle, prkKey, keyInfo);
  const prk = await hmacSha256(subtle, salt, ikm);
  const contentEncryptionKey = (await hkdfExpandOneBlock(subtle, prk, CONTENT_KEY_INFO)).slice(0, 16);
  const nonce = (await hkdfExpandOneBlock(subtle, prk, NONCE_INFO)).slice(0, 12);

  const encryptionKey = await subtle.importKey(
    'raw',
    toArrayBuffer(contentEncryptionKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const framedPayload = concatenate(plaintext, Uint8Array.of(0x02));
  const ciphertext = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), tagLength: 128 },
    encryptionKey,
    toArrayBuffer(framedPayload)
  ));

  const header = new Uint8Array(AES128GCM_HEADER_SIZE);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, AES128GCM_RECORD_SIZE, false);
  header[20] = asPublic.byteLength;
  header.set(asPublic, 21);

  return {
    endpoint: subscription.endpoint,
    body: concatenate(header, ciphertext),
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream'
    }
  };
}

export function decodeBase64Url(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
    throw new TypeError('Invalid URL-safe base64 value.');
  }

  const separator = value.indexOf('=');
  const encoded = separator === -1 ? value : value.slice(0, separator);
  const padding = value.length - encoded.length;
  if (encoded.length % 4 === 1
    || (padding > 0 && (value.length % 4 !== 0 || padding !== (4 - encoded.length % 4) % 4))) {
    throw new TypeError('Invalid URL-safe base64 value.');
  }

  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError('Invalid URL-safe base64 value.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacSha256(subtle: SubtleCrypto, keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await subtle.sign('HMAC', key, toArrayBuffer(data)));
}

async function hkdfExpandOneBlock(
  subtle: SubtleCrypto,
  pseudorandomKey: Uint8Array,
  info: Uint8Array
): Promise<Uint8Array> {
  return await hmacSha256(subtle, pseudorandomKey, concatenate(info, Uint8Array.of(0x01)));
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
