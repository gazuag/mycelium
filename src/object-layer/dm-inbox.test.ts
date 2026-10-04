import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { exportEncryptionPrivateKey, exportEncryptionPublicKey, generateEncryptionKeyPair } from '../crypto/dm-crypto';
import { openDatabase } from '../storage/idb';
import { createSignedObject } from './envelope';
import { createObjectIdentity } from './identity';
import { createDmObject, type DmObjectIdentity } from './dm-object';
import * as dmObjectModule from './dm-object';
import { listDmsForIdentity, openDm, openDms } from './dm-inbox';
import { IndexedDbObjectStore } from './local-store';
import type { DistributedObject, ObjectContent, ObjectIdentity } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

type TestIdentity = DmObjectIdentity & { privateKey: string };
const stores: IndexedDbObjectStore[] = [];
const storedObjectIds: string[] = [];

afterEach(async () => {
  for (const store of stores) {
    for (const objectId of storedObjectIds) await store.delete(objectId);
    const database = await (store as unknown as { databasePromise: Promise<IDBDatabase> }).databasePromise;
    database.close();
  }
  stores.length = 0;
  storedObjectIds.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function createIdentity(): Promise<TestIdentity> {
  const signingKeys = await generateIdentityKeyPair();
  const encryptionKeys = await generateEncryptionKeyPair();
  return {
    id: 'dm-inbox-test',
    publicKey: await exportPublicKey(signingKeys.publicKey),
    privateKey: await exportPrivateKey(signingKeys.privateKey),
    encryptionPublicKey: await exportEncryptionPublicKey(encryptionKeys.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(encryptionKeys.privateKey)
  };
}

async function createSignedDm(
  author: TestIdentity,
  recipient: string,
  createdAt: string,
  expiresAt?: string
): Promise<DistributedObject> {
  const content: ObjectContent = {
    object_type: 'mycelium.dm',
    recipient,
    created_at: createdAt,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    payload: { ciphertext_marker: `cipher-${createdAt}` },
    replication_policy: {}
  };
  return createSignedObject(content, createObjectIdentity({ id: author.id, publicKey: author.publicKey, privateKey: author.privateKey }));
}

async function makeDm(
  sender: TestIdentity,
  recipient: TestIdentity,
  plaintext: string
): Promise<DistributedObject> {
  return createDmObject({
    identity: sender,
    recipientSigningKey: recipient.publicKey,
    recipientEncryptionKey: recipient.encryptionPublicKey,
    plaintext
  });
}

async function createStore(): Promise<IndexedDbObjectStore> {
  const store = new IndexedDbObjectStore();
  stores.push(store);
  return store;
}

async function persist(store: IndexedDbObjectStore, ...objects: DistributedObject[]) {
  for (const object of objects) {
    await store.put(object);
    storedObjectIds.push(object.object_id);
  }
}

function createConsoleSpies() {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );
}

function expectNoSecretsInConsole(spies: ReturnType<typeof createConsoleSpies>, secrets: string[]) {
  const calls = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
  for (const secret of secrets.filter(Boolean)) expect(calls).not.toContain(secret);
}

async function scanBrowserPersistence(): Promise<string> {
  if (globalThis.localStorage == null) vi.stubGlobal('localStorage', createMemoryStorage());
  if (globalThis.sessionStorage == null) vi.stubGlobal('sessionStorage', createMemoryStorage());
  const databases = ['mycelium_objects', 'mycelium_p2p'];
  const persistedValues: unknown[] = [];
  for (const name of databases) {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const storeName of Array.from(database.objectStoreNames)) {
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      persistedValues.push({ database: name, store: storeName, values });
    }
    database.close();
  }
  const storageValues = [globalThis.localStorage, globalThis.sessionStorage]
    .flatMap((storage) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? '') ?? ''));
  return JSON.stringify({ persistedValues, storageValues });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); }
  };
}

