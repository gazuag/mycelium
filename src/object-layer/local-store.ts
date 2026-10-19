import type { DeletionAwareObjectStore, DeletionTombstone, DistributedObject, LocalPostMetadata, LocalPostMetadataStore, ObjectCriteria, ObjectStore, RecommendationSequenceStore } from './types';
import { isObjectExpired, validateDistributedObject } from './envelope';

const DATABASE_NAME = 'mycelium_objects';
const DATABASE_VERSION = 6;
const OBJECT_STORE_NAME = 'objects';
const DELETION_TOMBSTONE_STORE_NAME = 'deletion_tombstones';
const RECIPIENT_CREATED_AT_INDEX = 'recipient_created_at';
const LOCAL_POST_METADATA_STORE_NAME = 'local_post_metadata';
const RECOMMENDATION_SEQUENCE_STORE_NAME = 'recommendation_sequences';
const OUTBOX_STORE_NAME = 'outbox';
const DEFAULT_OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DELETION_TOMBSTONE_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface OutboxEntry {
  readonly object_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly replication_send_attempted?: boolean;
  readonly replicated_to?: string[];
  readonly direct_send_attempted?: boolean;
  readonly delivered_direct?: boolean;
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

export class IndexedDbObjectStore implements DeletionAwareObjectStore {
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
      const transaction = database.transaction(
        [OBJECT_STORE_NAME, DELETION_TOMBSTONE_STORE_NAME],
        'readwrite'
      );
      const store = transaction.objectStore(OBJECT_STORE_NAME);
      const tombstones = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME);
      let admitted = false;
      const targetTombstone = tombstones.get(object.object_id);
      targetTombstone.onsuccess = () => {
        if (targetTombstone.result !== undefined) return;
        const replyPostId = getReplyPostId(object);
        if (replyPostId) {
          const replyTombstone = tombstones.get(replyPostId);
          replyTombstone.onsuccess = () => {
            if (replyTombstone.result !== undefined) return;
            putIfNotPresent();
          };
          replyTombstone.onerror = () => reject(replyTombstone.error);
          return;
        }
        putIfNotPresent();
      };
      targetTombstone.onerror = () => reject(targetTombstone.error);
      transaction.oncomplete = () => resolve(admitted);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));

      function putIfNotPresent() {
        const existing = store.get(object.object_id);
        existing.onsuccess = () => {
          if (existing.result !== undefined) return;
          admitted = true;
          store.put(object);
        };
        existing.onerror = () => reject(existing.error);
      }
    });
  }

  async get(objectId: string): Promise<DistributedObject | null> {
    const database = await this.getDatabase();
    const object = await new Promise<DistributedObject | undefined>((resolve, reject) => {
      const transaction = database.transaction(
        [OBJECT_STORE_NAME, DELETION_TOMBSTONE_STORE_NAME],
        'readonly'
      );
      const objectRequest = transaction.objectStore(OBJECT_STORE_NAME).get(objectId);
      const tombstoneRequest = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME).get(objectId);
      let objectResult: DistributedObject | undefined;
      let isDeleted = false;
      objectRequest.onsuccess = () => { objectResult = objectRequest.result as DistributedObject | undefined; };
      tombstoneRequest.onsuccess = () => { isDeleted = tombstoneRequest.result !== undefined; };
      objectRequest.onerror = () => reject(objectRequest.error);
      tombstoneRequest.onerror = () => reject(tombstoneRequest.error);
      transaction.oncomplete = () => resolve(isDeleted ? undefined : objectResult);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
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
    const { objects, tombstones } = await new Promise<{
      objects: DistributedObject[];
      tombstones: DeletionTombstone[];
    }>((resolve, reject) => {
      const transaction = database.transaction(
        [OBJECT_STORE_NAME, DELETION_TOMBSTONE_STORE_NAME],
        'readonly'
      );
      const objectStore = transaction.objectStore(OBJECT_STORE_NAME);
      const objectRequest = criteria.recipient === undefined
        ? objectStore.getAll()
        : objectStore.index(RECIPIENT_CREATED_AT_INDEX).getAll(
          IDBKeyRange.bound([criteria.recipient, ''], [criteria.recipient, '\uffff'])
        );
      const tombstoneRequest = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME).getAll();
      let resultObjects: DistributedObject[] = [];
      let resultTombstones: DeletionTombstone[] = [];
      objectRequest.onsuccess = () => {
        resultObjects = objectRequest.result as DistributedObject[];
      };
      tombstoneRequest.onsuccess = () => {
        resultTombstones = tombstoneRequest.result as DeletionTombstone[];
      };
      objectRequest.onerror = () => reject(objectRequest.error);
      tombstoneRequest.onerror = () => reject(tombstoneRequest.error);
      transaction.oncomplete = () => resolve({ objects: resultObjects, tombstones: resultTombstones });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    const deletedIds = new Set(tombstones.map((tombstone) => tombstone.target_object_id));
    const { recipient, created_after, created_before, since, order, limit, ...exactCriteria } = criteria;
    const matching = objects.filter((object) => {
      if (deletedIds.has(object.object_id) || (getReplyPostId(object) && deletedIds.has(getReplyPostId(object)!))) return false;
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

  async getDeletionTombstone(targetObjectId: string): Promise<DeletionTombstone | null> {
    const database = await this.getDatabase();
    const tombstone = await runRequest<DeletionTombstone | undefined>(
      database,
      'readonly',
      (store) => store.get(targetObjectId),
      DELETION_TOMBSTONE_STORE_NAME
    );
    return tombstone ?? null;
  }

  async queryDeletionTombstones(): Promise<DeletionTombstone[]> {
    const database = await this.getDatabase();
    return runRequest<DeletionTombstone[]>(
      database,
      'readonly',
      (store) => store.getAll(),
      DELETION_TOMBSTONE_STORE_NAME
    );
  }

  async applyDeletionTombstone(tombstone: DeletionTombstone): Promise<boolean> {
    if (!isValidDeletionTombstone(tombstone)) throw new Error('Invalid deletion tombstone');
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [OBJECT_STORE_NAME, DELETION_TOMBSTONE_STORE_NAME],
        'readwrite'
      );
      const objectStore = transaction.objectStore(OBJECT_STORE_NAME);
      const tombstoneStore = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME);
      const existing = tombstoneStore.get(tombstone.target_object_id);
      let applied = false;
      existing.onsuccess = () => {
        if (existing.result !== undefined) return;
        applied = true;
        tombstoneStore.put(tombstone);
        objectStore.delete(tombstone.target_object_id);
        const relatedReplies = objectStore.getAll();
        relatedReplies.onsuccess = () => {
          for (const object of relatedReplies.result as DistributedObject[]) {
            if (getReplyPostId(object) === tombstone.target_object_id) {
              objectStore.delete(object.object_id);
            }
          }
        };
        relatedReplies.onerror = () => reject(relatedReplies.error);
      };
      existing.onerror = () => reject(existing.error);
      transaction.oncomplete = () => resolve(applied);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async collectDeletionTombstones(now: Date): Promise<number> {
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(DELETION_TOMBSTONE_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME);
      const request = store.getAll();
      let removed = 0;
      request.onsuccess = () => {
        for (const tombstone of request.result as DeletionTombstone[]) {
          const reclaimAfter = Date.parse(tombstone.propagation_expires_at) + DELETION_TOMBSTONE_GC_GRACE_MS;
          if (reclaimAfter <= now.getTime()) {
            store.delete(tombstone.target_object_id);
            removed += 1;
          }
        }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
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
      .sort((left, right) => {
        const leftAttempt = left.last_attempt_at ? Date.parse(left.last_attempt_at) : Number.NEGATIVE_INFINITY;
        const rightAttempt = right.last_attempt_at ? Date.parse(right.last_attempt_at) : Number.NEGATIVE_INFINITY;
        return left.attempts - right.attempts
          || leftAttempt - rightAttempt
          || Date.parse(left.created_at) - Date.parse(right.created_at);
      })
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
      if (!request.result.objectStoreNames.contains(DELETION_TOMBSTONE_STORE_NAME)) {
        request.result.createObjectStore(DELETION_TOMBSTONE_STORE_NAME, { keyPath: 'target_object_id' });
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

function getReplyPostId(object: DistributedObject): string | null {
  if (object.object_type !== 'mycelium.reply'
    || !object.payload || typeof object.payload !== 'object' || Array.isArray(object.payload)) return null;
  const postId = object.payload.reply_post_id;
  return typeof postId === 'string' && /^[0-9a-f]{64}$/.test(postId) ? postId : null;
}

function isValidDeletionTombstone(value: DeletionTombstone): boolean {
  return /^[0-9a-f]{64}$/.test(value.target_object_id)
    && /^[0-9a-f]{64}$/.test(value.delete_request_id)
    && (value.target_object_type === 'mycelium.post' || value.target_object_type === 'mycelium.dm')
    && typeof value.target_author === 'string' && value.target_author.length > 0
    && Number.isFinite(Date.parse(value.target_created_at))
    && Number.isFinite(Date.parse(value.propagation_expires_at))
    && Number.isFinite(Date.parse(value.deleted_at))
    && (value.target_recipient === undefined
      || (typeof value.target_recipient === 'string' && value.target_recipient.length > 0));
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