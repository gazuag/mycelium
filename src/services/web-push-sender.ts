import type { Contact } from '../types';
import { deriveFingerprint, signString } from '../crypto/identity';
import { loadIdentity, type CompleteLocalIdentityRecord } from '../storage/idb';
import { isWebPushCapability, webPushManager, type WebPushStatus } from './web-push';
import type { EncryptedWebPushRequest } from './web-push-encryption';

const SENDER_URL = import.meta.env.VITE_WEB_PUSH_SENDER_URL as string | undefined;
const REQUEST_PATH = '/v1/push';
const REQUEST_TTL_SECONDS = 300;
const DOMAIN = 'mycelium-web-push-request-v1';

export type WebPushSendResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'invalid-subscription' }
  | { readonly status: 'rate-limited' }
  | { readonly status: 'temporary-failure' }
  | { readonly status: 'configuration-missing' }
  | { readonly status: 'web-push-disabled' }
  | { readonly status: 'identity-unavailable' }
  | { readonly status: 'invalid-capability' }
  | { readonly status: 'request-rejected' };

export interface WebPushRequestFields {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly endpoint: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly ttl: string;
  readonly bodyHash: string;
}

export interface WebPushSenderDependencies {
  readonly senderUrl?: string;
  readonly getIdentity: () => Promise<CompleteLocalIdentityRecord | null>;
  readonly getWebPushStatus: () => Promise<WebPushStatus>;
  readonly fetcher?: typeof fetch;
}

export function canonicalizeWebPushRequestV1(fields: WebPushRequestFields): string {
  return [
    DOMAIN,
    'POST',
    REQUEST_PATH,
    fields.publicKey,
    fields.fingerprint,
    fields.endpoint,
    fields.timestamp,
    fields.nonce,
    fields.ttl,
    'aes128gcm',
    'application/octet-stream',
    fields.bodyHash
  ].join('\n');
}

export function createWebPushSender(dependencies: WebPushSenderDependencies) {
  return async (
    encrypted: EncryptedWebPushRequest,
    recipient: Contact
  ): Promise<WebPushSendResult> => {
    const senderOrigin = normalizeSenderUrl(dependencies.senderUrl);
    if (!senderOrigin) return { status: 'configuration-missing' };

    const status = await dependencies.getWebPushStatus().catch(() => null);
    if (status?.state !== 'enabled') return { status: 'web-push-disabled' };

    const capability = recipient.webPush;
    if (!capability || !isWebPushCapability(capability) || encrypted.endpoint !== capability.endpoint) {
      return { status: 'invalid-capability' };
    }
    if (encrypted.body.length < 103 || encrypted.body.length > 4096
      || encrypted.headers['Content-Encoding'] !== 'aes128gcm'
      || encrypted.headers['Content-Type'] !== 'application/octet-stream') {
      return { status: 'request-rejected' };
    }

    const identity = await dependencies.getIdentity().catch(() => null);
    if (!identity?.publicKey || !identity.privateKey || !identity.id) {
      return { status: 'identity-unavailable' };
    }
    const fingerprint = await deriveFingerprint(identity.publicKey);
    if (fingerprint !== identity.id) return { status: 'identity-unavailable' };

    const body = new Uint8Array(encrypted.body);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(body)));
    const bodyHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const ttl = String(REQUEST_TTL_SECONDS);
    const canonical = canonicalizeWebPushRequestV1({
      publicKey: identity.publicKey,
      fingerprint,
      endpoint: capability.endpoint,
      timestamp,
      nonce,
      ttl,
      bodyHash
    });
    const signature = await signString(identity.privateKey, canonical);

    try {
      const response = await (dependencies.fetcher ?? fetch)(new URL(REQUEST_PATH, senderOrigin), {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'TTL': ttl,
          'X-Mycelium-Public-Key': identity.publicKey,
          'X-Mycelium-Fingerprint': fingerprint,
          'X-Mycelium-Timestamp': timestamp,
          'X-Mycelium-Nonce': nonce,
          'X-Mycelium-Signature': signature,
          'X-Mycelium-Endpoint': capability.endpoint
        },
        body: toArrayBuffer(body),
        redirect: 'error'
      });
      if (response.status === 202) return { status: 'accepted' };
      if (response.status === 404 || response.status === 410) return { status: 'invalid-subscription' };
      if (response.status === 429) return { status: 'rate-limited' };
      if (response.status >= 500) return { status: 'temporary-failure' };
      return { status: 'request-rejected' };
    } catch {
      return { status: 'temporary-failure' };
    }
  };
}

export const sendEncryptedWebPush = createWebPushSender({
  senderUrl: SENDER_URL,
  getIdentity: loadIdentity,
  getWebPushStatus: () => webPushManager.getStatus()
});

function normalizeSenderUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
