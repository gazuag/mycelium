import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearAllLocalData, loadInboxCursor, openDatabase, saveInboxCursor } from './idb';

const DATABASE_NAME = 'mycelium_p2p';
const EXISTING_STORES = [
  'identity',
  'contacts',
  'profiles',
  'discovery_interactions',
  'message_queue',
  'direct_chat_messages'
];

beforeAll(async () => {
  await deleteDatabase();
});

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion was blocked'));
  });
}

function seedVersionFiveDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('identity', { keyPath: 'key' });
      db.createObjectStore('contacts', { keyPath: 'publicKey' });
      db.createObjectStore('profiles', { keyPath: 'author' });
      db.createObjectStore('discovery_interactions', { keyPath: 'id' });
      const queue = db.createObjectStore('message_queue', { keyPath: 'id' });
      queue.createIndex('recipient', 'recipient');
      const chats = db.createObjectStore('direct_chat_messages', { keyPath: 'id' });
      chats.createIndex('peerId', 'peerId');
      chats.createIndex('timestamp', 'timestamp');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(EXISTING_STORES, 'readwrite');
      transaction.objectStore('identity').put({ key: 'local', publicKey: 'preserved-key', privateKey: 'preserved-private-key' });
      transaction.objectStore('contacts').put({ publicKey: 'preserved-contact' });
      transaction.objectStore('profiles').put({ author: 'preserved-author' });
      transaction.objectStore('discovery_interactions').put({ id: 'preserved-interaction' });
      transaction.objectStore('message_queue').put({ id: 'preserved-queue', recipient: 'preserved-recipient' });
      transaction.objectStore('direct_chat_messages').put({ id: 'preserved-chat', peerId: 'preserved-peer', timestamp: '2026-10-04T00:00:00.000Z' });
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Version 5 seed transaction aborted'));
    };
  });
}

function readRecord<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

describe('inbox cursor IndexedDB persistence', () => {
  it('creates inbox_cursors in a fresh version 6 database', async () => {
    const db = await openDatabase();

    expect(db.version).toBe(6);
    expect(db.objectStoreNames.contains('inbox_cursors')).toBe(true);
    db.close();
  });

  it('upgrades version 5 while preserving existing stores and data', async () => {
    await deleteDatabase();
    await seedVersionFiveDatabase();

    const db = await openDatabase();
    expect(db.version).toBe(6);
    expect(db.objectStoreNames.contains('inbox_cursors')).toBe(true);
    for (const storeName of EXISTING_STORES) expect(db.objectStoreNames.contains(storeName)).toBe(true);
    await expect(readRecord(db, 'identity', 'local')).resolves.toMatchObject({ publicKey: 'preserved-key' });
    await expect(readRecord(db, 'contacts', 'preserved-contact')).resolves.toBeDefined();
    await expect(readRecord(db, 'profiles', 'preserved-author')).resolves.toBeDefined();
    await expect(readRecord(db, 'discovery_interactions', 'preserved-interaction')).resolves.toBeDefined();
    await expect(readRecord(db, 'message_queue', 'preserved-queue')).resolves.toBeDefined();
    await expect(readRecord(db, 'direct_chat_messages', 'preserved-chat')).resolves.toBeDefined();
    db.close();
  });

  it('returns null when no cursor exists for an identity', async () => {
    await expect(loadInboxCursor('absent-identity')).resolves.toBeNull();
  });

  it('round-trips a saved cursor', async () => {
    const identity = 'round-trip-identity';
    const cursor = '2026-10-04T10:00:00.000Z';

    await expect(saveInboxCursor(identity, cursor)).resolves.toBe(cursor);
    await expect(loadInboxCursor(identity)).resolves.toBe(cursor);
  });

  it('does not move an existing cursor backwards', async () => {
    const identity = 'monotonic-identity';
    await saveInboxCursor(identity, '2026-10-04T11:00:00.000Z');

    await expect(saveInboxCursor(identity, '2026-10-04T10:00:00.000Z')).resolves.toBe('2026-10-04T11:00:00.000Z');
    await expect(loadInboxCursor(identity)).resolves.toBe('2026-10-04T11:00:00.000Z');
  });

  it('advances an existing cursor when the new timestamp is later', async () => {
    const identity = 'advance-identity';
    await saveInboxCursor(identity, '2026-10-04T10:00:00.000Z');

    await expect(saveInboxCursor(identity, '2026-10-04T11:00:00.000Z')).resolves.toBe('2026-10-04T11:00:00.000Z');
    await expect(loadInboxCursor(identity)).resolves.toBe('2026-10-04T11:00:00.000Z');
  });

  it('isolates cursors by identity key', async () => {
    await saveInboxCursor('identity-a', '2026-10-04T10:00:00.000Z');
    await saveInboxCursor('identity-b', '2026-10-04T11:00:00.000Z');

    await expect(loadInboxCursor('identity-a')).resolves.toBe('2026-10-04T10:00:00.000Z');
    await expect(loadInboxCursor('identity-b')).resolves.toBe('2026-10-04T11:00:00.000Z');
  });

  it('rejects a non-ISO or unparseable cursor', async () => {
    await expect(saveInboxCursor('invalid-cursor-identity', 'not-a-date')).rejects.toThrow('ISO timestamp');
    await expect(saveInboxCursor('invalid-calendar-identity', '2026-02-30T10:00:00.000Z')).rejects.toThrow('ISO timestamp');
  });

  it('rejects an empty identity key for reads and writes', async () => {
    await expect(loadInboxCursor('')).rejects.toThrow('identity key');
    await expect(saveInboxCursor('   ', '2026-10-04T10:00:00.000Z')).rejects.toThrow('identity key');
  });

  it('removes inbox cursors through clearAllLocalData', async () => {
    await saveInboxCursor('reset-identity', '2026-10-04T10:00:00.000Z');

    await clearAllLocalData();

    await expect(loadInboxCursor('reset-identity')).resolves.toBeNull();
  });
});