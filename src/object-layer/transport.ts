import { buildPacket, createPacketId, isMyceliumPacket, type PacketSigner } from '../p2p/protocol';
import { isObjectExpired, validateDistributedObject, validateObject } from './envelope';
import { ensurePostChainCached, type PostParentResolver } from './post-ancestry';
import type { DistributedObject, FindPacket, FindQueryCriteria, FindResponsePacket, FeedPageMetadata, ObjectBatchPacket, ObjectPacket, ObjectStore, ObjectStorePacket, ObjectTransport } from './types';

const FIND_REQUEST_LIFETIME_MS = 5000;
export const MAX_FIND_QUERY_LIMIT = 500;
export const MAX_FIND_REQUEST_OBJECT_IDS = 200;
export const MAX_OBJECT_BATCH_SIZE = 50;
export const FIND_GRACE_PERIOD_MS = 1000;
export type FindAggregationCompletionReason = 'all-objects-found' | 'all-children-responded-or-failed' | 'grace-expired' | 'child-failure-grace-expired' | 'deadline-expired';

export async function buildObjectStorePacket(
  sender: string,
  recipient: string,
  object: ObjectStorePacket['payload']['object'],
  signer?: PacketSigner
): Promise<ObjectPacket> {
  return await buildPacket(sender, recipient, 'OBJECT_STORE', { object }, signer) as ObjectStorePacket;
}

export async function buildObjectBatchPacket(
  sender: string,
  recipient: string,
  objects: DistributedObject[],
  signer?: PacketSigner,
  page?: FeedPageMetadata
): Promise<ObjectBatchPacket> {
  return await buildPacket(sender, recipient, 'OBJECT_BATCH', { objects, ...(page ? { page } : {}) }, signer) as ObjectBatchPacket;
}

export async function sendObjectBatches(
  sender: string,
  recipient: string,
  objects: readonly DistributedObject[],
  transport: ObjectTransport,
  signer?: PacketSigner,
  page?: FeedPageMetadata
): Promise<number> {
  const uniqueObjects = [...new Map(objects.map((object) => [object.object_id, object])).values()];
  const batchCount = Math.max(1, Math.ceil(uniqueObjects.length / MAX_OBJECT_BATCH_SIZE));
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const start = batchIndex * MAX_OBJECT_BATCH_SIZE;
    const batch = uniqueObjects.slice(start, start + MAX_OBJECT_BATCH_SIZE);
    const isFinalBatch = batchIndex === batchCount - 1;
    await transport.send(recipient, await buildObjectBatchPacket(
      sender,
      recipient,
      batch,
      signer,
      isFinalBatch ? page : undefined
    ));
  }
  return uniqueObjects.length;
}

export async function buildFindPacket(
  sender: string,
  recipient: string,
  objectId: string | string[],
  signer?: PacketSigner,
  requestId = createPacketId(),
  ttl = 1,
  origin?: string,
  expiresAt = new Date(Date.now() + FIND_REQUEST_LIFETIME_MS).toISOString(),
  query?: FindQueryCriteria
): Promise<FindPacket> {
  const requestedObjects = Array.isArray(objectId) ? objectId : [objectId];
  if (requestedObjects.length > MAX_FIND_REQUEST_OBJECT_IDS) {
    console.warn(`Rejecting oversized FIND request: ${requestedObjects.length} object IDs exceeds ${MAX_FIND_REQUEST_OBJECT_IDS}`);
    throw new Error(`Too many object IDs in FIND request: ${requestedObjects.length} exceeds ${MAX_FIND_REQUEST_OBJECT_IDS}`);
  }
  return await buildPacket(sender, recipient, 'FIND', {
    requested_objects: requestedObjects,
    object_id: requestedObjects[0] ?? '',
    requestId,
    ttl,
    expiresAt,
    ...(origin ? { origin } : {}),
    ...(query?.object_type ? { object_type: query.object_type } : {}),
    ...(query?.author ? { author: query.author } : {}),
    ...(query?.recipient ? { recipient: query.recipient } : {}),
    ...(query?.created_after ? { created_after: query.created_after } : {}),
    ...(query?.created_before ? { created_before: query.created_before } : {}),
    ...(query?.page_before ? { page_before: query.page_before } : {}),
    ...(query?.since ? { since: query.since } : {}),
    ...(query?.limit === undefined ? {} : { limit: query.limit }),
    ...(query?.order ? { order: query.order } : {})
  }, signer) as FindPacket;
}

export async function buildTimeRangeFindPacket(
  sender: string,
  recipient: string,
  author: string,
  createdAfter: string,
  createdBefore: string,
  signer?: PacketSigner,
  requestId = createPacketId(),
  ttl = 1,
  origin?: string,
  expiresAt = new Date(Date.now() + FIND_REQUEST_LIFETIME_MS).toISOString(),
  objectIds: string[] = [],
  limit?: number
): Promise<FindPacket> {
  return buildFindPacket(sender, recipient, objectIds, signer, requestId, ttl, origin, expiresAt, {
    author,
    created_after: createdAfter,
    created_before: createdBefore,
    limit
  });
}

