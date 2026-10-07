import type { DistributedObject, LocalPostMetadata, LocalPostMetadataStore, ObjectCriteria, ObjectStore, RecommendationSequenceStore } from './types';
import { isObjectExpired, validateDistributedObject } from './envelope';

const DATABASE_NAME = 'mycelium_objects';
const DATABASE_VERSION = 5;
const OBJECT_STORE_NAME = 'objects';
const RECIPIENT_CREATED_AT_INDEX = 'recipient_created_at';
const LOCAL_POST_METADATA_STORE_NAME = 'local_post_metadata';
const RECOMMENDATION_SEQUENCE_STORE_NAME = 'recommendation_sequences';
const OUTBOX_STORE_NAME = 'outbox';
const DEFAULT_OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface OutboxEntry {
  readonly object_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly replicated_to: string[];
  readonly delivered_direct: boolean;
  readonly attempts: number;
  readonly last_attempt_at: string | null;
}

export interface OutboxStore {
  add(entry: OutboxEntry): Promise<void>;
  get(objectId: string): Promise<OutboxEntry | null>;
  listPending(limit: number): Promise<OutboxEntry[]>;
  update(entry: OutboxEntry): Promise<void>;
  remove(objectId: string): Promise<void>;
  pruneExpired(now: Date): Promise<number>;
}

export class IndexedDbObjectStore implements ObjectStore {
  private readonly getDatabase = createObjectDatabaseAccessor();
  private get databasePromise(): Promise<IDBDatabase> {
    return this.getDatabase();
  }

  async put(object: DistributedObject): Promise<boolean> {
    if (!(await validateDistributedObject(object))) {
      throw new Error('Invalid distributed object');
    }
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(OBJECT_STORE_NAME);
      const request = store.get(object.object_id);
      let existed = false;
      request.onsuccess = () => {
        existed = request.result !== undefined;
        store.put(object);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(!existed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async get(objectId: string): Promise<DistributedObject | null> {
    const database = await this.getDatabase();
    const object = await runRequest<DistributedObject | undefined>(database, 'readonly', (store) => store.get(objectId));
    if (object && isObjectExpired(object)) {
      await this.delete(objectId);
      return null;
    }
    return object ?? null;
  }

  async delete(objectId: string): Promise<void> {
    const database = await this.getDatabase();
    await runTransaction(database, 'readwrite', (store) => store.delete(objectId));
  }

  async query(criteria: ObjectCriteria = {}): Promise<DistributedObject[]> {
    const database = await this.getDatabase();
    const objects = await runRequest<DistributedObject[]>(database, 'readonly', (store) => {
      if (criteria.recipient === undefined) return store.getAll();
      const range = IDBKeyRange.bound([criteria.recipient, ''], [criteria.recipient, '\uffff']);
      return store.index(RECIPIENT_CREATED_AT_INDEX).getAll(range);
    });
    const { recipient, created_after, created_before, since, order, limit, ...exactCriteria } = criteria;
    const matching = objects.filter((object) => {
      if (!Object.entries(exactCriteria).every(([key, expected]) => object[key as keyof DistributedObject] === expected)) return false;
      const createdAt = new Date(object.created_at).getTime();
      if (created_after && createdAt < new Date(created_after).getTime()) return false;
      if (created_before && createdAt > new Date(created_before).getTime()) return false;
      if (since && createdAt <= new Date(since).getTime()) return false;
      return true;
    });
    const results: DistributedObject[] = [];
    for (const object of matching) {
      if (isObjectExpired(object)) {
        await this.delete(object.object_id);
      } else {
        results.push(object);
      }
    }
    if (order === 'created_at_desc') {
      results.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
    }
    return limit === undefined ? results : results.slice(0, limit);
  }
}

export class IndexedDbLocalPostMetadataStore implements LocalPostMetadataStore {
  private readonly getDatabase = createObjectDatabaseAccessor();

  async put(metadata: LocalPostMetadata): Promise<void> {
    const database = await this.getDatabase();
    await runTransaction(database, 'readwrite', (store) => store.put(metadata), LOCAL_POST_METADATA_STORE_NAME);
  }

  async get(objectId: string): Promise<LocalPostMetadata | null> {
    const database = await this.getDatabase();
    const metadata = await runRequest<LocalPostMetadata | undefined>(database, 'readonly', (store) => store.get(objectId), LOCAL_POST_METADATA_STORE_NAME);
    return metadata ?? null;
  }

  async delete(objectId: string): Promise<void> {
    const database = await this.getDatabase();
    await runTransaction(database, 'readwrite', (store) => store.delete(objectId), LOCAL_POST_METADATA_STORE_NAME);
  }

  async query(): Promise<LocalPostMetadata[]> {
    const database = await this.getDatabase();
    return runRequest<LocalPostMetadata[]>(database, 'readonly', (store) => store.getAll(), LOCAL_POST_METADATA_STORE_NAME);
  }
}

export class IndexedDbRecommendationSequenceStore implements RecommendationSequenceStore {
  private readonly getDatabase = createObjectDatabaseAccessor();

  async next(author: string): Promise<number> {
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(RECOMMENDATION_SEQUENCE_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(RECOMMENDATION_SEQUENCE_STORE_NAME);
      const request = store.get(author);
      let nextSequence = 1;
      request.onsuccess = () => {
        nextSequence = Number(request.result?.next_sequence ?? 1);
        store.put({ author, next_sequence: nextSequence + 1 });
      };
      transaction.oncomplete = () => resolve(nextSequence);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Recommendation sequence transaction aborted'));
    });
  }
}

export class IndexedDbOutboxStore implements OutboxStore {
  private readonly getDatabase = createObjectDatabaseAccessor();

  async add(entry: OutboxEntry): Promise<void> {
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(OUTBOX_STORE_NAME);
      const request = store.get(entry.object_id);
      request.onsuccess = () => {
        if (request.result === undefined) store.add(entry);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Outbox transaction aborted'));
    });
  }

  async get(objectId: string): Promise<OutboxEntry | null> {
    const database = await this.getDatabase();
    const entry = await runRequest<OutboxEntry | undefined>(database, 'readonly', (store) => store.get(objectId), OUTBOX_STORE_NAME);
    return entry ?? null;
  }

  async listPending(limit: number): Promise<OutboxEntry[]> {
    const database = await this.getDatabase();
    const entries = await runRequest<OutboxEntry[]>(database, 'readonly', (store) => store.getAll(), OUTBOX_STORE_NAME);
    return entries
      .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
      .slice(0, Math.max(0, limit));
  }

  async update(entry: OutboxEntry): Promise<void> {
    const database = await this.getDatabase();
    await runTransaction(database, 'readwrite', (store) => store.put(entry), OUTBOX_STORE_NAME);
  }

  async remove(objectId: string): Promise<void> {
    const database = await this.getDatabase();
    await runTransaction(database, 'readwrite', (store) => store.delete(objectId), OUTBOX_STORE_NAME);
  }

  async pruneExpired(now: Date): Promise<number> {
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(OUTBOX_STORE_NAME);
      const request = store.getAll();
      let removed = 0;
      request.onsuccess = () => {
        for (const entry of request.result as OutboxEntry[]) {
          if (Date.parse(entry.expires_at) <= now.getTime()) {
            store.delete(entry.object_id);
            removed += 1;
          }
        }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Outbox transaction aborted'));
    });
  }
}

