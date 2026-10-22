import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebPushCapability } from '../types';
import { decodeBase64Url, encryptWebPushPayload, MAX_WEB_PUSH_PLAINTEXT_BYTES } from './web-push-encryption';

const RFC_AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';
const RFC_UA_PUBLIC_KEY = [
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx',
  'aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
].join('');
const RFC_AS_PUBLIC_KEY = [
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg',
  'Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
].join('');
const RFC_AS_PRIVATE_KEY = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const RFC_SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const RFC_PLAINTEXT = 'When I grow up, I want to be a watermelon';
const RFC_ENCRYPTED_BODY = [
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml',
  'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT',
  'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
].join('');

const subscription: WebPushCapability = {
  endpoint: 'https://push.example.test/subscription',
  p256dh: RFC_UA_PUBLIC_KEY,
  auth: RFC_AUTH_SECRET
};

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Web Push aes128gcm encryption', () => {
  it('decodes URL-safe base64 values and rejects malformed encodings', () => {
    expect(Array.from(decodeBase64Url(RFC_AUTH_SECRET))).toEqual([
      5, 48, 89, 50, 161, 199, 234, 190, 19, 182, 206, 201, 253, 164, 136, 130
    ]);
    expect(decodeBase64Url('_____w')).toEqual(new Uint8Array([255, 255, 255, 255]));
    expect(() => decodeBase64Url('a')).toThrow('Invalid URL-safe base64');
    expect(() => decodeBase64Url('ab=c')).toThrow('Invalid URL-safe base64');
    expect(() => decodeBase64Url('abc$')).toThrow('Invalid URL-safe base64');
  });

  it('matches the complete RFC 8291 encrypted-body test vector', async () => {
    const senderPublic = decodeBase64Url(RFC_AS_PUBLIC_KEY);
    const senderPrivate = decodeBase64Url(RFC_AS_PRIVATE_KEY);
    const privateKey = await webcrypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: encodeBase64Url(senderPublic.slice(1, 33)),
        y: encodeBase64Url(senderPublic.slice(33, 65)),
        d: encodeBase64Url(senderPrivate),
        ext: true,
        key_ops: ['deriveBits']
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const publicKey = await webcrypto.subtle.importKey(
      'raw',
      senderPublic.buffer.slice(
        senderPublic.byteOffset,
        senderPublic.byteOffset + senderPublic.byteLength
      ) as ArrayBuffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );

    const subtle = new Proxy(webcrypto.subtle, {
      get(target, property) {
        if (property === 'generateKey') {
          return async () => ({ privateKey, publicKey });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const fixedCrypto = new Proxy(webcrypto, {
      get(target, property) {
        if (property === 'subtle') return subtle;
        if (property === 'getRandomValues') {
          return <T extends ArrayBufferView>(array: T): T => {
            new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(decodeBase64Url(RFC_SALT));
            return array;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Crypto;

    vi.stubGlobal('crypto', fixedCrypto);
    const result = await encryptWebPushPayload(RFC_PLAINTEXT, subscription);
    expect(Array.from(result.body)).toEqual(Array.from(decodeBase64Url(RFC_ENCRYPTED_BODY)));
    expect(result.endpoint).toBe(subscription.endpoint);
    expect(result.headers).toEqual({
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream'
    });
    expect(result.body.byteLength).toBe(144);
  });

  it.each([
    ['malformed public-key encoding', { ...subscription, p256dh: 'invalid!' }],
    ['wrong public-key length', { ...subscription, p256dh: 'AQID' }],
    ['compressed public key', { ...subscription, p256dh: encodeBase64Url(new Uint8Array(33).fill(2)) }],
    ['invalid P-256 point', { ...subscription, p256dh: encodeBase64Url(new Uint8Array(65).fill(4)) }],
    ['wrong authentication-secret length', { ...subscription, auth: 'AQID' }],
    ['malformed authentication-secret encoding', { ...subscription, auth: 'secret*' }],
    ['non-HTTPS endpoint', { ...subscription, endpoint: 'http://push.example.test/subscription' }]
  ])('rejects %s', async (_description, invalidSubscription) => {
    await expect(encryptWebPushPayload('payload', invalidSubscription)).rejects.toThrow();
  });

  it('frames empty and small payloads as one aes128gcm record', async () => {
    const empty = await encryptWebPushPayload('', subscription);
    const small = await encryptWebPushPayload(new TextEncoder().encode('hello'), subscription);

    expect(empty.body.byteLength).toBe(86 + 1 + 16);
    expect(small.body.byteLength).toBe(86 + 5 + 1 + 16);
    for (const result of [empty, small]) {
      const view = new DataView(result.body.buffer, result.body.byteOffset, result.body.byteLength);
      expect(view.getUint32(16, false)).toBe(4096);
      expect(result.body[20]).toBe(65);
      expect(result.body[21]).toBe(4);
      expect(result.body.byteLength).toBeLessThanOrEqual(4096);
    }
  });

  it('uses fresh randomness for each encryption and enforces the body-size limit', async () => {
    const first = await encryptWebPushPayload('same payload', subscription);
    const second = await encryptWebPushPayload('same payload', subscription);

    expect(Array.from(first.body)).not.toEqual(Array.from(second.body));
    expect(MAX_WEB_PUSH_PLAINTEXT_BYTES).toBe(3993);
    await expect(encryptWebPushPayload('x'.repeat(MAX_WEB_PUSH_PLAINTEXT_BYTES + 1), subscription))
      .rejects.toThrow('must not exceed');
  });
});

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
