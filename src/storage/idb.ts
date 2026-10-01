import { Contact, SignedProfile } from '../types';
import { exportEncryptionPrivateKey, exportEncryptionPublicKey, generateEncryptionKeyPair } from '../crypto/dm-crypto';

const DB_NAME = 'mycelium_p2p';
const DB_VERSION = 5;
const IDENTITY_STORE = 'identity';
const CONTACT_STORE = 'contacts';
const PROFILE_STORE = 'profiles';
const DISCOVERY_STORE = 'discovery_interactions';
const QUEUE_STORE = 'message_queue';
const DIRECT_CHAT_STORE = 'direct_chat_messages';
let identityLoadPromise: Promise<CompleteLocalIdentityRecord | null> | null = null;

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
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const queueStore = db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        queueStore.createIndex('recipient', 'recipient');
      }
      if (!db.objectStoreNames.contains(DIRECT_CHAT_STORE)) {
        const directChatStore = db.createObjectStore(DIRECT_CHAT_STORE, { keyPath: 'id' });
        directChatStore.createIndex('peerId', 'peerId');
        directChatStore.createIndex('timestamp', 'timestamp');
      }
    };

    request.onsuccess = () => resolve(request.result);
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

export async function saveMessageQueue(message: { id: string; recipient: string; text: string; timestamp: string; status: 'queued' | 'sent'; chatMessageId?: string }) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    store.put(message);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadMessageQueue(): Promise<Array<{ id: string; recipient: string; text: string; timestamp: string; status: 'queued' | 'sent'; chatMessageId?: string }>> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const store = tx.objectStore(QUEUE_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteMessageQueue(id: string) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveDirectChatMessage(message: { id: string; peerId: string; text: string; timestamp: string; isMine: boolean; deliveryStatus?: 'queued' | 'sent' }) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DIRECT_CHAT_STORE, 'readwrite');
    const store = tx.objectStore(DIRECT_CHAT_STORE);
    store.put(message);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteDirectChatMessage(id: string) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DIRECT_CHAT_STORE, 'readwrite');
    const store = tx.objectStore(DIRECT_CHAT_STORE);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDirectChatMessages(): Promise<Array<{ id: string; peerId: string; text: string; timestamp: string; isMine: boolean; deliveryStatus?: 'queued' | 'sent' }>> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIRECT_CHAT_STORE, 'readonly');
    const store = tx.objectStore(DIRECT_CHAT_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function updateDirectChatMessageStatus(id: string, deliveryStatus: 'queued' | 'sent') {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DIRECT_CHAT_STORE, 'readwrite');
    const store = tx.objectStore(DIRECT_CHAT_STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const existing = request.result as { id: string; peerId: string; text: string; timestamp: string; isMine: boolean; deliveryStatus?: 'queued' | 'sent' } | undefined;
      if (!existing) {
        resolve();
        return;
      }
      store.put({ ...existing, deliveryStatus });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearDirectChatMessages() {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DIRECT_CHAT_STORE, 'readwrite');
    const store = tx.objectStore(DIRECT_CHAT_STORE);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllLocalData() {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [IDENTITY_STORE, CONTACT_STORE, PROFILE_STORE, DISCOVERY_STORE, QUEUE_STORE, DIRECT_CHAT_STORE],
      'readwrite'
    );

    const stores = [
      tx.objectStore(IDENTITY_STORE),
      tx.objectStore(CONTACT_STORE),
      tx.objectStore(PROFILE_STORE),
      tx.objectStore(DISCOVERY_STORE),
      tx.objectStore(QUEUE_STORE),
      tx.objectStore(DIRECT_CHAT_STORE)
    ];

    stores.forEach((store) => store.clear());

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
