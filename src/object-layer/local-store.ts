import type { DeletionAwareObjectStore, DeletionTombstone, DistributedObject, LocalPostMetadata, LocalPostMetadataStore, ObjectCriteria, ObjectStore, RecommendationSequenceStore } from './types';
import { isObjectExpired, validateDistributedObject } from './envelope';
import {
  DEFAULT_OBJECT_STORAGE_BYTES,
  getObservationRecordByteSize,
  getStoredObjectByteSize,
  planObjectStorageGarbageCollection,
  validateObjectStorageLimit,
  validateObjectStorageGcOptions,
  type ObjectStorageGcOptions,
  type ObjectStorageGcPlan
} from './storage-gc';

const DATABASE_NAME = 'mycelium_objects';
const DATABASE_VERSION = 7;
const OBJECT_STORE_NAME = 'objects';
const DELETION_TOMBSTONE_STORE_NAME = 'deletion_tombstones';
const OBJECT_OBSERVATION_STORE_NAME = 'object_observations';
const RECIPIENT_CREATED_AT_INDEX = 'recipient_created_at';
const LOCAL_POST_METADATA_STORE_NAME = 'local_post_metadata';
const RECOMMENDATION_SEQUENCE_STORE_NAME = 'recommendation_sequences';
const OUTBOX_STORE_NAME = 'outbox';
const DEFAULT_OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

interface ObjectObservationRecord {
  readonly object_id: string;
  readonly observed_at: string;
}

export class IndexedDbObjectStore implements DeletionAwareObjectStore {
  private readonly getDatabase = createObjectDatabaseAccessor();
  private readonly gcOptions: ObjectStorageGcOptions;

  constructor(gcOptions: ObjectStorageGcOptions = {}) {
    validateObjectStorageGcOptions(gcOptions);
    this.gcOptions = gcOptions;
  }

  private get databasePromise(): Promise<IDBDatabase> {
    return this.getDatabase();
  }