export async function buildFindResponsePacket(
  sender: string,
  recipient: string,
  objectId: string,
  requestId: string,
  object?: DistributedObject,
  signer?: PacketSigner,
  origin?: string,
  expiresAt?: string,
  complete = true,
  paginationSupported?: boolean,
  hasMore?: boolean
): Promise<FindResponsePacket> {
  return await buildPacket(sender, recipient, 'FIND_RESPONSE', {
    objects: object ? [object] : [],
    object_id: objectId,
    requestId,
    complete,
    ...(paginationSupported === undefined ? {} : { pagination_supported: paginationSupported }),
    ...(hasMore === undefined ? {} : { has_more: hasMore }),
    ...(expiresAt ? { expiresAt } : {}),
    ...(origin ? { origin } : {}),
    ...(object ? { object } : {})
  }, signer) as FindResponsePacket;
}

export async function buildFindResponseObjectsPacket(
  sender: string,
  recipient: string,
  requestId: string,
  objects: DistributedObject[],
  signer?: PacketSigner,
  origin?: string,
  expiresAt?: string,
  complete = true,
  paginationSupported?: boolean,
  hasMore?: boolean
): Promise<FindResponsePacket> {
  return await buildPacket(sender, recipient, 'FIND_RESPONSE', {
    objects,
    object_id: objects[0]?.object_id ?? '',
    requestId,
    complete,
    ...(paginationSupported === undefined ? {} : { pagination_supported: paginationSupported }),
    ...(hasMore === undefined ? {} : { has_more: hasMore }),
    ...(expiresAt ? { expiresAt } : {}),
    ...(origin ? { origin } : {})
  }, signer) as FindResponsePacket;
}

export function getFindObjectIds(packet: FindPacket): string[] | null {
  const requested = packet.payload?.requested_objects;
  if (Array.isArray(requested)) {
    if (requested.some((objectId) => typeof objectId !== 'string' || !/^[0-9a-f]{64}$/.test(objectId))) return null;
    return [...new Set(requested)];
  }
  const legacyObjectId = packet.payload?.object_id;
  return typeof legacyObjectId === 'string' && /^[0-9a-f]{64}$/.test(legacyObjectId) ? [legacyObjectId] : null;
}

export function selectFindPeers(connectedPeers: string[], incomingPeer: string, selfPeer: string, fanout = 2): string[] {
  return connectedPeers.filter((peerId) => peerId !== incomingPeer && peerId !== selfPeer).slice(0, fanout);
}

export function compareObjectsByCreatedAtDesc(left: DistributedObject, right: DistributedObject): number {
  return Date.parse(right.created_at) - Date.parse(left.created_at)
    || (right.object_id < left.object_id ? -1 : right.object_id > left.object_id ? 1 : 0);
}

export function shouldRetainFindRequestRoute(
  peerId: string,
  route: { upstreamPeer: string; expiresAt: number } | undefined,
  aggregationState?: { aggregation: Pick<FindAggregation, 'isComplete' | 'pendingChildren'> }
): boolean {
  if (!route || route.upstreamPeer === peerId) return false;
  if (!aggregationState) return false;
  if (aggregationState.aggregation.isComplete()) return false;
  return aggregationState.aggregation.pendingChildren().length > 0;
}

export async function receiveObjectPacket(
  packet: unknown,
  store: ObjectStore,
  resolvePostParent?: PostParentResolver
): Promise<boolean> {
  if (!isMyceliumPacket(packet) || packet.type !== 'OBJECT_STORE') return false;
  const object = packet.payload?.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  if (!(await validateObject(object))) return false;

  const distributedObject = object as DistributedObject;
  const stored = await store.put(distributedObject);
  if (distributedObject.object_type === 'mycelium.post' && resolvePostParent) {
    const chain = await ensurePostChainCached(distributedObject, store, resolvePostParent);
    if (!chain.complete || chain.storageFailures.length > 0) {
      console.warn(`Post ancestry incomplete for ${distributedObject.object_id}: ${chain.stopReason}${chain.missingObjectId ? ` (${chain.missingObjectId})` : ''}`);
    }
  }
  return stored;
}

export async function receiveObjectBatchPacket(
  packet: unknown,
  store: ObjectStore,
  resolvePostParent?: PostParentResolver
): Promise<boolean[]> {
  if (!isMyceliumPacket(packet) || packet.type !== 'OBJECT_BATCH') return [];
  const objects = packet.payload?.objects;
  if (!Array.isArray(objects)) return [];
  const storedFlags: boolean[] = [];
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object) || !(await validateObject(object))) {
      storedFlags.push(false);
      continue;
    }
    const distributedObject = object as DistributedObject;
    const stored = await store.put(distributedObject);
    if (distributedObject.object_type === 'mycelium.post' && resolvePostParent) {
      const chain = await ensurePostChainCached(distributedObject, store, resolvePostParent);
      if (!chain.complete || chain.storageFailures.length > 0) {
        console.warn(`Post ancestry incomplete for ${distributedObject.object_id}: ${chain.stopReason}${chain.missingObjectId ? ` (${chain.missingObjectId})` : ''}`);
      }
    }
    storedFlags.push(stored);
  }
  return storedFlags;
}

