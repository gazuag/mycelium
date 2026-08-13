import { Contact, SignedPost, SignedProfile, StoredPost } from '../types';

const DB_NAME = 'mycelium_p2p';
const DB_VERSION = 4;
const IDENTITY_STORE = 'identity';
const CONTACT_STORE = 'contacts';
const PROFILE_STORE = 'profiles';
const POST_STORE = 'posts';
const DISCOVERY_STORE = 'discovery_interactions';
const QUEUE_STORE = 'message_queue';
const DIRECT_CHAT_STORE = 'direct_chat_messages';

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
      if (!db.objectStoreNames.contains(POST_STORE)) {
        const store = db.createObjectStore(POST_STORE, { keyPath: 'id' });
        store.createIndex('receivedAt', 'receivedAt');
        store.createIndex('seen', 'seen');
      }
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

export async function saveIdentity(payload: { key: string; publicKey: string; privateKey: string; id?: string }) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE, 'readwrite');
    const store = tx.objectStore(IDENTITY_STORE);
    store.put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadIdentity() {
  const db = await openDatabase();
  return new Promise<{ key: string; publicKey: string; privateKey: string; id?: string } | null>((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE, 'readonly');
    const store = tx.objectStore(IDENTITY_STORE);
    const request = store.get('local');
    request.onsuccess = () => resolve(request.result ?? null);
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

export async function savePost(post: StoredPost) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(POST_STORE, 'readwrite');
    const store = tx.objectStore(POST_STORE);
    store.put(post);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPosts(): Promise<StoredPost[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(POST_STORE, 'readonly');
    const store = tx.objectStore(POST_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as StoredPost[]);
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
      [IDENTITY_STORE, CONTACT_STORE, PROFILE_STORE, POST_STORE, DISCOVERY_STORE, QUEUE_STORE, DIRECT_CHAT_STORE],
      'readwrite'
    );

    const stores = [
      tx.objectStore(IDENTITY_STORE),
      tx.objectStore(CONTACT_STORE),
      tx.objectStore(PROFILE_STORE),
      tx.objectStore(POST_STORE),
      tx.objectStore(DISCOVERY_STORE),
      tx.objectStore(QUEUE_STORE),
      tx.objectStore(DIRECT_CHAT_STORE)
    ];

    stores.forEach((store) => store.clear());

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
