import type { DistributedObject, LocalPostMetadata, LocalPostMetadataStore, ObjectCriteria, ObjectStore, RecommendationSequenceStore } from './types';
import { validateDistributedObject } from './envelope';

const DATABASE_NAME = 'mycelium_objects';
const DATABASE_VERSION = 3;
const OBJECT_STORE_NAME = 'objects';
const LOCAL_POST_METADATA_STORE_NAME = 'local_post_metadata';
const RECOMMENDATION_SEQUENCE_STORE_NAME = 'recommendation_sequences';

export class IndexedDbObjectStore implements ObjectStore {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor() {
    this.databasePromise = openObjectDatabase();
  }

  async put(object: DistributedObject): Promise<void> {
    if (!(await validateDistributedObject(object))) {
      throw new Error('Invalid distributed object');
    }
    const database = await this.databasePromise;
    await runTransaction(database, 'readwrite', (store) => store.put(object));
  }

  async get(objectId: string): Promise<DistributedObject | null> {
    const database = await this.databasePromise;
    const object = await runRequest<DistributedObject | undefined>(database, 'readonly', (store) => store.get(objectId));
    return object ?? null;
  }

  async delete(objectId: string): Promise<void> {
    const database = await this.databasePromise;
    await runTransaction(database, 'readwrite', (store) => store.delete(objectId));
  }

  async query(criteria: ObjectCriteria = {}): Promise<DistributedObject[]> {
    const database = await this.databasePromise;
    const objects = await runRequest<DistributedObject[]>(database, 'readonly', (store) => store.getAll());
    return objects.filter((object) => Object.entries(criteria).every(([key, expected]) => object[key as keyof DistributedObject] === expected));
  }
}

export class IndexedDbLocalPostMetadataStore implements LocalPostMetadataStore {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor() {
    this.databasePromise = openObjectDatabase();
  }

  async put(metadata: LocalPostMetadata): Promise<void> {
    const database = await this.databasePromise;
    await runTransaction(database, 'readwrite', (store) => store.put(metadata), LOCAL_POST_METADATA_STORE_NAME);
  }

  async get(objectId: string): Promise<LocalPostMetadata | null> {
    const database = await this.databasePromise;
    const metadata = await runRequest<LocalPostMetadata | undefined>(database, 'readonly', (store) => store.get(objectId), LOCAL_POST_METADATA_STORE_NAME);
    return metadata ?? null;
  }

  async delete(objectId: string): Promise<void> {
    const database = await this.databasePromise;
    await runTransaction(database, 'readwrite', (store) => store.delete(objectId), LOCAL_POST_METADATA_STORE_NAME);
  }

  async query(): Promise<LocalPostMetadata[]> {
    const database = await this.databasePromise;
    return runRequest<LocalPostMetadata[]>(database, 'readonly', (store) => store.getAll(), LOCAL_POST_METADATA_STORE_NAME);
  }
}

export class IndexedDbRecommendationSequenceStore implements RecommendationSequenceStore {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor() {
    this.databasePromise = openObjectDatabase();
  }

  async next(author: string): Promise<number> {
    const database = await this.databasePromise;
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

function openObjectDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'object_id' });
      }
      if (!request.result.objectStoreNames.contains(LOCAL_POST_METADATA_STORE_NAME)) {
        request.result.createObjectStore(LOCAL_POST_METADATA_STORE_NAME, { keyPath: 'object_id' });
      }
      if (!request.result.objectStoreNames.contains(RECOMMENDATION_SEQUENCE_STORE_NAME)) {
        request.result.createObjectStore(RECOMMENDATION_SEQUENCE_STORE_NAME, { keyPath: 'author' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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