export async function receiveAndReplicate(
  value: unknown,
  sourcePeerId: string,
  store: ObjectStore,
  transport: ObjectTransport,
  sender: string,
  signer?: PacketSigner,
  log: (message: string) => void = () => {},
  resolvePostParent?: PostParentResolver,
  attemptedToByObject = new Map<string, Set<string>>()
): Promise<boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(await validateObject(value))) return false;

  const object = value as DistributedObject;
  const stored = await store.put(object);
  if (!stored && object.object_type !== 'mycelium.post') return false;

  let objectsToReplicate = [object];
  if (object.object_type === 'mycelium.post' && resolvePostParent) {
    const chain = await ensurePostChainCached(object, store, resolvePostParent);
    objectsToReplicate = stored
      ? chain.objects
      : chain.objects.filter((chainObject) =>
          chainObject.object_id !== object.object_id && chain.newlyCachedObjectIds.includes(chainObject.object_id)
        );
    if (!chain.complete || chain.storageFailures.length > 0) {
      log(`POST ancestry incomplete after receiving ${object.object_id}: reason=${chain.stopReason}${chain.missingObjectId ? ` missing=${chain.missingObjectId}` : ''}${chain.error ? ` error=${chain.error}` : ''} storageFailures=${chain.storageFailures.length}`);
    }
  } else if (!stored) {
    return false;
  }

  if (objectsToReplicate.length === 0) return false;
  for (const chainObject of objectsToReplicate) {
    const alreadyAttemptedTo = attemptedToByObject.get(chainObject.object_id) ?? new Set<string>();
    if (chainObject.object_id === object.object_id) alreadyAttemptedTo.add(sourcePeerId);
    const result = await replicateObject(sender, chainObject, transport, signer, alreadyAttemptedTo, log);
    result.attempted.forEach((peerId) => alreadyAttemptedTo.add(peerId));
    attemptedToByObject.set(chainObject.object_id, alreadyAttemptedTo);
  }
  return stored;
}

export async function receiveBatchAndReplicate(
  objects: readonly unknown[],
  sourcePeerId: string,
  store: ObjectStore,
  transport: ObjectTransport,
  sender: string,
  signer?: PacketSigner,
  log: (message: string) => void = () => {},
  resolvePostParent?: PostParentResolver
): Promise<boolean[]> {
  const storedFlags: boolean[] = [];
  const attemptedToByObject = new Map<string, Set<string>>();
  for (const object of objects) {
    storedFlags.push(await receiveAndReplicate(
      object,
      sourcePeerId,
      store,
      transport,
      sender,
      signer,
      log,
      resolvePostParent,
      attemptedToByObject
    ));
  }
  return storedFlags;
}

export async function receiveFindResponsePacket(packet: unknown, store: ObjectStore, expectedRequestId?: string): Promise<DistributedObject | null> {
  if (!isMyceliumPacket(packet) || packet.type !== 'FIND_RESPONSE') return null;
  if (typeof packet.payload?.requestId !== 'string' || (expectedRequestId && packet.payload.requestId !== expectedRequestId)) return null;
  const object = packet.payload?.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  if (typeof packet.payload?.object_id !== 'string' || packet.payload.object_id !== (object as DistributedObject).object_id) return null;
  if (!(await validateObject(object))) return null;
  await store.put(object as DistributedObject);
  return object as DistributedObject;
}

export function getFindQueryCriteria(packet: FindPacket): FindQueryCriteria | null {
  const objectType = typeof packet.payload?.object_type === 'string' ? packet.payload.object_type : undefined;
  const author = typeof packet.payload?.author === 'string' ? packet.payload.author : undefined;
  const rawRecipient = packet.payload?.recipient;
  const recipient = typeof rawRecipient === 'string' && rawRecipient.trim().length > 0 ? rawRecipient : undefined;
  if (rawRecipient !== undefined && recipient === undefined) return null;
  const createdAfter = typeof packet.payload?.created_after === 'string' ? packet.payload.created_after : undefined;
  const createdBefore = typeof packet.payload?.created_before === 'string' ? packet.payload.created_before : undefined;
  const rawPageBefore = packet.payload?.page_before;
  const pageBefore = rawPageBefore && typeof rawPageBefore === 'object'
    && typeof rawPageBefore.created_at === 'string'
    && Number.isFinite(Date.parse(rawPageBefore.created_at))
    && typeof rawPageBefore.object_id === 'string'
    && /^[0-9a-f]{64}$/.test(rawPageBefore.object_id)
    ? { created_at: rawPageBefore.created_at, object_id: rawPageBefore.object_id }
    : undefined;
  if (rawPageBefore !== undefined && pageBefore === undefined) return null;
  const since = typeof packet.payload?.since === 'string' ? packet.payload.since : undefined;
  const rawLimit = packet.payload?.limit;
  const order = packet.payload?.order === 'created_at_desc' ? packet.payload.order : undefined;
  const hasQuery = Boolean(objectType || author || recipient || createdAfter || createdBefore || pageBefore || since || rawLimit !== undefined || order);
  if (!hasQuery) return null;
  const limit = typeof rawLimit === 'number' && Number.isSafeInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_FIND_QUERY_LIMIT)
    : MAX_FIND_QUERY_LIMIT;
  return { object_type: objectType, author, recipient, created_after: createdAfter, created_before: createdBefore, page_before: pageBefore, since, limit, order };
}

