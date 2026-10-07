import { Contact, SignedProfile } from '../types';
import { exportEncryptionPrivateKey, exportEncryptionPublicKey, generateEncryptionKeyPair } from '../crypto/dm-crypto';
import { compareFeedKey } from '../object-layer/feed-page';
import type { FeedCursor } from '../object-layer/types';

const DB_NAME = 'mycelium_p2p';
const DB_VERSION = 8;
const IDENTITY_STORE = 'identity';
const CONTACT_STORE = 'contacts';
const PROFILE_STORE = 'profiles';
const DISCOVERY_STORE = 'discovery_interactions';
const INBOX_CURSOR_STORE = 'inbox_cursors';
const FEED_CURSOR_STORE = 'feed_cursors';
let identityLoadPromise: Promise<CompleteLocalIdentityRecord | null> | null = null;

interface InboxCursorRecord {
  identity: string;
  cursor: string;
  updated_at: string;
}

interface FeedCursorRecord extends FeedCursor {
  key: string;
  updated_at: string;
}

export interface LocalIdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id?: string;
  encryptionPublicKey?: string;
  encryptionPrivateKey?: string;
}

export interface CompleteLocalIdentityRecord extends LocalIdentityRecord {
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

export async function ensureIdentityEncryptionKeyPair(identity: LocalIdentityRecord): Promise<CompleteLocalIdentityRecord> {
  if (identity.encryptionPublicKey && identity.encryptionPrivateKey) {
    return identity as CompleteLocalIdentityRecord;
  }
  const keyPair = await generateEncryptionKeyPair();
  return {
    ...identity,
    encryptionPublicKey: await exportEncryptionPublicKey(keyPair.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(keyPair.privateKey)
  };
}

export function identityBackupFields(identity: CompleteLocalIdentityRecord) {
  return {
    key: identity.key,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    id: identity.id,
    encryptionPublicKey: identity.encryptionPublicKey,
    encryptionPrivateKey: identity.encryptionPrivateKey
  };
}

export async function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains('message_queue')) db.deleteObjectStore('message_queue');
      if (db.objectStoreNames.contains('direct_chat_messages')) db.deleteObjectStore('direct_chat_messages');
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CONTACT_STORE)) {
        db.createObjectStore(CONTACT_STORE, { keyPath: 'publicKey' });
      }
      if (!db.objectStoreNames.contains(PROFILE_STORE)) {
        db.createObjectStore(PROFILE_STORE, { keyPath: 'author' });
      }
      if (db.objectStoreNames.contains('posts')) db.deleteObjectStore('posts');
      if (!db.objectStoreNames.contains(DISCOVERY_STORE)) {
        db.createObjectStore(DISCOVERY_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(INBOX_CURSOR_STORE)) {
        db.createObjectStore(INBOX_CURSOR_STORE, { keyPath: 'identity' });
      }
      if (!db.objectStoreNames.contains(FEED_CURSOR_STORE)) {
        db.createObjectStore(FEED_CURSOR_STORE, { keyPath: 'key' });
      }
    };

    request.onblocked = () => {
      console.warn('IndexedDB upgrade is blocked by another open connection.');
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveIdentity(payload: LocalIdentityRecord) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE, 'readwrite');
    const store = tx.objectStore(IDENTITY_STORE);
    store.put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function loadIdentity(): Promise<CompleteLocalIdentityRecord | null> {
  if (!identityLoadPromise) {
    identityLoadPromise = loadAndMigrateIdentity().finally(() => {
      identityLoadPromise = null;
    });
  }
  return identityLoadPromise;
}

