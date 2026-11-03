import { describe, expect, it, vi } from 'vitest';
import type { DistributedObject } from '../object-layer/types';
import type { WebPushCapability } from '../types';
import {
  parseIncomingWebPushEnvelope,
  WEB_PUSH_ENVELOPE_MAX_BYTES
} from './web-push-inbox';
import {
  createWebPushDispatcher,
  type WebPushDispatchDependencies
} from './web-push-dispatch';
import type { EncryptedWebPushRequest } from './web-push-encryption';
import type { WebPushSendResult } from './web-push-sender';

const OBJECT_ID = 'a'.repeat(64);
const capability: WebPushCapability = {
  endpoint: 'https://push.example.test/subscription',
  p256dh: 'public-key',
  auth: 'auth-secret'
};
const object: DistributedObject = {
  object_id: OBJECT_ID,
  object_type: 'mycelium.post',
  author: 'author-public-key',
  created_at: '2026-10-22T10:00:00.000Z',
  payload: { text: 'a short post' },
  signature: 'signed-object',
  replication_policy: {}
};
const encrypted: EncryptedWebPushRequest = {
  endpoint: capability.endpoint,
  body: new Uint8Array([1, 2, 3]),
  headers: {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream'
  }
};

function createDependencies(sendResult: WebPushSendResult = { status: 'accepted' }) {
  const encrypt = vi.fn(async (_payload: string, _capability: WebPushCapability) => encrypted);
  const send = vi.fn(async () => sendResult);
  const dependencies: WebPushDispatchDependencies = { encrypt, send };
  return { dependencies, encrypt, send };
}

describe('outgoing Web Push dispatch', () => {
  it('sends the supported inline-object envelope when it fits', async () => {
    const { dependencies, encrypt, send } = createDependencies();
    const dispatch = createWebPushDispatcher(dependencies);

    await expect(dispatch(object, capability)).resolves.toEqual({ status: 'accepted' });
    const payload = JSON.parse(encrypt.mock.calls[0]?.[0] ?? 'null') as unknown;
    expect(payload).toEqual({ version: 1, type: 'object', object });
    expect(parseIncomingWebPushEnvelope(payload)).toEqual({ version: 1, type: 'object', object });
    expect(encrypt.mock.calls[0]?.[1]).toBe(capability);
    expect(send).toHaveBeenCalledWith(encrypted, capability);
  });

  it('sends the supported object-reference envelope when UTF-8 bytes exceed the staging limit', async () => {
    const { dependencies, encrypt } = createDependencies();
    const dispatch = createWebPushDispatcher(dependencies);
    const largeObject: DistributedObject = {
      ...object,
      payload: { text: 'x'.repeat(WEB_PUSH_ENVELOPE_MAX_BYTES) }
    };

    await dispatch(largeObject, capability);
    const payload = JSON.parse(encrypt.mock.calls[0]?.[0] ?? 'null') as unknown;
    expect(payload).toEqual({ version: 1, type: 'reference', object_id: OBJECT_ID });
    expect(parseIncomingWebPushEnvelope(payload)).toEqual({
      version: 1,
      type: 'reference',
      object_id: OBJECT_ID
    });
  });

  it('measures serialized envelope size in UTF-8 bytes for multibyte payloads', async () => {
    const { dependencies, encrypt } = createDependencies();
    const dispatch = createWebPushDispatcher(dependencies);
    const multibyteObject: DistributedObject = {
      ...object,
      payload: { text: 'é'.repeat(2_000) }
    };
    const inlineJson = JSON.stringify({ version: 1, type: 'object', object: multibyteObject });

    expect(inlineJson.length).toBeLessThan(WEB_PUSH_ENVELOPE_MAX_BYTES);
    expect(new TextEncoder().encode(inlineJson).byteLength).toBeGreaterThan(WEB_PUSH_ENVELOPE_MAX_BYTES);
    await dispatch(multibyteObject, capability);

    expect(JSON.parse(encrypt.mock.calls[0]?.[0] ?? 'null')).toEqual({
      version: 1,
      type: 'reference',
      object_id: OBJECT_ID
    });
  });

  it('skips invalid objects and recipient capabilities without encrypting or sending', async () => {
    const { dependencies, encrypt, send } = createDependencies();
    const dispatch = createWebPushDispatcher(dependencies);

    await expect(dispatch({ ...object, object_id: 'invalid' }, capability))
      .resolves.toEqual({ status: 'skipped', reason: 'invalid-object' });
    await expect(dispatch(object, { ...capability, endpoint: 'http://push.example.test' }))
      .resolves.toEqual({ status: 'skipped', reason: 'invalid-capability' });
    expect(encrypt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'accepted' }, { status: 'accepted' }],
    [{ status: 'invalid-subscription' }, { status: 'invalid-subscription' }],
    [{ status: 'rate-limited' }, { status: 'rate-limited' }],
    [{ status: 'temporary-failure' }, { status: 'temporary-failure' }],
    [{ status: 'delivery-unknown' }, { status: 'delivery-unknown' }],
    [{ status: 'request-rejected' }, { status: 'rejected' }],
    [{ status: 'configuration-missing' }, { status: 'skipped', reason: 'configuration-missing' }],
    [{ status: 'identity-unavailable' }, { status: 'skipped', reason: 'identity-unavailable' }]
  ] as const)('maps sender result %j to %j', async (sendResult, expected) => {
    const { dependencies, send } = createDependencies(sendResult);
    const dispatch = createWebPushDispatcher(dependencies);

    await expect(dispatch(object, capability)).resolves.toEqual(expected);
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not mutate the source object or access any outbox state', async () => {
    const { dependencies } = createDependencies();
    const dispatch = createWebPushDispatcher(dependencies);
    const frozenObject = Object.freeze({
      ...object,
      payload: Object.freeze({ text: 'immutable' })
    });
    const original = JSON.stringify(frozenObject);

    await dispatch(frozenObject, capability);

    expect(JSON.stringify(frozenObject)).toBe(original);
  });

  it('returns malformed subscription-key failures as skipped and propagates unexpected errors', async () => {
    const malformedDependencies = {
      ...createDependencies().dependencies,
      encrypt: vi.fn(async () => { throw new TypeError('Invalid Web Push subscription key.'); })
    };
    await expect(createWebPushDispatcher(malformedDependencies)(object, capability))
      .resolves.toEqual({ status: 'skipped', reason: 'invalid-capability' });

    const unexpectedDependencies = {
      ...createDependencies().dependencies,
      encrypt: vi.fn(async () => { throw new Error('unexpected crypto failure'); })
    };
    await expect(createWebPushDispatcher(unexpectedDependencies)(object, capability))
      .rejects.toThrow('unexpected crypto failure');
  });
});