export function buildLocalQueryCriteria(parsedCriteria: FindQueryCriteria): FindQueryCriteria {
  return {
    object_type: parsedCriteria.object_type,
    author: parsedCriteria.author,
    ...(parsedCriteria.recipient === undefined ? {} : { recipient: parsedCriteria.recipient }),
    created_after: parsedCriteria.created_after,
    created_before: parsedCriteria.created_before,
    ...(parsedCriteria.page_before === undefined ? {} : { page_before: parsedCriteria.page_before }),
    since: parsedCriteria.since,
    limit: parsedCriteria.limit,
    order: parsedCriteria.order
  };
}

export async function buildForwardedFindPacket(
  parsedCriteria: FindQueryCriteria,
  requestId: string,
  sender: string,
  recipient: string,
  requestedObjectIds: string[],
  ttl: number,
  origin: string,
  expiresAt: string
): Promise<FindPacket> {
  return buildFindPacket(
    sender,
    recipient,
    requestedObjectIds,
    undefined,
    requestId,
    ttl,
    origin,
    expiresAt,
    buildLocalQueryCriteria(parsedCriteria)
  );
}

export async function findObjectsByFindQueryPage(
  store: ObjectStore,
  query: FindQueryCriteria
): Promise<{ objects: DistributedObject[]; hasMore: boolean }> {
  const objects = await store.query(query.recipient === undefined ? undefined : { recipient: query.recipient });
  return applyFindQueryPageLimit(filterObjectsMatchingFindQuery(objects, query), query);
}

export async function filterObjectsByFindQuery(
  store: ObjectStore,
  query: FindQueryCriteria
): Promise<DistributedObject[]> {
  const objects = await store.query(query.recipient === undefined ? undefined : { recipient: query.recipient });
  return applyFindQueryLimit(filterObjectsMatchingFindQuery(objects, query), query);
}

function filterObjectsMatchingFindQuery(
  objects: DistributedObject[],
  query: FindQueryCriteria
): DistributedObject[] {
  return objects.filter((object) => {
    if (isObjectExpired(object)) return false;
    if (query.object_type && object.object_type !== query.object_type) return false;
    if (query.author && object.author !== query.author) return false;
    if (query.recipient !== undefined && object.recipient !== query.recipient) return false;
    const createdAt = Date.parse(object.created_at);
    if (query.created_after && createdAt < Date.parse(query.created_after)) return false;
    if (query.created_before && createdAt > Date.parse(query.created_before)) return false;
    if (query.page_before) {
      const cursorCreatedAt = Date.parse(query.page_before.created_at);
      if (createdAt > cursorCreatedAt
        || (createdAt === cursorCreatedAt && object.object_id >= query.page_before.object_id)) return false;
    }
    if (query.since && createdAt <= Date.parse(query.since)) return false;
    return true;
  });
}

export function applyFindQueryPageLimit(
  objects: DistributedObject[],
  query: Pick<FindQueryCriteria, 'limit' | 'order'>
): { objects: DistributedObject[]; hasMore: boolean } {
  const ordered = query.order === 'created_at_desc'
    ? [...objects].sort(compareObjectsByCreatedAtDesc)
    : [...objects];
  if (query.limit === undefined) return { objects: ordered, hasMore: false };
  return {
    objects: ordered.slice(0, query.limit),
    hasMore: ordered.length > query.limit
  };
}

export async function prepareFindQueryResponse(
  objects: DistributedObject[],
  query: Pick<FindQueryCriteria, 'recipient' | 'created_after' | 'created_before' | 'page_before' | 'limit' | 'order'>
): Promise<DistributedObject[]> {
  return (await prepareFindQueryPage(objects, query)).objects;
}

export async function prepareFindQueryPage(
  objects: DistributedObject[],
  query: Pick<FindQueryCriteria, 'recipient' | 'created_after' | 'created_before' | 'page_before' | 'limit' | 'order'>
): Promise<{ objects: DistributedObject[]; hasMore: boolean }> {
  const matching: DistributedObject[] = [];
  for (const object of objects) {
    if (query.recipient !== undefined && object.recipient !== query.recipient) continue;
    const createdAt = Date.parse(object.created_at);
    if (query.created_after && createdAt < Date.parse(query.created_after)) continue;
    if (query.created_before && createdAt > Date.parse(query.created_before)) continue;
    if (query.page_before) {
      const cursorCreatedAt = Date.parse(query.page_before.created_at);
      if (createdAt > cursorCreatedAt
        || (createdAt === cursorCreatedAt && object.object_id >= query.page_before.object_id)) continue;
    }
    if (await validateDistributedObject(object)) matching.push(object);
  }
  return applyFindQueryPageLimit(matching, query);
}

export function applyFindQueryLimit(
  objects: DistributedObject[],
  query: Pick<FindQueryCriteria, 'limit' | 'order'>
): DistributedObject[] {
  const ordered = query.order === 'created_at_desc'
    ? [...objects].sort(compareObjectsByCreatedAtDesc)
    : [...objects];
  return query.limit === undefined ? ordered : ordered.slice(0, query.limit);
}

