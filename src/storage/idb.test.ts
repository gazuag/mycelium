import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { clearAllLocalData, loadContacts, loadFeedCursor, loadInboxCursor, openDatabase, saveContact, saveFeedCursor, saveInboxCursor } from './idb';
import type { FeedCursor } from '../object-layer/types';

const DATABASE_NAME = 'mycelium_p2p';
const PRESERVED_STORES = [
  'identity',
  'contacts',
  'profiles',
  'discovery_interactions',
  'inbox_cursors'
];
const REMOVED_STORES = ['message_queue', 'direct_chat_messages'];

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

function seedDatabase(version: 5 | 6 | 7): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, version);
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
      db.createObjectStore('inbox_cursors', { keyPath: 'identity' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction([...PRESERVED_STORES, ...REMOVED_STORES], 'readwrite');
      tx.objectStore('identity').put({ key: 'local', publicKey: 'preserved-key' });
      tx.objectStore('contacts').put({ publicKey: 'preserved-contact' });
      tx.objectStore('profiles').put({ author: 'preserved-author' });
      tx.objectStore('discovery_interactions').put({ id: 'preserved-interaction' });
      tx.objectStore('inbox_cursors').put({
        identity: 'preserved-identity',
        cursor: '2026-10-04T10:00:00.000Z',
        updated_at: '2026-10-04T10:00:00.000Z'
      });
      tx.objectStore('message_queue').put({ id: 'old-queue', text: 'legacy plaintext' });
      tx.objectStore('direct_chat_messages').put({ id: 'old-chat', text: 'legacy plaintext' });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error(`Version ${version} seed transaction aborted`));
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

async function expectUpgradedDatabase(version: 5 | 6 | 7): Promise<void> {
  await deleteDatabase();
  await seedDatabase(version);
  const db = await openDatabase();

  expect(db.version).toBe(8);
  expect(db.objectStoreNames.contains('feed_cursors')).toBe(true);
  for (const storeName of PRESERVED_STORES) expect(db.objectStoreNames.contains(storeName)).toBe(true);
  for (const storeName of REMOVED_STORES) expect(db.objectStoreNames.contains(storeName)).toBe(false);
  await expect(readRecord(db, 'identity', 'local')).resolves.toMatchObject({ publicKey: 'preserved-key' });
  await expect(readRecord(db, 'contacts', 'preserved-contact')).resolves.toBeDefined();
  await expect(readRecord(db, 'profiles', 'preserved-author')).resolves.toBeDefined();
  await expect(readRecord(db, 'discovery_interactions', 'preserved-interaction')).resolves.toBeDefined();
  await expect(readRecord(db, 'inbox_cursors', 'preserved-identity')).resolves.toMatchObject({
    cursor: '2026-10-04T10:00:00.000Z'
  });
  db.close();
}

describe('inbox cursor IndexedDB persistence', () => {
  it('upgrades version 5, removes plaintext chat stores, and preserves application data', async () => {
    await expectUpgradedDatabase(5);
  });

  describe('feed cursor IndexedDB persistence', () => {
    const cursor = (minute: number, suffix: string): FeedCursor => ({
      created_at: new Date(Date.UTC(2026, 9, 7, 10, minute)).toISOString(),
      object_id: suffix.repeat(64)
    });

    it('round-trips cursors and isolates by local identity and peer', async () => {
      const first = cursor(0, 'a');
      const second = cursor(1, 'b');
      await saveFeedCursor('local-a', 'peer-a', first);
      await saveFeedCursor('local-a', 'peer-b', second);
      await saveFeedCursor('local-b', 'peer-a', second);

      await expect(loadFeedCursor('local-a', 'peer-a')).resolves.toEqual(first);
      await expect(loadFeedCursor('local-a', 'peer-b')).resolves.toEqual(second);
      await expect(loadFeedCursor('local-b', 'peer-a')).resolves.toEqual(second);
      await expect(loadFeedCursor('local-b', 'peer-b')).resolves.toBeNull();
    });

    it('never moves a stored keyset cursor backwards', async () => {
      const later = cursor(1, 'b');
      await saveFeedCursor('monotonic-local', 'monotonic-peer', later);
      await saveFeedCursor('monotonic-local', 'monotonic-peer', cursor(0, 'f'));
      await saveFeedCursor('monotonic-local', 'monotonic-peer', cursor(1, 'a'));

      await expect(loadFeedCursor('monotonic-local', 'monotonic-peer')).resolves.toEqual(later);
    });

    it('rejects malformed identities, peers, timestamps, and object ids', async () => {
      await expect(loadFeedCursor('', 'peer')).rejects.toThrow('identity key');
      await expect(loadFeedCursor('identity', '  ')).rejects.toThrow('peer id');
      await expect(saveFeedCursor('identity', 'peer', { created_at: 'invalid', object_id: 'a'.repeat(64) })).rejects.toThrow('ISO timestamp');
      await expect(saveFeedCursor('identity', 'peer', { created_at: '2026-10-07T10:00:00.000Z', object_id: 'invalid' })).rejects.toThrow('object id');
    });
  });

  it('upgrades version 6, removes plaintext chat stores, and preserves application data', async () => {
    await expectUpgradedDatabase(6);
  });

  it('upgrades version 7 while preserving prior stores and data', async () => {
    await expectUpgradedDatabase(7);
  });

  it('creates a fresh version 8 database with feed cursors and no plaintext chat stores', async () => {
    await deleteDatabase();
    const db = await openDatabase();

    expect(db.version).toBe(8);
    expect(db.objectStoreNames.contains('inbox_cursors')).toBe(true);
    expect(db.objectStoreNames.contains('feed_cursors')).toBe(true);
    for (const storeName of REMOVED_STORES) expect(db.objectStoreNames.contains(storeName)).toBe(false);
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
  });

  it('isolates cursors by identity key', async () => {
    await saveInboxCursor('identity-a', '2026-10-04T10:00:00.000Z');
    await saveInboxCursor('identity-b', '2026-10-04T11:00:00.000Z');

    await expect(loadInboxCursor('identity-a')).resolves.toBe('2026-10-04T10:00:00.000Z');
    await expect(loadInboxCursor('identity-b')).resolves.toBe('2026-10-04T11:00:00.000Z');
  });

  it('persists lastReadAt through saveContact and loadContacts without a version bump', async () => {
    const db = await openDatabase();
    expect(db.version).toBe(8);
    db.close();

    await saveContact({
      publicKey: 'read-state-key',
      fingerprint: 'read-state-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: false,
      lastReadAt: '2026-10-04T12:00:00.000Z'
    });

    await expect(loadContacts()).resolves.toContainEqual(expect.objectContaining({
      publicKey: 'read-state-key',
      lastReadAt: '2026-10-04T12:00:00.000Z'
    }));
  });

  it('rejects a non-ISO or unparseable cursor', async () => {
    await expect(saveInboxCursor('invalid-cursor-identity', 'not-a-date')).rejects.toThrow('ISO timestamp');
    await expect(saveInboxCursor('invalid-calendar-identity', '2026-02-30T10:00:00.000Z')).rejects.toThrow('ISO timestamp');
  });

  it('rejects an empty identity key for reads and writes', async () => {
    await expect(loadInboxCursor('')).rejects.toThrow('identity key');
    await expect(saveInboxCursor('   ', '2026-10-04T10:00:00.000Z')).rejects.toThrow('identity key');
  });

  it('clearAllLocalData clears remaining local stores', async () => {
    const db = await openDatabase();
    const tx = db.transaction([...PRESERVED_STORES, 'feed_cursors'], 'readwrite');
    tx.objectStore('identity').put({ key: 'local', publicKey: 'key' });
    tx.objectStore('contacts').put({ publicKey: 'contact' });
    tx.objectStore('profiles').put({ author: 'author' });
    tx.objectStore('discovery_interactions').put({ id: 'interaction' });
    tx.objectStore('inbox_cursors').put({ identity: 'clear-me', cursor: '2026-10-04T10:00:00.000Z' });
    tx.objectStore('feed_cursors').put({
      key: 'clear-identity|clear-peer',
      created_at: '2026-10-04T10:00:00.000Z',
      object_id: 'a'.repeat(64),
      updated_at: '2026-10-04T10:00:00.000Z'
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await clearAllLocalData();

    await expect(loadInboxCursor('clear-me')).resolves.toBeNull();
    const clearedDb = await openDatabase();
    await expect(readRecord(clearedDb, 'identity', 'local')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'contacts', 'contact')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'profiles', 'author')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'discovery_interactions', 'interaction')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'feed_cursors', 'clear-identity|clear-peer')).resolves.toBeUndefined();
    clearedDb.close();
  });

  it('closes on versionchange and opens a fresh connection on the next call', async () => {
    await deleteDatabase();
    const first = await openDatabase();
    const close = vi.spyOn(first, 'close');

    first.onversionchange?.(new IDBVersionChangeEvent('versionchange', {
      oldVersion: 8,
      newVersion: 9
    }));

    expect(close).toHaveBeenCalledOnce();
    expect(() => first.transaction('contacts', 'readonly')).toThrow();
    const reopened = await openDatabase();
    expect(reopened.version).toBe(8);
    reopened.close();
  });

  it('completes an upgrade after a stale older-version connection closes', async () => {
    await deleteDatabase();
    await seedDatabase(6);
    const staleConnection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 6);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upgrade = openDatabase();

    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
      'IndexedDB upgrade is blocked by another open connection.'
    ));
    staleConnection.close();
    const upgraded = await upgrade;

    expect(upgraded.version).toBe(8);
    expect(upgraded.objectStoreNames.contains('inbox_cursors')).toBe(true);
    upgraded.close();
    warning.mockRestore();
  });
});
