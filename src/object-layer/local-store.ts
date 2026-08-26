import type { DistributedObject, ObjectCriteria, ObjectStore } from './types';
import { validateDistributedObject } from './envelope';

const DATABASE_NAME = 'mycelium_objects';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'objects';

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

function openObjectDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'object_id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runRequest<T = unknown>(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OBJECT_STORE_NAME, mode);
    const request = operation(transaction.objectStore(OBJECT_STORE_NAME));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OBJECT_STORE_NAME, mode);
    operation(transaction.objectStore(OBJECT_STORE_NAME));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}