export async function validateFindResponseObjects(
  packet: unknown,
  expectedRequestId: string,
  requestedObjectIds: Set<string>
): Promise<DistributedObject[]> {
  if (!isMyceliumPacket(packet) || packet.type !== 'FIND_RESPONSE') return [];
  if (packet.payload?.requestId !== expectedRequestId) return [];
  const candidates = Array.isArray(packet.payload?.objects)
    ? packet.payload.objects
    : packet.payload?.object ? [packet.payload.object] : [];
  const valid = new Map<string, DistributedObject>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const object = candidate as DistributedObject;
    if ((requestedObjectIds.size > 0 && !requestedObjectIds.has(object.object_id)) || !(await validateObject(object))) continue;
    valid.set(object.object_id, object);
  }
  return [...valid.values()];
}

export class FindAggregation {
  private readonly requestedObjectIds: Set<string>;
  private readonly objects = new Map<string, DistributedObject>();
  private readonly children = new Map<string, 'pending' | 'responded' | 'failed'>();
  private readonly childrenWithoutPagination = new Set<string>();
  private moreResultsAvailable = false;
  private readonly deadlineMs: number;
  private readonly onComplete: (
    objects: DistributedObject[],
    reason: FindAggregationCompletionReason,
    hasMore: boolean
  ) => Promise<void>;
  private childFailure = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private completed = false;

  constructor(
    requestedObjectIds: string[],
    deadlineMs: number,
    onComplete: (
      objects: DistributedObject[],
      reason: FindAggregationCompletionReason,
      hasMore: boolean
    ) => Promise<void>,
    private readonly gracePeriodMs = FIND_GRACE_PERIOD_MS,
    private readonly acceptAnyObjects = false,
    private readonly requiresPaginationMetadata = false
  ) {
    this.requestedObjectIds = new Set(requestedObjectIds);
    this.deadlineMs = deadlineMs;
    this.onComplete = onComplete;
    this.deadlineTimer = setTimeout(() => { void this.complete('deadline-expired'); }, Math.max(0, deadlineMs - Date.now()));
  }

  async addLocal(objects: DistributedObject[], hasMore = false) {
    this.addObjects(objects);
    this.moreResultsAvailable ||= hasMore;
    await this.maybeComplete();
  }

  addChild(peerId: string) {
    if (!this.completed) this.children.set(peerId, 'pending');
  }

  startGracePeriod() {
    if (this.completed || this.graceTimer) return;
    this.graceTimer = setTimeout(() => { void this.complete(this.childFailure ? 'child-failure-grace-expired' : 'grace-expired'); }, Math.min(this.gracePeriodMs, Math.max(0, this.deadlineMs - Date.now())));
  }

  async addChildObjects(
    peerId: string,
    objects: DistributedObject[],
    complete = true,
    paginationSupported = true,
    hasMore = false
  ) {
    if (this.completed || this.children.get(peerId) !== 'pending') return;
    this.addObjects(objects);
    this.moreResultsAvailable ||= hasMore;
    if (this.requiresPaginationMetadata && !paginationSupported) {
      this.childrenWithoutPagination.add(peerId);
    }
    const childComplete = complete && (!this.requiresPaginationMetadata || paginationSupported);
    this.children.set(peerId, childComplete ? 'responded' : 'failed');
    if (!childComplete) this.childFailure = true;
    await this.maybeComplete();
  }

  async failChild(peerId: string) {
    if (this.completed || this.children.get(peerId) !== 'pending') return;
    this.childFailure = true;
    this.children.set(peerId, 'failed');
    await this.maybeComplete();
  }

  hasChild(peerId: string) {
    return this.children.has(peerId);
  }

  isComplete() {
    return this.completed;
  }

  aggregateSize() {
    return this.objects.size;
  }

  pendingChildren() {
    return [...this.children.entries()]
      .filter(([, state]) => state === 'pending')
      .map(([peerId]) => peerId);
  }

  allChildrenResponded() {
    return [...this.children.values()].every((state) => state === 'responded');
  }

  allChildrenSupportPagination() {
    return this.childrenWithoutPagination.size === 0
      && [...this.children.values()].every((state) => state === 'responded');
  }

  hasMore() {
    return this.moreResultsAvailable;
  }

  private addObjects(objects: DistributedObject[]) {
    for (const object of objects) {
      if (this.acceptAnyObjects || this.requestedObjectIds.has(object.object_id)) this.objects.set(object.object_id, object);
    }
  }

  private async maybeComplete() {
    if ((!this.acceptAnyObjects && this.objects.size === this.requestedObjectIds.size) || [...this.children.values()].every((state) => state !== 'pending')) {
      await this.complete(!this.acceptAnyObjects && this.objects.size === this.requestedObjectIds.size
        ? 'all-objects-found'
        : 'all-children-responded-or-failed');
    }
  }

