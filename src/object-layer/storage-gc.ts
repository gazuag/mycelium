import type { DeletionTombstone, DistributedObject } from './types';

export const BYTES_PER_MB = 1_000_000;
export const MIN_OBJECT_STORAGE_BYTES = 100 * BYTES_PER_MB;
export const DEFAULT_OBJECT_STORAGE_BYTES = 500 * BYTES_PER_MB;
export const MAX_OBJECT_STORAGE_LIMIT_MB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MB);
export const OBJECT_STORAGE_LIMIT_STORAGE_KEY = 'myceliumObjectStorageLimitMb';

export const OBJECT_STORAGE_GC_HIGH_WATER_RATIO = 0.9;
export const OBJECT_STORAGE_GC_LOW_WATER_RATIO = 0.78;
export const OBJECT_STORAGE_GC_SEVERE_PRESSURE_RATIO = 1;

export const DELETION_TOMBSTONE_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const OWN_DELETION_TOMBSTONE_GRACE_PERIOD_MS = 365 * 24 * 60 * 60 * 1000;

export const RETENTION_PRIORITY_WEIGHTS = {
  1: 0.01,
  2: 0.25,
  3: 1,
  4: 2
} as const;

export type RetentionPriority = keyof typeof RETENTION_PRIORITY_WEIGHTS;

export interface ObjectStorageGcContext {
  readonly localAuthor?: string;
  readonly followedAuthors?: ReadonlySet<string>;
  readonly likedPostIds?: ReadonlySet<string>;
  readonly explicitlyValuableObjectIds?: ReadonlySet<string>;
}

export interface ObjectStorageGcOptions {
  readonly maxStorageBytes?: number;
  readonly getMaxStorageBytes?: () => number;
  readonly onStorageUsageChange?: (usedBytes: number) => void;
  readonly highWaterRatio?: number;
  readonly lowWaterRatio?: number;
  readonly now?: () => Date;
  readonly getLocalAuthor?: () => string | undefined;
  readonly getFollowedAuthors?: () => ReadonlySet<string>;
}

export function parseObjectStorageLimitMb(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return DEFAULT_OBJECT_STORAGE_BYTES / BYTES_PER_MB;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed * BYTES_PER_MB < MIN_OBJECT_STORAGE_BYTES
    || !Number.isSafeInteger(parsed * BYTES_PER_MB)) {
    return DEFAULT_OBJECT_STORAGE_BYTES / BYTES_PER_MB;
  }
  return parsed;
}

export interface ObjectStorageGcObject {
  readonly object: DistributedObject;
  readonly observedAt: string;
  readonly byteSize: number;
}

export interface ObjectStorageGcTombstone {
  readonly tombstone: DeletionTombstone;
  readonly byteSize: number;
  readonly targetIsRetained: boolean;
}

export interface ObjectStorageGcPlanInput {
  readonly currentBytes: number;
  readonly maxStorageBytes: number;
  readonly highWaterRatio?: number;
  readonly lowWaterRatio?: number;
  readonly now: Date;
  readonly objects: readonly ObjectStorageGcObject[];
  readonly tombstones: readonly ObjectStorageGcTombstone[];
  readonly context?: ObjectStorageGcContext;
}

export interface ObjectStorageGcPlan {
  readonly triggered: boolean;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly targetReached: boolean;
  readonly removedObjectIds: readonly string[];
  readonly removedTombstoneIds: readonly string[];
}

interface EvictionCandidate {
  readonly id: string;
  readonly byteSize: number;
  readonly score: number;
  readonly priority: RetentionPriority;
  readonly kind: 'object' | 'tombstone';
}

export function validateObjectStorageGcOptions(options: ObjectStorageGcOptions): void {
  if (options.maxStorageBytes !== undefined) validateObjectStorageLimit(options.maxStorageBytes);
  const highWaterRatio = options.highWaterRatio ?? OBJECT_STORAGE_GC_HIGH_WATER_RATIO;
  const lowWaterRatio = options.lowWaterRatio ?? OBJECT_STORAGE_GC_LOW_WATER_RATIO;
  if (!Number.isFinite(highWaterRatio) || !Number.isFinite(lowWaterRatio)
    || lowWaterRatio <= 0 || lowWaterRatio >= highWaterRatio || highWaterRatio >= 1) {
    throw new RangeError('Object storage GC thresholds must satisfy 0 < lowWaterRatio < highWaterRatio < 1');
  }
}

export function validateObjectStorageLimit(maxStorageBytes: number): void {
  if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < MIN_OBJECT_STORAGE_BYTES) {
    throw new RangeError(`Object storage allocation must be at least ${MIN_OBJECT_STORAGE_BYTES} bytes`);
  }
}

export function classifyObjectRetentionPriority(
  object: DistributedObject,
  context: ObjectStorageGcContext = {}
): RetentionPriority {
  if (context.explicitlyValuableObjectIds?.has(object.object_id)) return 2;

  const localAuthor = context.localAuthor;
  if (localAuthor && (
    (object.object_type === 'mycelium.post' && object.author === localAuthor)
    || (object.object_type === 'mycelium.dm'
      && (object.author === localAuthor || object.recipient === localAuthor))
  )) return 1;

  if (object.object_type === 'mycelium.post') {
    if (context.likedPostIds?.has(object.object_id)
      || context.followedAuthors?.has(object.author)) return 2;
  }

  if (object.object_type === 'mycelium.recommendation'
    || object.object_type === 'mycelium.reply'
    || object.object_type === 'mycelium.delete-request') return 4;

  return 3;
}

