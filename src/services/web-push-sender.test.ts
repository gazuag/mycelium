import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vector from '../../tests/web-push-request-v1.json';
import { deriveFingerprint, exportPrivateKey, exportPublicKey, generateIdentityKeyPair, verifySignedString } from '../crypto/identity';
import type { Contact } from '../types';
import type { CompleteLocalIdentityRecord } from '../storage/idb';
import { canonicalizeWebPushRequestV1, createWebPushSender } from './web-push-sender';
import type { EncryptedWebPushRequest } from './web-push-encryption';

const requestBody = Uint8Array.from(atob(vector.bodyBase64), (character) => character.charCodeAt(0));
const endpoint = vector.endpoint;
const contact: Contact = {
  publicKey: 'recipient-public-key',
  fingerprint: 'recipient-peer',
  addedAt: new Date(0).toISOString(),
  followed: false,
  webPush: {
    endpoint,
    p256dh: 'BA',
    auth: 'AQEBAQEBAQEBAQEBAQEBAQ'
  }
};
const encrypted: EncryptedWebPushRequest = {
  endpoint,
  body: requestBody,
  headers: {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream'
  }
};

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authenticated Web Push sender client', () => {
  it('matches the shared Python/TypeScript canonical request vector and signature', async () => {
    const fields = {
      publicKey: vector.publicKey,
      fingerprint: vector.fingerprint,
      endpoint: vector.endpoint,
      timestamp: vector.timestamp,
      nonce: vector.nonce,
      ttl: vector.ttl,
      bodyHash: vector.bodyHash
    };
    expect(canonicalizeWebPushRequestV1(fields)).toBe(vector.canonical);
    expect(await deriveFingerprint(vector.publicKey)).toBe(vector.fingerprint);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', requestBody));
    expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(vector.bodyHash);
    await expect(verifySignedString(vector.publicKey, vector.canonical, vector.signature)).resolves.toBe(true);
  });

  it('signs the encrypted request body and sends the bound headers to the configured HTTPS sender', async () => {
    const identity = await createTestIdentity();
    const fetcher = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(null, { status: 202 }));
    const send = createWebPushSender({
      senderUrl: 'https://sender.example.test:9443',
      getIdentity: async () => identity,
      getWebPushStatus: async () => ({ state: 'enabled', subscribed: true }),
      fetcher
    });

    await expect(send(encrypted, contact)).resolves.toEqual({ status: 'accepted' });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url?.toString()).toBe('https://sender.example.test:9443/v1/push');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toEqual(requestBody.buffer.slice(
      requestBody.byteOffset,
      requestBody.byteOffset + requestBody.byteLength
    ));
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    expect(headers.get('X-Mycelium-Endpoint')).toBe(endpoint);
    const canonical = canonicalizeWebPushRequestV1({
      publicKey: identity.publicKey,
      fingerprint: identity.id!,
      endpoint,
      timestamp: headers.get('X-Mycelium-Timestamp')!,
      nonce: headers.get('X-Mycelium-Nonce')!,
      ttl: headers.get('TTL')!,
      bodyHash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', requestBody)), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
    });
    await expect(verifySignedString(
      identity.publicKey,
      canonical,
      headers.get('X-Mycelium-Signature')!
    )).resolves.toBe(true);
  });

  it('refuses to send when disabled, misconfigured, or given an invalid capability', async () => {
    const identity = await createTestIdentity();
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const createSender = (senderUrl: string | undefined, enabled: boolean) => createWebPushSender({
      senderUrl,
      getIdentity: async () => identity,
      getWebPushStatus: async () => ({ state: enabled ? 'enabled' : 'disabled', subscribed: false }),
      fetcher
    });

    await expect(createSender(undefined, true)(encrypted, contact))
      .resolves.toEqual({ status: 'configuration-missing' });
    await expect(createSender('https://sender.example.test/path', true)(encrypted, contact))
      .resolves.toEqual({ status: 'configuration-missing' });
    await expect(createSender('https://sender.example.test', false)(encrypted, contact))
      .resolves.toEqual({ status: 'web-push-disabled' });
    await expect(createSender('https://sender.example.test', true)(
      encrypted,
      { ...contact, webPush: undefined }
    )).resolves.toEqual({ status: 'invalid-capability' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses malformed encrypted payload sizes before sending', async () => {
    const identity = await createTestIdentity();
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const send = createWebPushSender({
      senderUrl: 'https://sender.example.test',
      getIdentity: async () => identity,
      getWebPushStatus: async () => ({ state: 'enabled', subscribed: true }),
      fetcher
    });
    const malformed: EncryptedWebPushRequest = { ...encrypted, body: new Uint8Array(10) };

    await expect(send(malformed, contact)).resolves.toEqual({ status: 'request-rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [202, 'accepted'],
    [410, 'invalid-subscription'],
    [404, 'invalid-subscription'],
    [429, 'rate-limited'],
    [503, 'temporary-failure'],
    [400, 'request-rejected']
  ] as const)('maps sender HTTP %s to %s', async (httpStatus, result) => {
    const identity = await createTestIdentity();
    const send = createWebPushSender({
      senderUrl: 'https://sender.example.test',
      getIdentity: async () => identity,
      getWebPushStatus: async () => ({ state: 'enabled', subscribed: true }),
      fetcher: async () => new Response(null, { status: httpStatus })
    });

    await expect(send(encrypted, contact)).resolves.toEqual({ status: result });
  });

  it('maps network failures to a generic temporary result without exposing the destination', async () => {
    const identity = await createTestIdentity();
    const send = createWebPushSender({
      senderUrl: 'https://sender.example.test',
      getIdentity: async () => identity,
      getWebPushStatus: async () => ({ state: 'enabled', subscribed: true }),
      fetcher: async () => { throw new Error(endpoint); }
    });

    await expect(send(encrypted, contact)).resolves.toEqual({ status: 'temporary-failure' });
  });
});

async function createTestIdentity(): Promise<CompleteLocalIdentityRecord> {
  const pair = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  return {
    key: 'local',
    publicKey,
    privateKey: await exportPrivateKey(pair.privateKey),
    id: await deriveFingerprint(publicKey),
    encryptionPublicKey: 'unused',
    encryptionPrivateKey: 'unused'
  };
}
