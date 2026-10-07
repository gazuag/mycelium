import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair
} from '../crypto/identity';
import {
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  generateEncryptionKeyPair
} from '../crypto/dm-crypto';
import * as dmInbox from './dm-inbox';
import { createDmObject, type DmObjectIdentity } from './dm-object';
import {
  countUnread,
  countUnreadByCounterparty,
  listConversations,
  loadConversation,
  previewConversation
} from './conversations';
import type { DistributedObject, ObjectCriteria, ObjectStore } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-10-05T12:00:00.000Z');

type TestIdentity = DmObjectIdentity & {
  id: string;
  publicKey: string;
  privateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
};

async function createIdentity(id: string): Promise<TestIdentity> {
  const signing = await generateIdentityKeyPair();
  const encryption = await generateEncryptionKeyPair();
  return {
    id,
    publicKey: await exportPublicKey(signing.publicKey),
    privateKey: await exportPrivateKey(signing.privateKey),
    encryptionPublicKey: await exportEncryptionPublicKey(encryption.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(encryption.privateKey)
  };
}

async function createDm(
  author: TestIdentity,
  recipient: TestIdentity,
  createdAt: string,
  plaintext: string,
  expiresAt?: string
): Promise<DistributedObject> {
  return await createDmObject({
    identity: author,
    recipientSigningKey: recipient.publicKey,
    recipientEncryptionKey: recipient.encryptionPublicKey,
    plaintext,
    now: () => new Date(createdAt),
    expiresInMs: expiresAt === undefined
      ? 30 * 24 * 60 * 60 * 1000
      : Date.parse(expiresAt) - Date.parse(createdAt)
  });
}

function stubDm(
  objectId: string,
  author: string,
  recipient: string,
  createdAt: string,
  objectType = 'mycelium.dm'
): DistributedObject {
  return {
    object_id: objectId,
    object_type: objectType,
    author,
    recipient,
    created_at: createdAt,
    expires_at: '2099-01-01T00:00:00.000Z',
    payload: { ciphertext: `ciphertext-${objectId}` },
    signature: `signature-${objectId}`,
    replication_policy: {}
  };
}

function createMemoryStore(objects: DistributedObject[]): ObjectStore {
  const getMatching = (criteria: ObjectCriteria = {}) => objects.filter((object) =>
    Object.entries(criteria).every(([key, value]) => object[key as keyof DistributedObject] === value)
  );
  return {
    async put(object) {
      objects.push(object);
      return true;
    },
    async get(objectId) {
      return objects.find((object) => object.object_id === objectId) ?? null;
    },
    async delete(objectId) {
      const index = objects.findIndex((object) => object.object_id === objectId);
      if (index >= 0) objects.splice(index, 1);
    },
    async query(criteria) {
      return getMatching(criteria);
    }
  };
}

function identityForKeys(publicKey: string): TestIdentity {
  return {
    id: 'me',
    publicKey,
    privateKey: '',
    encryptionPublicKey: '',
    encryptionPrivateKey: ''
  };
}

function optionsFor(
  objects: DistributedObject[],
  identity: DmObjectIdentity,
  counterparty: string,
  getOutboxEntry: (objectId: string) => Promise<{ delivered_direct: boolean; replicated_to: string[] } | null> = async () => null
) {
  return {
    store: createMemoryStore(objects),
    identity,
    counterparty,
    resolveSenderEncryptionKey: () => null,
    getOutboxEntry
  };
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

async function scanBrowserPersistence(): Promise<string> {
  if (globalThis.localStorage == null) vi.stubGlobal('localStorage', createMemoryStorage());
  if (globalThis.sessionStorage == null) vi.stubGlobal('sessionStorage', createMemoryStorage());
  const persistedValues: unknown[] = [];
  for (const name of ['mycelium_objects', 'mycelium_p2p']) {
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
  const browserStorage = [globalThis.localStorage, globalThis.sessionStorage]
    .flatMap((storage) => Array.from({ length: storage.length }, (_, index) => (
      storage.getItem(storage.key(index) ?? '') ?? ''
    )));
  return JSON.stringify({ persistedValues, browserStorage });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation read model', () => {
  it('counts only unexpired incoming DMs from the selected counterparty newer than the read cursor', async () => {
    const me = identityForKeys('me-key');
    const objects = [
      stubDm('new-in', 'alice-key', 'me-key', '2026-10-02T00:00:00.000Z'),
      stubDm('at-cursor', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z'),
      stubDm('old-in', 'alice-key', 'me-key', '2026-09-30T00:00:00.000Z'),
      stubDm('out', 'me-key', 'alice-key', '2026-10-03T00:00:00.000Z'),
      stubDm('other', 'bob-key', 'me-key', '2026-10-03T00:00:00.000Z'),
      { ...stubDm('expired', 'alice-key', 'me-key', '2026-10-03T00:00:00.000Z'), expires_at: '2026-10-01T00:00:00.000Z' },
      stubDm('post', 'alice-key', 'me-key', '2026-10-03T00:00:00.000Z', 'mycelium.post')
    ];
    const store = createMemoryStore(objects);
    const openSpy = vi.spyOn(dmInbox, 'openDm');
    const consoleSpies = [vi.spyOn(console, 'debug'), vi.spyOn(console, 'info'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];

    await expect(countUnread({
      store,
      myPublicKey: me.publicKey,
      counterparty: 'alice-key',
      since: '2026-10-01T00:00:00.000Z'
    })).resolves.toBe(1);
    expect(openSpy).not.toHaveBeenCalled();
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('counts all unexpired incoming DMs when since is null', async () => {
    const store = createMemoryStore([
      stubDm('in-a', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z'),
      stubDm('in-b', 'alice-key', 'me-key', '2026-10-02T00:00:00.000Z')
    ]);
    await expect(countUnread({
      store,
      myPublicKey: 'me-key',
      counterparty: 'alice-key',
      since: null
    })).resolves.toBe(2);
  });

  it('counts unread DMs for multiple counterparties from one received-object query', async () => {
    const objects = [
      stubDm('alice-unread', 'alice-key', 'me-key', '2026-10-02T00:00:00.000Z'),
      stubDm('bob-read', 'bob-key', 'me-key', '2026-10-01T00:00:00.000Z')
    ];
    const store = createMemoryStore(objects);
    const query = vi.spyOn(store, 'query');

    const counts = await countUnreadByCounterparty({
      store,
      myPublicKey: 'me-key',
      sinceByCounterparty: new Map([
        ['alice-key', '2026-10-01T00:00:00.000Z'],
        ['bob-key', '2026-10-01T00:00:00.000Z']
      ])
    });

    expect(counts).toEqual(new Map([['alice-key', 1], ['bob-key', 0]]));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ object_type: 'mycelium.dm', recipient: 'me-key' });
  });

  it('groups by counterparty, includes inbound/outbound messages, sorts newest first, and lists without decryption', async () => {
    const me = identityForKeys('me-key');
    const objects = [
      stubDm('in-a', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z'),
      stubDm('out-a', 'me-key', 'alice-key', '2026-10-03T00:00:00.000Z'),
      stubDm('in-b', 'bob-key', 'me-key', '2026-10-02T00:00:00.000Z')
    ];
    const openSpy = vi.spyOn(dmInbox, 'openDm');
    const decryptSpy = vi.spyOn(await import('./dm-object'), 'decryptDmObject');

    const result = await listConversations({ store: createMemoryStore(objects), myPublicKey: me.publicKey });

    expect(result).toEqual([
      {
        counterparty: 'alice-key',
        lastAt: '2026-10-03T00:00:00.000Z',
        lastObjectId: 'out-a',
        lastDirection: 'out',
        count: 2
      },
      {
        counterparty: 'bob-key',
        lastAt: '2026-10-02T00:00:00.000Z',
        lastObjectId: 'in-b',
        lastDirection: 'in',
        count: 1
      }
    ]);
    expect(openSpy).not.toHaveBeenCalled();
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('loads only DMs with the selected counterparty and excludes non-DM objects', async () => {
    const me = identityForKeys('me-key');
    const other = [
      stubDm('in-selected', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z'),
      stubDm('out-selected', 'me-key', 'alice-key', '2026-10-02T00:00:00.000Z'),
      stubDm('in-other', 'bob-key', 'me-key', '2026-10-03T00:00:00.000Z'),
      stubDm('non-dm', 'alice-key', 'me-key', '2026-10-04T00:00:00.000Z', 'mycelium.post')
    ];
    vi.spyOn(dmInbox, 'openDm').mockImplementation(async ({ object }) => ({
      status: 'ok',
      plaintext: `opened-${object.object_id}`,
      counterparty: 'alice-key'
    }));

    const result = await loadConversation(optionsFor(other, me, 'alice-key'));

    expect(result.map((message) => message.objectId)).toEqual(['in-selected', 'out-selected']);
  });

  it('orders oldest first and uses object_id as the stable timestamp tie-break', async () => {
    const identity = identityForKeys('me-key');
    const objects = [
      stubDm('z-id', 'alice-key', 'me-key', '2026-10-02T00:00:00.000Z'),
      stubDm('b-id', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z'),
      stubDm('a-id', 'me-key', 'alice-key', '2026-10-01T00:00:00.000Z')
    ];
    vi.spyOn(dmInbox, 'openDm').mockImplementation(async ({ object }) => ({
      status: 'ok',
      plaintext: object.object_id,
      counterparty: 'alice-key'
    }));

    const result = await loadConversation(optionsFor(objects, identity, 'alice-key'));

    expect(result.map((message) => message.objectId)).toEqual(['a-id', 'b-id', 'z-id']);
  });

  it('keeps only the newest N messages when a limit is supplied', async () => {
    const identity = identityForKeys('me-key');
    const objects = Array.from({ length: 4 }, (_, index) =>
      stubDm(`id-${index}`, 'alice-key', 'me-key', `2026-10-0${index + 1}T00:00:00.000Z`)
    );
    vi.spyOn(dmInbox, 'openDm').mockImplementation(async ({ object }) => ({
      status: 'ok',
      plaintext: object.object_id,
      counterparty: 'alice-key'
    }));

    const result = await loadConversation({ ...optionsFor(objects, identity, 'alice-key'), limit: 2 });

    expect(result.map((message) => message.objectId)).toEqual(['id-2', 'id-3']);
  });

  it('maps open statuses and exposes text only for successful messages', async () => {
    const identity = identityForKeys('me-key');
    const objects = ['ok', 'unverified', 'key_changed', 'invalid'].map((id, index) =>
      stubDm(id, 'alice-key', 'me-key', `2026-10-0${index + 1}T00:00:00.000Z`)
    );
    vi.spyOn(dmInbox, 'openDm').mockImplementation(async ({ object }) => {
      if (object.object_id === 'ok') return { status: 'ok', plaintext: 'clear message', counterparty: 'alice-key' };
      return { status: object.object_id as 'unverified' | 'key_changed' | 'invalid' };
    });

    const result = await loadConversation(optionsFor(objects, identity, 'alice-key'));

    expect(result.map(({ status, text }) => ({ status, text }))).toEqual([
      { status: 'ok', text: 'clear message' },
      { status: 'unverified', text: null },
      { status: 'key_changed', text: null },
      { status: 'invalid', text: null }
    ]);
  });

  it('marks outgoing delivery pending only while an outbox entry has no direct or replica delivery', async () => {
    const identity = identityForKeys('me-key');
    const objects = [
      stubDm('pending', 'me-key', 'alice-key', '2026-10-01T00:00:00.000Z'),
      stubDm('replicated', 'me-key', 'alice-key', '2026-10-02T00:00:00.000Z'),
      stubDm('direct', 'me-key', 'alice-key', '2026-10-03T00:00:00.000Z'),
      stubDm('no-entry', 'me-key', 'alice-key', '2026-10-04T00:00:00.000Z')
    ];
    vi.spyOn(dmInbox, 'openDm').mockImplementation(async ({ object }) => ({
      status: 'ok',
      plaintext: object.object_id,
      counterparty: 'alice-key'
    }));
    const entryValues: Record<string, { delivered_direct: boolean; replicated_to: string[] } | null> = {
      pending: { delivered_direct: false, replicated_to: [] },
      replicated: { delivered_direct: false, replicated_to: ['peer-a'] },
      direct: { delivered_direct: true, replicated_to: [] },
      'no-entry': null
    };

    const result = await loadConversation({
      ...optionsFor(objects, identity, 'alice-key'),
      getOutboxEntry: async (objectId) => entryValues[objectId]
    });

    expect(result.map(({ objectId, delivery }) => ({ objectId, delivery }))).toEqual([
      { objectId: 'pending', delivery: 'pending' },
      { objectId: 'replicated', delivery: 'sent' },
      { objectId: 'direct', delivery: 'sent' },
      { objectId: 'no-entry', delivery: 'sent' }
    ]);
  });

  it('does not add delivery status to incoming messages', async () => {
    const identity = identityForKeys('me-key');
    const object = stubDm('incoming', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z');
    vi.spyOn(dmInbox, 'openDm').mockResolvedValue({
      status: 'ok',
      plaintext: 'incoming plaintext',
      counterparty: 'alice-key'
    });

    const [message] = await loadConversation(optionsFor([object], identity, 'alice-key'));

    expect(message).not.toHaveProperty('delivery');
  });

  it('previews only the newest message and opens it once', async () => {
    const identity = identityForKeys('me-key');
    const objects = [
      stubDm('older', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z'),
      stubDm('newest', 'alice-key', 'me-key', '2026-10-02T00:00:00.000Z')
    ];
    const openSpy = vi.spyOn(dmInbox, 'openDm').mockImplementation(async ({ object }) => ({
      status: 'ok',
      plaintext: object.object_id,
      counterparty: 'alice-key'
    }));

    const preview = await previewConversation(optionsFor(objects, identity, 'alice-key'));

    expect(preview?.objectId).toBe('newest');
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[0].object.object_id).toBe('newest');
  });

  it('excludes expired DMs from conversation loading', async () => {
    const identity = identityForKeys('me-key');
    const expired = stubDm('expired', 'alice-key', 'me-key', '2026-10-01T00:00:00.000Z');
    const objects = [{
      ...expired,
      expires_at: '2020-01-01T00:00:00.000Z'
    }];
    const openSpy = vi.spyOn(dmInbox, 'openDm');

    const result = await loadConversation(optionsFor(objects, identity, 'alice-key'));

    expect(result).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not log or persist plaintext, key material, or ciphertext during a real open', async () => {
    const author = await createIdentity('hygiene-author');
    const recipient = await createIdentity('hygiene-recipient');
    const plaintext = 'conversation-hygiene-unique-plaintext';
    const object = await createDm(author, recipient, NOW.toISOString(), plaintext);
    const serializedObject = JSON.stringify(object);
    const ciphertext = (object.payload as { ciphertext: string }).ciphertext;
    const keys = [
      author.privateKey,
      author.publicKey,
      author.encryptionPrivateKey,
      author.encryptionPublicKey,
      recipient.privateKey,
      recipient.publicKey,
      recipient.encryptionPrivateKey,
      recipient.encryptionPublicKey
    ];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const memoryStore = createMemoryStore([object]);

    const result = await loadConversation({
      store: memoryStore,
      identity: recipient,
      counterparty: author.publicKey,
      resolveSenderEncryptionKey: () => author.encryptionPublicKey,
      getOutboxEntry: async () => null
    });
    const persisted = await scanBrowserPersistence();

    expect(result[0]).toMatchObject({ status: 'ok', text: plaintext });
    expect(persisted).not.toContain(plaintext);
    expect(persisted).not.toContain(ciphertext);
    for (const key of keys) {
      expect(persisted).not.toContain(key);
    }
    expect(persisted).not.toContain(serializedObject);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      const calls = JSON.stringify(spy.mock.calls);
      expect(calls).not.toContain(plaintext);
      expect(calls).not.toContain(ciphertext);
      for (const key of keys) expect(calls).not.toContain(key);
    }
  });
});