export function calculateEvictionScore(ageMs: number, priority: RetentionPriority): number {
  return (Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0) * RETENTION_PRIORITY_WEIGHTS[priority];
}

export function isDeletionTombstoneEligible(
  tombstone: DeletionTombstone,
  targetIsRetained: boolean,
  localAuthor: string | undefined,
  now: Date
): boolean {
  if (targetIsRetained) return false;
  const deletedAt = Date.parse(tombstone.deleted_at);
  if (!Number.isFinite(deletedAt)) return false;
  const gracePeriod = localAuthor && tombstone.target_author === localAuthor
    ? OWN_DELETION_TOMBSTONE_GRACE_PERIOD_MS
    : DELETION_TOMBSTONE_GRACE_PERIOD_MS;
  return now.getTime() - deletedAt >= gracePeriod;
}

export function planObjectStorageGarbageCollection(input: ObjectStorageGcPlanInput): ObjectStorageGcPlan {
  const highWaterRatio = input.highWaterRatio ?? OBJECT_STORAGE_GC_HIGH_WATER_RATIO;
  const lowWaterRatio = input.lowWaterRatio ?? OBJECT_STORAGE_GC_LOW_WATER_RATIO;
  const bytesBefore = Number.isFinite(input.currentBytes) ? Math.max(0, input.currentBytes) : 0;
  const highWaterBytes = input.maxStorageBytes * highWaterRatio;
  if (bytesBefore < highWaterBytes) {
    return {
      triggered: false,
      bytesBefore,
      bytesAfter: bytesBefore,
      targetReached: bytesBefore <= input.maxStorageBytes * lowWaterRatio,
      removedObjectIds: [],
      removedTombstoneIds: []
    };
  }

  const context = input.context ?? {};
  const protectedCandidates: EvictionCandidate[] = [];
  const ordinaryCandidates: EvictionCandidate[] = [];
  for (const entry of input.objects) {
    const priority = classifyObjectRetentionPriority(entry.object, context);
    const candidate: EvictionCandidate = {
      id: entry.object.object_id,
      byteSize: normalizeByteSize(entry.byteSize),
      score: calculateEvictionScore(
        input.now.getTime() - Date.parse(entry.observedAt),
        priority
      ),
      priority,
      kind: 'object'
    };
    (priority === 1 ? protectedCandidates : ordinaryCandidates).push(candidate);
  }

  for (const entry of input.tombstones) {
    if (!isDeletionTombstoneEligible(entry.tombstone, entry.targetIsRetained, context.localAuthor, input.now)) continue;
    const isOwnDeletion = Boolean(context.localAuthor && entry.tombstone.target_author === context.localAuthor);
    const priority: RetentionPriority = isOwnDeletion ? 1 : 4;
    const candidate: EvictionCandidate = {
      id: entry.tombstone.target_object_id,
      byteSize: normalizeByteSize(entry.byteSize),
      score: calculateEvictionScore(
        input.now.getTime() - Date.parse(entry.tombstone.deleted_at),
        priority
      ),
      priority,
      kind: 'tombstone'
    };
    (isOwnDeletion ? protectedCandidates : ordinaryCandidates).push(candidate);
  }

  const lowWaterBytes = input.maxStorageBytes * lowWaterRatio;
  let bytesAfter = bytesBefore;
  const removedObjectIds: string[] = [];
  const removedTombstoneIds: string[] = [];
  evictUntilLowWater(ordinaryCandidates, lowWaterBytes);
  if (bytesAfter > lowWaterBytes
    && bytesBefore >= input.maxStorageBytes * OBJECT_STORAGE_GC_SEVERE_PRESSURE_RATIO) {
    evictUntilLowWater(protectedCandidates, lowWaterBytes);
  }

  return {
    triggered: true,
    bytesBefore,
    bytesAfter,
    targetReached: bytesAfter <= lowWaterBytes,
    removedObjectIds,
    removedTombstoneIds
  };

  function evictUntilLowWater(candidates: EvictionCandidate[], targetBytes: number): void {
    candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    for (const candidate of candidates) {
      if (bytesAfter <= targetBytes) break;
      bytesAfter = Math.max(0, bytesAfter - candidate.byteSize);
      if (candidate.kind === 'object') removedObjectIds.push(candidate.id);
      else removedTombstoneIds.push(candidate.id);
    }
  }
}

function normalizeByteSize(byteSize: number): number {
  return Number.isFinite(byteSize) ? Math.max(0, byteSize) : 0;
}

export function getStoredObjectByteSize(value: DistributedObject | DeletionTombstone): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function getObservationRecordByteSize(objectId: string, observedAt: string): number {
  return new TextEncoder().encode(JSON.stringify({ object_id: objectId, observed_at: observedAt })).byteLength;
}
