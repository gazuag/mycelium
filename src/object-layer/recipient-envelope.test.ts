import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { canonicalizeObjectContent, calculateObjectId, createSignedObject, validateDistributedObject, validateObject } from './envelope';
import { IndexedDbObjectStore } from './local-store';
import type { DistributedObject, ObjectContent } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

async function createRecipientObject(recipient?: unknown): Promise<DistributedObject> {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  const content = {
    object_type: 'mycelium.recipient-fixture',
    created_at: '2026-09-30T12:34:56.000Z',
    payload: { content: 'signed recipient metadata' },
    replication_policy: {},
    ...(recipient === undefined ? {} : { recipient })
  } as unknown as ObjectContent;
  return await createSignedObject(content, createObjectIdentity({ id: 'recipient-test', publicKey, privateKey }));
}

describe('signed DistributedObject recipient field', () => {
  it('changes canonical bytes and object ID when recipient is present', async () => {
    const keys = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(keys.publicKey);
    const privateKey = await exportPrivateKey(keys.privateKey);
    const identity = createObjectIdentity({ id: 'recipient-test', publicKey, privateKey });
    const sharedContent = {
      object_type: 'mycelium.recipient-fixture',
      created_at: '2026-09-30T12:34:56.000Z',
      payload: { content: 'signed recipient metadata' },
      replication_policy: {}
    };
    const withoutRecipient = await createSignedObject(sharedContent, identity);
    const withRecipient = await createSignedObject({
      ...sharedContent,
      recipient: 'recipient-signing-key',
    }, identity);

    expect(canonicalizeObjectContent(withRecipient)).not.toBe(canonicalizeObjectContent(withoutRecipient));
    expect(withRecipient.object_id).not.toBe(withoutRecipient.object_id);
    expect(await calculateObjectId(withRecipient)).toBe(withRecipient.object_id);
  });

  it('accepts a valid recipient-bearing object', async () => {
    const object = await createRecipientObject('recipient-signing-key');

    expect(await validateObject(object)).toBe(true);
  });

  it('rejects an empty-string recipient', async () => {
    const keys = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(keys.publicKey);
    const privateKey = await exportPrivateKey(keys.privateKey);
    const identity = createObjectIdentity({ id: 'recipient-test', publicKey, privateKey });

    await expect(createSignedObject({
      object_type: 'mycelium.recipient-fixture',
      created_at: '2026-09-30T12:34:56.000Z',
      payload: {},
      replication_policy: {},
      recipient: ''
    }, identity)).rejects.toThrow('Invalid distributed object content');
  });

  it('rejects a non-string recipient', async () => {
    const validObject = await createRecipientObject('recipient-signing-key');
    const invalidObject = { ...validObject, recipient: 42 } as unknown as DistributedObject;

    expect(await validateDistributedObject(invalidObject)).toBe(false);
    expect(await validateDistributedObject({ ...validObject, recipient: null } as unknown as DistributedObject)).toBe(false);
  });

  it('covers recipient in the object ID and signature', async () => {
    const object = await createRecipientObject('recipient-signing-key');
    const tampered = { ...object, recipient: 'other-recipient-key' };

    expect(await calculateObjectId(tampered)).not.toBe(object.object_id);
    expect(await validateObject(tampered)).toBe(false);
  });

  it('round-trips recipient through IndexedDB put and get', async () => {
    const object = await createRecipientObject('recipient-signing-key');
    const store = new IndexedDbObjectStore();

    await store.put(object);
    const retrieved = await store.get(object.object_id);

    expect(retrieved?.recipient).toBe('recipient-signing-key');
    expect(retrieved).toEqual(object);
    await store.delete(object.object_id);
  });
});