  private async complete(reason: FindAggregationCompletionReason) {
    if (this.completed) return;
    console.debug(`PHASE6 AGG COMPLETE reason=${reason} aggregateSize=${this.objects.size} pendingChildren=${this.pendingChildren().join(',') || 'none'}`);
    this.completed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.graceTimer = null;
    this.deadlineTimer = null;
    try {
      await this.onComplete([...this.objects.values()], reason, this.moreResultsAvailable);
    } catch {
      console.warn('FIND aggregation completion callback failed');
    }
  }
}

export async function forwardFindRequestToChild(
  aggregation: FindAggregation,
  peerId: string,
  send: () => Promise<void>
): Promise<boolean> {
  try {
    await send();
    return true;
  } catch {
    await aggregation.failChild(peerId);
    return false;
  }
}

export async function sendFindPacketToConnectedPeer(
  transport: Pick<ObjectTransport, 'connectedPeers' | 'send'> | null,
  peerId: string,
  packet: ObjectPacket
): Promise<boolean> {
  if (!transport || !transport.connectedPeers().includes(peerId)) return false;
  try {
    await transport.send(peerId, packet);
    return true;
  } catch {
    return false;
  }
}

export async function respondToFindPacket(
  packet: unknown,
  store: ObjectStore,
  send: (packet: FindResponsePacket) => Promise<void>,
  sender: string,
  requestCache = new Map<string, number>(),
  forwardRequest?: (request: { objectId: string; objectIds?: string[]; localObjects?: DistributedObject[]; requestId: string; ttl: number; fromPeer: string; origin: string; expiresAt: string; query?: FindQueryCriteria }) => Promise<void>
): Promise<boolean> {
  if (!isMyceliumPacket(packet) || packet.type !== 'FIND') return false;
  const rawRecipient = packet.payload?.recipient;
  if (rawRecipient !== undefined && (typeof rawRecipient !== 'string' || rawRecipient.trim().length === 0)) return false;
  const objectIds = getFindObjectIds(packet as FindPacket);
  if (objectIds && objectIds.length > MAX_FIND_REQUEST_OBJECT_IDS) {
    console.warn(`Rejecting oversized FIND request: ${objectIds.length} object IDs exceeds ${MAX_FIND_REQUEST_OBJECT_IDS}`);
    return false;
  }
  const requestId = packet.payload?.requestId;
  const ttl = packet.payload?.ttl;
  const expiresAt = typeof packet.payload?.expiresAt === 'string' ? packet.payload.expiresAt : null;
  const origin = typeof packet.payload?.origin === 'string' ? packet.payload.origin : packet.sender;
  if (!objectIds || typeof requestId !== 'string' || !requestId
    || typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 0 || !expiresAt || Number.isNaN(Date.parse(expiresAt))) return false;
  const deadlineMs = Date.parse(expiresAt);
  const now = Date.now();
  if (now >= deadlineMs) return false;
  for (const [seenRequestId, expiresAtMs] of requestCache) {
    if (expiresAtMs <= now) requestCache.delete(seenRequestId);
  }
  if (requestCache.has(requestId)) return false;
  requestCache.set(requestId, deadlineMs);
  const queryCriteria = getFindQueryCriteria(packet as FindPacket);
  if (objectIds.length > 1 || queryCriteria) {
    let localObjects: DistributedObject[] = [];
    let localHasMore = false;
    if (queryCriteria) {
      const localPage = await findObjectsByFindQueryPage(store, queryCriteria);
      localHasMore = localPage.hasMore;
      for (const object of localPage.objects) {
        if (await validateObject(object)) localObjects.push(object);
      }
    } else {
      for (const requestedObjectId of objectIds) {
        const localObject = await store.get(requestedObjectId);
        if (localObject && await validateObject(localObject)) localObjects.push(localObject);
      }
    }
    if (ttl > 0 && forwardRequest) {
      try {
        await forwardRequest({
          objectId: objectIds[0] ?? localObjects[0]?.object_id ?? '',
          objectIds: queryCriteria ? localObjects.map((object) => object.object_id) : objectIds,
          localObjects,
          requestId,
          ttl: ttl - 1,
          fromPeer: packet.sender,
          origin,
          expiresAt,
          query: queryCriteria ?? undefined
        });
      } catch (error) {
        requestCache.delete(requestId);
        throw error;
      }
    } else {
      await send(await buildFindResponseObjectsPacket(
        sender,
        packet.sender,
        requestId,
        localObjects,
        undefined,
        origin,
        expiresAt,
        ttl === 0,
        queryCriteria?.order === 'created_at_desc' && queryCriteria.limit !== undefined
          ? true
          : undefined,
        queryCriteria ? localHasMore : undefined
      ));
    }
    return true;
  }
  const objectId = objectIds[0];
  const object = await store.get(objectId);
  if (object) {
    await send(await buildFindResponsePacket(sender, packet.sender, objectId, requestId, object, undefined, origin, expiresAt));
    return true;
  }

  if (ttl === 0) {
    await send(await buildFindResponsePacket(sender, packet.sender, objectId, requestId, undefined, undefined, origin, expiresAt, false));
    return true;
  }

  if (typeof forwardRequest === 'function') {
    try {
      await forwardRequest({ objectId, requestId, ttl: ttl - 1, fromPeer: packet.sender, origin, expiresAt, query: undefined });
      return true;
    } catch (error) {
      requestCache.delete(requestId);
      throw error;
    }
  }

  await send(await buildFindResponsePacket(sender, packet.sender, objectId, requestId, undefined, undefined, origin, expiresAt));
  return true;
}