function createObjectDatabaseAccessor(): () => Promise<IDBDatabase> {
  let databasePromise: Promise<IDBDatabase> | null = null;
  return () => {
    if (!databasePromise) {
      databasePromise = openObjectDatabase(() => {
        databasePromise = null;
      });
    }
    return databasePromise;
  };
}

function openObjectDatabase(onConnectionClosed: () => void): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'object_id' });
      }
      const objectStore = request.transaction!.objectStore(OBJECT_STORE_NAME);
      if (!objectStore.indexNames.contains(RECIPIENT_CREATED_AT_INDEX)) {
        objectStore.createIndex(RECIPIENT_CREATED_AT_INDEX, ['recipient', 'created_at'], { unique: false });
      }
      if (!request.result.objectStoreNames.contains(LOCAL_POST_METADATA_STORE_NAME)) {
        request.result.createObjectStore(LOCAL_POST_METADATA_STORE_NAME, { keyPath: 'object_id' });
      }
      if (!request.result.objectStoreNames.contains(RECOMMENDATION_SEQUENCE_STORE_NAME)) {
        request.result.createObjectStore(RECOMMENDATION_SEQUENCE_STORE_NAME, { keyPath: 'author' });
      }
      if (!request.result.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
        request.result.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'object_id' });
      }
    };
    request.onblocked = () => {
      console.warn('IndexedDB upgrade is blocked by another open connection.');
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        onConnectionClosed();
      };
      resolve(database);
    };
    request.onerror = () => {
      onConnectionClosed();
      reject(request.error);
    };
  });
}

function runRequest<T = unknown>(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest, storeName = OBJECT_STORE_NAME): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest, storeName = OBJECT_STORE_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    operation(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}