async function loadAndMigrateIdentity(): Promise<CompleteLocalIdentityRecord | null> {
  const db = await openDatabase();
  return new Promise<CompleteLocalIdentityRecord | null>((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE, 'readonly');
    const store = tx.objectStore(IDENTITY_STORE);
    const request = store.get('local');
    request.onsuccess = () => {
      const stored = request.result as LocalIdentityRecord | undefined;
      if (!stored) {
        resolve(null);
        return;
      }
      void (async () => {
        const complete = await ensureIdentityEncryptionKeyPair(stored);
        if (!stored.encryptionPublicKey || !stored.encryptionPrivateKey) await saveIdentity(complete);
        resolve(complete);
      })().catch(reject);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteIdentity() {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE, 'readwrite');
    const store = tx.objectStore(IDENTITY_STORE);
    store.delete('local');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadInboxCursor(identityKey: string): Promise<string | null> {
  validateIdentityKey(identityKey);
  const db = await openDatabase();
  return new Promise<string | null>((resolve, reject) => {
    const transaction = db.transaction(INBOX_CURSOR_STORE, 'readonly');
    const request = transaction.objectStore(INBOX_CURSOR_STORE).get(identityKey);
    request.onsuccess = () => resolve((request.result as InboxCursorRecord | undefined)?.cursor ?? null);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveInboxCursor(identityKey: string, cursor: string): Promise<string> {
  validateIdentityKey(identityKey);
  const cursorTime = validateIsoCursor(cursor);
  const db = await openDatabase();
  return new Promise<string>((resolve, reject) => {
    const transaction = db.transaction(INBOX_CURSOR_STORE, 'readwrite');
    const store = transaction.objectStore(INBOX_CURSOR_STORE);
    const request = store.get(identityKey);
    let resultingCursor = cursor;
    request.onsuccess = () => {
      const existing = request.result as InboxCursorRecord | undefined;
      if (existing && Date.parse(existing.cursor) > cursorTime) resultingCursor = existing.cursor;
      store.put({ identity: identityKey, cursor: resultingCursor, updated_at: new Date().toISOString() });
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(resultingCursor);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Inbox cursor transaction aborted'));
  });
}

export async function loadFeedCursor(localPublicKey: string, peerId: string): Promise<FeedCursor | null> {
  const key = feedCursorKey(localPublicKey, peerId);
  const db = await openDatabase();
  return new Promise<FeedCursor | null>((resolve, reject) => {
    const transaction = db.transaction(FEED_CURSOR_STORE, 'readonly');
    const request = transaction.objectStore(FEED_CURSOR_STORE).get(key);
    request.onsuccess = () => {
      const record = request.result as FeedCursorRecord | undefined;
      resolve(record ? { created_at: record.created_at, object_id: record.object_id } : null);
    };
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Feed cursor transaction aborted'));
  });
}

export async function saveFeedCursor(
  localPublicKey: string,
  peerId: string,
  cursor: FeedCursor
): Promise<void> {
  const key = feedCursorKey(localPublicKey, peerId);
  validateFeedCursor(cursor);
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(FEED_CURSOR_STORE, 'readwrite');
    const store = transaction.objectStore(FEED_CURSOR_STORE);
    const request = store.get(key);
    request.onsuccess = () => {
      const existing = request.result as FeedCursorRecord | undefined;
      if (existing && compareFeedKey(cursor, existing) <= 0) return;
      store.put({
        key,
        created_at: cursor.created_at,
        object_id: cursor.object_id,
        updated_at: new Date().toISOString()
      } satisfies FeedCursorRecord);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Feed cursor transaction aborted'));
  });
}

function feedCursorKey(localPublicKey: string, peerId: string): string {
  validateIdentityKey(localPublicKey);
  if (typeof peerId !== 'string' || peerId.trim().length === 0) {
    throw new Error('Feed cursor peer id must not be empty');
  }
  return `${localPublicKey}|${peerId}`;
}

function validateFeedCursor(cursor: FeedCursor): void {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new Error('Feed cursor must be an object');
  }
  validateIsoCursor(cursor.created_at);
  if (typeof cursor.object_id !== 'string' || !/^[0-9a-f]{64}$/.test(cursor.object_id)) {
    throw new Error('Feed cursor object id must be a lowercase SHA-256 id');
  }
}

function validateIdentityKey(identityKey: string): void {
  if (typeof identityKey !== 'string' || identityKey.trim().length === 0) {
    throw new Error('Inbox cursor identity key must not be empty');
  }
}

function validateIsoCursor(cursor: string): number {
  const match = typeof cursor === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(cursor)
    : null;
  const timestamp = typeof cursor === 'string' ? Date.parse(cursor) : Number.NaN;
  if (!match || !Number.isFinite(timestamp)) {
    throw new Error('Inbox cursor must be a valid ISO timestamp');
  }

  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), Number((fraction + '000').slice(0, 3)));
  if (calendar.getUTCFullYear() !== Number(year)
    || calendar.getUTCMonth() !== Number(month) - 1
    || calendar.getUTCDate() !== Number(day)
    || calendar.getUTCHours() !== Number(hour)
    || calendar.getUTCMinutes() !== Number(minute)
    || calendar.getUTCSeconds() !== Number(second)) {
    throw new Error('Inbox cursor must be a valid ISO timestamp');
  }
  return timestamp;
}

export async function saveContact(contact: Contact) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CONTACT_STORE, 'readwrite');
    const store = tx.objectStore(CONTACT_STORE);
    store.put(contact);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadContacts(): Promise<Contact[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONTACT_STORE, 'readonly');
    const store = tx.objectStore(CONTACT_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as Contact[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteContact(publicKey: string) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CONTACT_STORE, 'readwrite');
    const store = tx.objectStore(CONTACT_STORE);
    store.delete(publicKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveProfile(profile: SignedProfile) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROFILE_STORE, 'readwrite');
    const store = tx.objectStore(PROFILE_STORE);
    store.put(profile);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadProfile(author: string): Promise<SignedProfile | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROFILE_STORE, 'readonly');
    const store = tx.objectStore(PROFILE_STORE);
    const request = store.get(author);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDiscoveryInteraction(interaction: { id: string; type: 'seen' | 'liked' | 'disliked' | 'notInterested' | 'saved'; timestamp: string }) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DISCOVERY_STORE, 'readwrite');
    const store = tx.objectStore(DISCOVERY_STORE);
    store.put(interaction);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDiscoveryInteractions() {
  const db = await openDatabase();
  return new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction(DISCOVERY_STORE, 'readonly');
    const store = tx.objectStore(DISCOVERY_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function clearAllLocalData() {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [IDENTITY_STORE, CONTACT_STORE, PROFILE_STORE, DISCOVERY_STORE, INBOX_CURSOR_STORE, FEED_CURSOR_STORE],
      'readwrite'
    );

    const stores = [
      tx.objectStore(IDENTITY_STORE),
      tx.objectStore(CONTACT_STORE),
      tx.objectStore(PROFILE_STORE),
      tx.objectStore(DISCOVERY_STORE),
      tx.objectStore(INBOX_CURSOR_STORE),
      tx.objectStore(FEED_CURSOR_STORE)
    ];

    stores.forEach((store) => store.clear());

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