export function findObject(
  sender: string,
  peerId: string,
  objectId: string,
  transport: ObjectTransport,
  store: ObjectStore,
  ttl = 2
): Promise<DistributedObject | null> {
  return resolveFindRequest(sender, peerId, objectId, ttl, transport, store);
}

// Target number of useful live replicas to aim for when an object's replication_policy omits an explicit budget.
export const DEFAULT_REPLICATION_BUDGET = 3;

export function getReplicationBudget(object: DistributedObject): number {
  const budget = object.replication_policy?.replication_budget;
  return typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 0 ? budget : DEFAULT_REPLICATION_BUDGET;
}

export interface ReplicationResult {
  readonly objectId: string;
  readonly budget: number;
  readonly targeted: readonly string[];
  readonly attempted: readonly string[];
  readonly skipped: readonly string[];
}

export interface ReplyDeliveryResult {
  readonly objectId: string;
  readonly authorPeerId: string;
  readonly reachable: boolean;
  readonly sent: boolean;
}

export async function sendReplyToAuthor(
  sender: string,
  replyObject: DistributedObject,
  transport: ObjectTransport,
  authorPeerId: string,
  signer?: PacketSigner
): Promise<ReplyDeliveryResult> {
  const result = {
    objectId: replyObject.object_id,
    authorPeerId,
    reachable: transport.connectedPeers().includes(authorPeerId),
    sent: false
  };
  if (!result.reachable) {
    console.debug(`REPLY author not connected - skipped object_id=${replyObject.object_id} peer=${authorPeerId}`);
    return result;
  }

  const packet = await buildObjectStorePacket(sender, authorPeerId, replyObject, signer);
  try {
    await transport.send(authorPeerId, packet);
  } catch {
    return result;
  }
  console.debug(`REPLY author connected - sent object_id=${replyObject.object_id} peer=${authorPeerId}`);
  return { ...result, sent: true };
}

/**
 * Pushes an object directly to up to `budget` additional connected peers so that roughly `budget` useful
 * replicas exist across the network. This is a target replica count, not a forwarding/hop counter: each
 * selected peer is sent the object exactly once via a direct OBJECT_STORE packet (no recursive relaying,
 * no TTL decrement). Bounding comes from `transport.connectedPeers()` being a finite local list and from
 * stopping once the budget is met, mirroring the existing fanout-style bounds used elsewhere in this file.
 */