  async put(object: DistributedObject): Promise<boolean> {
    if (!(await validateDistributedObject(object))) {
      throw new Error('Invalid distributed object');
    }
    const database = await this.getDatabase();
    const admitted = await new Promise<boolean>((resolve, reject) => {
      const observedAt = (this.gcOptions.now?.() ?? new Date()).toISOString();
      const transaction = database.transaction(
        [OBJECT_STORE_NAME, DELETION_TOMBSTONE_STORE_NAME, OBJECT_OBSERVATION_STORE_NAME],
        'readwrite'
      );
      const store = transaction.objectStore(OBJECT_STORE_NAME);
      const tombstones = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME);
      const observations = transaction.objectStore(OBJECT_OBSERVATION_STORE_NAME);
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
          observations.put({
            object_id: object.object_id,
            observed_at: observedAt
          } satisfies ObjectObservationRecord);
        };
        existing.onerror = () => reject(existing.error);
      }
    });
    if (admitted) await this.collectGarbage();
    return admitted;
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
    const transaction = database.transaction(
      [OBJECT_STORE_NAME, OBJECT_OBSERVATION_STORE_NAME],
      'readwrite'
    );
    transaction.objectStore(OBJECT_STORE_NAME).delete(objectId);
    transaction.objectStore(OBJECT_OBSERVATION_STORE_NAME).delete(objectId);
    await transactionDone(transaction);
    await this.collectGarbage();
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
    const applied = await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(
        [OBJECT_STORE_NAME, DELETION_TOMBSTONE_STORE_NAME, OBJECT_OBSERVATION_STORE_NAME],
        'readwrite'
      );
      const objectStore = transaction.objectStore(OBJECT_STORE_NAME);
      const tombstoneStore = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME);
      const observationStore = transaction.objectStore(OBJECT_OBSERVATION_STORE_NAME);
      const existing = tombstoneStore.get(tombstone.target_object_id);
      let applied = false;
      existing.onsuccess = () => {
        if (existing.result !== undefined) return;
        applied = true;
        tombstoneStore.put(tombstone);
        objectStore.delete(tombstone.target_object_id);
        observationStore.delete(tombstone.target_object_id);
        const relatedReplies = objectStore.getAll();
        relatedReplies.onsuccess = () => {
          for (const object of relatedReplies.result as DistributedObject[]) {
            if (getReplyPostId(object) === tombstone.target_object_id) {
              objectStore.delete(object.object_id);
              observationStore.delete(object.object_id);
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
    if (applied) await this.collectGarbage();
    return applied;
  }

  async collectGarbage(): Promise<ObjectStorageGcPlan> {
    const database = await this.getDatabase();
    const now = this.gcOptions.now?.() ?? new Date();
    const localAuthor = this.gcOptions.getLocalAuthor?.();
    const followedAuthors = this.gcOptions.getFollowedAuthors?.() ?? new Set<string>();
    const maxStorageBytes = this.gcOptions.getMaxStorageBytes?.()
      ?? this.gcOptions.maxStorageBytes
      ?? DEFAULT_OBJECT_STORAGE_BYTES;
    validateObjectStorageLimit(maxStorageBytes);
    const result = await new Promise<ObjectStorageGcPlan>((resolve, reject) => {
      const transaction = database.transaction(
        [
          OBJECT_STORE_NAME,
          DELETION_TOMBSTONE_STORE_NAME,
          OBJECT_OBSERVATION_STORE_NAME
        ],
        'readwrite'
      );
      const objectStore = transaction.objectStore(OBJECT_STORE_NAME);
      const tombstoneStore = transaction.objectStore(DELETION_TOMBSTONE_STORE_NAME);
      const observationStore = transaction.objectStore(OBJECT_OBSERVATION_STORE_NAME);
      const objectsRequest = objectStore.getAll();
      const tombstonesRequest = tombstoneStore.getAll();
      const observationsRequest = observationStore.getAll();
      let objects: DistributedObject[] | undefined;
      let tombstones: DeletionTombstone[] | undefined;
      let observations: ObjectObservationRecord[] | undefined;
      let plan: ObjectStorageGcPlan | undefined;

      const prepareCollection = () => {
        if (!objects || !tombstones || !observations || plan) return;
        const timestamp = now.toISOString();
        const observationById = new Map(observations.map((record) => [record.object_id, record]));
        const retainedIds = new Set(objects.map((object) => object.object_id));
        const gcObjects = objects.map((object) => {
          const storedObservation = observationById.get(object.object_id);
          const observedAt = storedObservation && Number.isFinite(Date.parse(storedObservation.observed_at))
            ? storedObservation.observed_at
            : timestamp;
          const observationRecord = { object_id: object.object_id, observed_at: observedAt };
          if (!storedObservation || storedObservation.observed_at !== observedAt) {
            observationStore.put(observationRecord);
          }
          return {
            object,
            observedAt,
            byteSize: getStoredObjectByteSize(object) + getObservationRecordByteSize(object.object_id, observedAt)
          };
        });
        const existingObservationIds = new Set(gcObjects.map(({ object }) => object.object_id));
        for (const observation of observations) {
          if (!existingObservationIds.has(observation.object_id)) observationStore.delete(observation.object_id);
        }
        const currentBytes = gcObjects.reduce((total, entry) => total + entry.byteSize, 0)
          + tombstones.reduce((total, tombstone) => total + getStoredObjectByteSize(tombstone), 0);
        const planResult = planObjectStorageGarbageCollection({
          currentBytes,
          maxStorageBytes,
          highWaterRatio: this.gcOptions.highWaterRatio,
          lowWaterRatio: this.gcOptions.lowWaterRatio,
          now,
          objects: gcObjects,
          tombstones: tombstones.map((tombstone) => ({
            tombstone,
            byteSize: getStoredObjectByteSize(tombstone),
            targetIsRetained: retainedIds.has(tombstone.target_object_id)
          })),
          context: {
            localAuthor,
            followedAuthors,
            ...getLocalRecommendationState(objects, localAuthor)
          }
        });
        for (const objectId of planResult.removedObjectIds) {
          objectStore.delete(objectId);
          observationStore.delete(objectId);
        }
        for (const tombstoneId of planResult.removedTombstoneIds) tombstoneStore.delete(tombstoneId);
        plan = planResult;
      };

      objectsRequest.onsuccess = () => { objects = objectsRequest.result as DistributedObject[]; prepareCollection(); };
      tombstonesRequest.onsuccess = () => { tombstones = tombstonesRequest.result as DeletionTombstone[]; prepareCollection(); };
      observationsRequest.onsuccess = () => { observations = observationsRequest.result as ObjectObservationRecord[]; prepareCollection(); };
      objectsRequest.onerror = () => reject(objectsRequest.error);
      tombstonesRequest.onerror = () => reject(tombstonesRequest.error);
      observationsRequest.onerror = () => reject(observationsRequest.error);
      transaction.oncomplete = () => {
        if (!plan) {
          reject(new Error('Object storage garbage collection did not produce a plan'));
          return;
        }
        resolve(plan);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Object storage GC transaction aborted'));
    });
    this.gcOptions.onStorageUsageChange?.(result.bytesAfter);
    return result;
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
      if (!request.result.objectStoreNames.contains(OBJECT_OBSERVATION_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_OBSERVATION_STORE_NAME, { keyPath: 'object_id' });
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

function getLocalRecommendationState(
  objects: readonly DistributedObject[],
  localAuthor: string | undefined
): { likedPostIds: Set<string>; explicitlyValuableObjectIds: Set<string> } {
  if (!localAuthor) return { likedPostIds: new Set(), explicitlyValuableObjectIds: new Set() };
  const latestByPost = new Map<string, {
    objectId: string;
    sequence: number;
    action: 'recommend' | 'withdraw';
  }>();
  for (const object of objects) {
    if (object.object_type !== 'mycelium.recommendation' || object.author !== localAuthor
      || !object.payload || typeof object.payload !== 'object' || Array.isArray(object.payload)) continue;
    const payload = object.payload as Record<string, unknown>;
    if (typeof payload.post_id !== 'string'
      || (payload.action !== 'recommend' && payload.action !== 'withdraw')) continue;
    const sequence = typeof object.sequence === 'number' && Number.isFinite(object.sequence)
      ? object.sequence
      : 0;
    const existing = latestByPost.get(payload.post_id);
    if (existing && existing.sequence >= sequence) continue;
    latestByPost.set(payload.post_id, {
      objectId: object.object_id,
      sequence,
      action: payload.action
    });
  }
  return {
    likedPostIds: new Set([...latestByPost]
      .filter(([, recommendation]) => recommendation.action === 'recommend')
      .map(([postId]) => postId)),
    explicitlyValuableObjectIds: new Set([...latestByPost.values()].map(({ objectId }) => objectId))
  };
}

function isValidDeletionTombstone(value: DeletionTombstone): boolean {
  return /^[0-9a-f]{64}$/.test(value.target_object_id)
    && /^[0-9a-f]{64}$/.test(value.delete_request_id)
    && (value.target_object_type === 'mycelium.post' || value.target_object_type === 'mycelium.dm')
    && typeof value.target_author === 'string' && value.target_author.length > 0
    && Number.isFinite(Date.parse(value.target_created_at))
    && Number.isFinite(Date.parse(value.deleted_at))
    && (value.target_recipient === undefined
      || (typeof value.target_recipient === 'string' && value.target_recipient.length > 0));
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
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