describe('DM inbox listing and decryption', () => {
  it('lists received and sent DMs newest first', async () => {
    const me = await createIdentity();
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const store = await createStore();
    const received = await createSignedDm(sender, me.publicKey, '2026-10-01T00:00:00.000Z');
    const sent = await createSignedDm(me, recipient.publicKey, '2026-10-02T00:00:00.000Z');
    const query = vi.spyOn(store, 'query');
    await persist(store, received, sent);

    const result = await listDmsForIdentity({ store, myPublicKey: me.publicKey });

    expect(result.map((object) => object.object_id)).toEqual([sent.object_id, received.object_id]);
    expect(query).toHaveBeenCalledWith({ object_type: 'mycelium.dm', recipient: me.publicKey });
    expect(query).toHaveBeenCalledWith({ object_type: 'mycelium.dm', author: me.publicKey });
    expect(result.every((object) => typeof object.payload === 'object')).toBe(true);
  });

  it('excludes other recipients and non-DM objects', async () => {
    const me = await createIdentity();
    const other = await createIdentity();
    const store = await createStore();
    const received = await createSignedDm(other, me.publicKey, '2026-10-01T00:00:00.000Z');
    const otherRecipient = await createSignedDm(other, (await createIdentity()).publicKey, '2026-10-02T00:00:00.000Z');
    const nonDm = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-03T00:00:00.000Z',
      payload: { content: 'not a DM' },
      replication_policy: {}
    }, createObjectIdentity({ id: other.id, publicKey: other.publicKey, privateKey: other.privateKey }));
    await persist(store, received, otherRecipient, nonDm);

    await expect(listDmsForIdentity({ store, myPublicKey: me.publicKey })).resolves.toEqual([received]);
  });

  it('excludes expired DMs', async () => {
    const me = await createIdentity();
    const sender = await createIdentity();
    const store = await createStore();
    const expired = await createSignedDm(sender, me.publicKey, '2026-10-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    await persist(store, expired);

    await expect(listDmsForIdentity({ store, myPublicKey: me.publicKey })).resolves.toEqual([]);
  });

  it('opens a recipient DM only with the trusted sender encryption key', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const object = await makeDm(sender, recipient, 'recipient-secret-01');

    await expect(openDm({
      object,
      identity: recipient,
      resolveSenderEncryptionKey: (author) => author === sender.publicKey ? sender.encryptionPublicKey : null
    })).resolves.toEqual({ status: 'ok', plaintext: 'recipient-secret-01', counterparty: sender.publicKey });
  });

  it('returns unverified without calling decryptDmObject when no trusted sender key exists', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const object = await makeDm(sender, recipient, 'unverified-secret-02');
    const decrypt = vi.spyOn(dmObjectModule, 'decryptDmObject');

    await expect(openDm({ object, identity: recipient, resolveSenderEncryptionKey: () => null }))
      .resolves.toEqual({ status: 'unverified' });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('returns invalid for an unusable trusted sender key', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const object = await makeDm(sender, recipient, 'wrong-key-secret-03');

    await expect(openDm({ object, identity: recipient, resolveSenderEncryptionKey: () => 'different-key' }))
      .resolves.toEqual({ status: 'invalid' });
  });

  it('returns key_changed for a different valid sender encryption key', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const otherSender = await createIdentity();
    const object = await makeDm(sender, recipient, 'changed-key-secret-04');

    await expect(openDm({ object, identity: recipient, resolveSenderEncryptionKey: () => otherSender.encryptionPublicKey }))
      .resolves.toEqual({ status: 'key_changed' });
  });

  it('returns invalid for a tampered DM object', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const object = await makeDm(sender, recipient, 'tampered-secret-05');
    const tampered = { ...object, payload: { ...(object.payload as Record<string, unknown>), ciphertext: 'tampered-ciphertext' } };

    await expect(openDm({ object: tampered, identity: recipient, resolveSenderEncryptionKey: () => sender.encryptionPublicKey }))
      .resolves.toEqual({ status: 'invalid' });
  });

  it('opens a sent DM using the author identity keys', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const object = await makeDm(sender, recipient, 'author-secret-06');

    await expect(openDm({ object, identity: sender, resolveSenderEncryptionKey: () => null }))
      .resolves.toEqual({ status: 'ok', plaintext: 'author-secret-06', counterparty: recipient.publicKey });
  });

  it('returns invalid when the identity is neither author nor recipient', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const thirdParty = await createIdentity();
    const object = await makeDm(sender, recipient, 'third-party-secret-07');

    await expect(openDm({ object, identity: thirdParty, resolveSenderEncryptionKey: () => sender.encryptionPublicKey }))
      .resolves.toEqual({ status: 'invalid' });
  });

  it('opens DMs sequentially and preserves object order and statuses', async () => {
    const senderOne = await createIdentity();
    const senderTwo = await createIdentity();
    const recipient = await createIdentity();
    const other = await createIdentity();
    const objects = [
      await makeDm(senderOne, recipient, 'batch-secret-08a'),
      await makeDm(senderTwo, recipient, 'batch-secret-08b'),
      await makeDm(senderOne, other, 'batch-secret-08c')
    ];
    const resolverOrder: string[] = [];
    const results = await openDms({
      objects,
      identity: recipient,
      resolveSenderEncryptionKey: async (author) => {
        resolverOrder.push(author);
        return author === senderOne.publicKey ? senderOne.encryptionPublicKey : null;
      }
    });

    expect(resolverOrder).toEqual([senderOne.publicKey, senderTwo.publicKey]);
    expect(results.map((result) => result.status)).toEqual(['ok', 'unverified', 'invalid']);
    expect(results[0]).toMatchObject({ plaintext: 'batch-secret-08a', counterparty: senderOne.publicKey });
  });

  it('does not persist or log plaintext, keys, or ciphertext after openDm', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const plaintext = 'hygiene-plaintext-open-dm-09';
    const object = await makeDm(sender, recipient, plaintext);
    const store = await createStore();
    await persist(store, object);
    const p2pDatabase = await openDatabase();
    p2pDatabase.close();
    const spies = createConsoleSpies();

    const result = await openDm({ object, identity: recipient, resolveSenderEncryptionKey: () => sender.encryptionPublicKey });
    const persisted = await scanBrowserPersistence();
    const ciphertext = (object.payload as { ciphertext: string }).ciphertext;
    const secrets = [plaintext, sender.privateKey, sender.encryptionPrivateKey, recipient.privateKey, recipient.encryptionPrivateKey, ciphertext];

    expect(result).toMatchObject({ status: 'ok', plaintext });
    expect(persisted).not.toContain(plaintext);
    expectNoSecretsInConsole(spies, secrets);
  });

  it('does not persist or log secrets on openDms failure paths', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const plaintext = 'hygiene-plaintext-open-dms-10';
    const valid = await makeDm(sender, recipient, plaintext);
    const tampered = { ...valid, payload: { ...(valid.payload as Record<string, unknown>), ciphertext: 'failure-ciphertext-marker' } };
    const store = await createStore();
    await persist(store, valid);
    const p2pDatabase = await openDatabase();
    p2pDatabase.close();
    const spies = createConsoleSpies();

    const results = await openDms({
      objects: [valid, tampered],
      identity: recipient,
      resolveSenderEncryptionKey: () => sender.encryptionPublicKey
    });
    const persisted = await scanBrowserPersistence();
    const ciphertext = (valid.payload as { ciphertext: string }).ciphertext;
    const secrets = [plaintext, sender.privateKey, sender.encryptionPrivateKey, recipient.privateKey, recipient.encryptionPrivateKey, ciphertext];
    const failureText = JSON.stringify(results[1]);

    expect(results.map((result) => result.status)).toEqual(['ok', 'invalid']);
    expect(persisted).not.toContain(plaintext);
    for (const secret of secrets) expect(failureText).not.toContain(secret);
    expectNoSecretsInConsole(spies, [...secrets, 'failure-ciphertext-marker']);
  });
});