export async function replicateObject(
  sender: string,
  object: DistributedObject,
  transport: ObjectTransport,
  signer?: PacketSigner,
  alreadyAttemptedTo: ReadonlySet<string> = new Set(),
  log: (message: string) => void = () => {}
): Promise<ReplicationResult> {
  const budget = getReplicationBudget(object);
  const hadExplicitBudget = typeof object.replication_policy?.replication_budget === 'number';
  log(`REPLICATION considering object_id=${object.object_id} budget=${budget}${hadExplicitBudget ? '' : ' (defaulted)'} priorAttempts=${alreadyAttemptedTo.size}`);

  const remaining = Math.max(0, budget - alreadyAttemptedTo.size);
  if (remaining === 0) {
    log(`REPLICATION send budget already used for object_id=${object.object_id}: priorAttempts=${alreadyAttemptedTo.size}/${budget}, stopping`);
    return { objectId: object.object_id, budget, targeted: [], attempted: [], skipped: [] };
  }

  const candidates = transport.connectedPeers().filter((peerId) => peerId !== sender);
  const targeted: string[] = [];
  const attempted: string[] = [];
  let acceptedTransportSends = 0;
  const skipped: string[] = [];

  for (const peerId of candidates) {
    if (acceptedTransportSends >= remaining) {
      log(`REPLICATION send budget reached for object_id=${object.object_id}: acceptedSends=${acceptedTransportSends} priorAttempts=${alreadyAttemptedTo.size} budget=${budget}, stopping`);
      break;
    }
    if (alreadyAttemptedTo.has(peerId)) {
      log(`REPLICATION duplicate skipped object_id=${object.object_id} peer=${peerId} already attempted in this operation`);
      skipped.push(peerId);
      continue;
    }
    targeted.push(peerId);
    attempted.push(peerId);
    log(`REPLICATION target selected object_id=${object.object_id} peer=${peerId}`);
    try {
      const packet = await buildObjectStorePacket(sender, peerId, object, signer);
      await transport.send(peerId, packet);
      acceptedTransportSends += 1;
      log(`REPLICATION transport accepted object_id=${object.object_id} peer=${peerId} (${acceptedTransportSends}/${remaining}); remote storage is unconfirmed`);
    } catch (error) {
      log(`REPLICATION failed to store object_id=${object.object_id} on peer=${peerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`REPLICATION complete object_id=${object.object_id} attempted=${attempted.length} acceptedTransportSends=${acceptedTransportSends} budget=${budget} candidatesConsidered=${targeted.length + skipped.length}`);
  return { objectId: object.object_id, budget, targeted, attempted, skipped };
}

export async function findObjects(
  sender: string,
  peerId: string,
  objectIds: string[],
  transport: ObjectTransport,
  store: ObjectStore,
  ttl = 1,
  gracePeriodMs = FIND_GRACE_PERIOD_MS
): Promise<DistributedObject[]> {
  const requestedObjectIds = [...new Set(objectIds)];
  if (requestedObjectIds.length > MAX_FIND_REQUEST_OBJECT_IDS) {
    console.warn(`Rejecting oversized FIND request in findObjects: ${requestedObjectIds.length} object IDs exceeds ${MAX_FIND_REQUEST_OBJECT_IDS}`);
    throw new Error('Invalid FIND object IDs');
  }
  if (requestedObjectIds.length === 0 || !requestedObjectIds.every((objectId) => /^[0-9a-f]{64}$/.test(objectId))) {
    throw new Error('Invalid FIND object IDs');
  }
  if (!Number.isSafeInteger(ttl) || ttl < 0) throw new Error('Invalid FIND TTL');
  const requestPacket = await buildFindPacket(sender, peerId, requestedObjectIds, undefined, undefined, ttl, sender);
  const deadlineMs = Date.parse(requestPacket.payload.expiresAt);
  const results = new Map<string, DistributedObject>();
  for (const objectId of requestedObjectIds) {
    const object = await store.get(objectId);
    if (object && await validateObject(object)) results.set(objectId, object);
  }
  if (results.size === requestedObjectIds.length) return [...results.values()];

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      unsubscribe();
      for (const object of results.values()) await store.put(object);
      resolve([...results.values()]);
    };
    const unsubscribe = transport.onPacket((responsePeerId, packet) => {
      if (settled || responsePeerId !== peerId || packet.type !== 'FIND_RESPONSE') return;
      void validateFindResponseObjects(packet, requestPacket.payload.requestId, new Set(requestedObjectIds)).then(async (objects) => {
        console.debug(`PHASE6 ORIGIN RESPONSE RX local=${sender} from=${responsePeerId} requestId=${requestPacket.payload.requestId} objects=${objects.length} objectIds=${objects.map((object) => object.object_id).join(',') || 'none'}`);
        for (const object of objects) results.set(object.object_id, object);
        if (results.size === requestedObjectIds.length || Date.now() >= deadlineMs) {
          console.debug(`PHASE6 ORIGIN COMPLETE local=${sender} requestId=${requestPacket.payload.requestId} results=${results.size} objectIds=${[...results.values()].map((object) => object.object_id).join(',') || 'none'}`);
          await finish();
        }
      }).catch(reject);
    });
    const graceTimer = setTimeout(() => { void finish(); }, Math.min(gracePeriodMs, Math.max(0, deadlineMs - Date.now())));
    const deadlineTimer = setTimeout(() => { void finish(); }, Math.max(0, deadlineMs - Date.now()));
    void transport.send(peerId, requestPacket).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      unsubscribe();
      reject(error);
    });
  });
}

async function resolveFindRequest(
  sender: string,
  peerId: string,
  objectId: string,
  ttl: number,
  transport: ObjectTransport,
  store: ObjectStore
): Promise<DistributedObject | null> {
  if (!Number.isSafeInteger(ttl) || ttl < 0) {
    throw new Error('Invalid FIND TTL');
  }
  const requestPacket = await buildFindPacket(sender, peerId, objectId, undefined, undefined, ttl, sender);
  const requestDeadlineMs = Date.parse(requestPacket.payload.expiresAt);
  const requestWithTtl = { ...requestPacket, payload: { ...requestPacket.payload, ttl } };
  return new Promise((resolve, reject) => {
    let settled = false;
    const unsubscribe = transport.onPacket((responsePeerId, packet) => {
      if (settled || responsePeerId !== peerId || packet.type !== 'FIND_RESPONSE'
        || packet.payload.requestId !== requestPacket.payload.requestId) return;
      const responseObjects = Array.isArray(packet.payload.objects)
        ? packet.payload.objects
        : packet.payload.object ? [packet.payload.object] : [];
      const object = responseObjects.find((candidate) => candidate?.object_id === objectId);
      if (!object) {
        if (packet.payload.object_id !== objectId) return;
        settled = true;
        clearTimeout(expirationTimer);
        unsubscribe();
        resolve(null);
        return;
      }
      if (Date.now() >= requestDeadlineMs) {
        settled = true;
        clearTimeout(expirationTimer);
        unsubscribe();
        resolve(null);
        return;
      }
      settled = true;
      clearTimeout(expirationTimer);
      unsubscribe();
      void validateObject(object).then(async (valid) => {
        if (!valid) {
          resolve(null);
          return;
        }
        await store.put(object);
        resolve(object);
      }).catch(reject);
    });
    const expirationTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(null);
    }, FIND_REQUEST_LIFETIME_MS);
    if (Date.now() >= requestDeadlineMs) {
      settled = true;
      unsubscribe();
      resolve(null);
      return;
    }
    void transport.send(peerId, requestWithTtl).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(expirationTimer);
      unsubscribe();
      reject(error);
    });
  });
}