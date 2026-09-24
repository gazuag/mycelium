import { buildPacket, createPacketId, isMyceliumPacket, type PacketSigner } from '../p2p/protocol';
import { validateObject } from './envelope';
import type { DistributedObject, FindPacket, FindQueryCriteria, FindResponsePacket, ObjectBatchPacket, ObjectPacket, ObjectStore, ObjectStorePacket, ObjectTransport } from './types';

const FIND_REQUEST_LIFETIME_MS = 5000;
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
  signer?: PacketSigner
): Promise<ObjectBatchPacket> {
  return await buildPacket(sender, recipient, 'OBJECT_BATCH', { objects }, signer) as ObjectBatchPacket;
}

export async function queryFeedObjectsForPeer(
  store: ObjectStore,
  author: string,
  options: { since?: string | null; limit?: number } = {}
): Promise<DistributedObject[]> {
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0 ? options.limit : undefined;
  const query = {
    since: options.since ?? undefined,
    order: 'created_at_desc' as const
  };
  const recommendations = await filterObjectsByFindQuery(store, { ...query, object_type: 'mycelium.recommendation', author, limit });
  const recommendedPostIds = new Set(recommendations.flatMap((recommendation) => {
    const payload = recommendation.payload;
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && typeof payload.post_id === 'string'
      ? [payload.post_id]
      : [];
  }));
  const posts = (await filterObjectsByFindQuery(store, { ...query, object_type: 'mycelium.post' }))
    .filter((post) => post.author === author || recommendedPostIds.has(post.object_id))
    .slice(0, limit);
  return [...posts, ...recommendations].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
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
  return await buildPacket(sender, recipient, 'FIND', {
    requested_objects: requestedObjects,
    object_id: requestedObjects[0] ?? '',
    requestId,
    ttl,
    expiresAt,
    ...(origin ? { origin } : {}),
    ...(query?.object_type ? { object_type: query.object_type } : {}),
    ...(query?.author ? { author: query.author } : {}),
    ...(query?.created_after ? { created_after: query.created_after } : {}),
    ...(query?.created_before ? { created_before: query.created_before } : {}),
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
  objectIds: string[] = []
): Promise<FindPacket> {
  return buildFindPacket(sender, recipient, objectIds, signer, requestId, ttl, origin, expiresAt, {
    author,
    created_after: createdAfter,
    created_before: createdBefore
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
  expiresAt?: string
): Promise<FindResponsePacket> {
  return await buildPacket(sender, recipient, 'FIND_RESPONSE', {
    objects: object ? [object] : [],
    object_id: objectId,
    requestId,
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
  expiresAt?: string
): Promise<FindResponsePacket> {
  return await buildPacket(sender, recipient, 'FIND_RESPONSE', {
    objects,
    object_id: objects[0]?.object_id ?? '',
    requestId,
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

export async function receiveObjectPacket(packet: unknown, store: ObjectStore): Promise<boolean> {
  if (!isMyceliumPacket(packet) || packet.type !== 'OBJECT_STORE') return false;
  const object = packet.payload?.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  if (!(await validateObject(object))) return false;

  await store.put(object as DistributedObject);
  return true;
}

export async function receiveObjectBatchPacket(packet: unknown, store: ObjectStore): Promise<DistributedObject[]> {
  if (!isMyceliumPacket(packet) || packet.type !== 'OBJECT_BATCH') return [];
  const objects = packet.payload?.objects;
  if (!Array.isArray(objects)) return [];
  const validObjects: DistributedObject[] = [];
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object) || !(await validateObject(object))) continue;
    await store.put(object as DistributedObject);
    validObjects.push(object as DistributedObject);
  }
  return validObjects;
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
  const createdAfter = typeof packet.payload?.created_after === 'string' ? packet.payload.created_after : undefined;
  const createdBefore = typeof packet.payload?.created_before === 'string' ? packet.payload.created_before : undefined;
  const since = typeof packet.payload?.since === 'string' ? packet.payload.since : undefined;
  const limit = typeof packet.payload?.limit === 'number' && Number.isSafeInteger(packet.payload.limit) && packet.payload.limit > 0
    ? packet.payload.limit
    : undefined;
  const order = packet.payload?.order === 'created_at_desc' ? packet.payload.order : undefined;
  const hasQuery = Boolean(objectType || author || createdAfter || createdBefore || since || limit !== undefined || order);
  if (!hasQuery) return null;
  return { object_type: objectType, author, created_after: createdAfter, created_before: createdBefore, since, limit, order };
}

export async function filterObjectsByFindQuery(store: ObjectStore, query: FindQueryCriteria): Promise<DistributedObject[]> {
  const objects = await store.query();
  const filtered = objects.filter((object) => {
    if (query.object_type && object.object_type !== query.object_type) return false;
    if (query.author && object.author !== query.author) return false;
    if (query.created_after && new Date(object.created_at).getTime() < new Date(query.created_after).getTime()) return false;
    if (query.created_before && new Date(object.created_at).getTime() > new Date(query.created_before).getTime()) return false;
    if (query.since && new Date(object.created_at).getTime() <= new Date(query.since).getTime()) return false;
    return true;
  });
  if (query.order === 'created_at_desc') {
    filtered.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  }
  return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
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
  private readonly deadlineMs: number;
  private readonly onComplete: (objects: DistributedObject[], reason: FindAggregationCompletionReason) => Promise<void>;
  private childFailure = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private completed = false;

  constructor(
    requestedObjectIds: string[],
    deadlineMs: number,
    onComplete: (objects: DistributedObject[], reason: FindAggregationCompletionReason) => Promise<void>,
    private readonly gracePeriodMs = FIND_GRACE_PERIOD_MS,
    private readonly acceptAnyObjects = false
  ) {
    this.requestedObjectIds = new Set(requestedObjectIds);
    this.deadlineMs = deadlineMs;
    this.onComplete = onComplete;
    this.deadlineTimer = setTimeout(() => { void this.complete('deadline-expired'); }, Math.max(0, deadlineMs - Date.now()));
  }

  async addLocal(objects: DistributedObject[]) {
    this.addObjects(objects);
    await this.maybeComplete();
  }

  addChild(peerId: string) {
    if (!this.completed) this.children.set(peerId, 'pending');
  }

  startGracePeriod() {
    if (this.completed || this.graceTimer) return;
    this.graceTimer = setTimeout(() => { void this.complete(this.childFailure ? 'child-failure-grace-expired' : 'grace-expired'); }, Math.min(this.gracePeriodMs, Math.max(0, this.deadlineMs - Date.now())));
  }

  async addChildObjects(peerId: string, objects: DistributedObject[]) {
    if (this.completed || this.children.get(peerId) !== 'pending') return;
    this.addObjects(objects);
    this.children.set(peerId, 'responded');
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

  private addObjects(objects: DistributedObject[]) {
    for (const object of objects) {
      if (this.acceptAnyObjects || this.requestedObjectIds.has(object.object_id)) this.objects.set(object.object_id, object);
    }
  }

  private async maybeComplete() {
    if ((!this.acceptAnyObjects && this.objects.size === this.requestedObjectIds.size) || (this.children.size > 0 && [...this.children.values()].every((state) => state !== 'pending'))) {
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
    await this.onComplete([...this.objects.values()], reason);
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
  const objectIds = getFindObjectIds(packet as FindPacket);
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
    const localObjects: DistributedObject[] = [];
    if (queryCriteria) {
      const matchedObjects = await filterObjectsByFindQuery(store, queryCriteria);
      for (const object of matchedObjects) {
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
      await send(await buildFindResponseObjectsPacket(sender, packet.sender, requestId, localObjects, undefined, origin, expiresAt));
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
    await send(await buildFindResponsePacket(sender, packet.sender, objectId, requestId, undefined, undefined, origin, expiresAt));
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
  readonly stored: readonly string[];
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
  await transport.send(authorPeerId, packet);
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
  alreadyReplicatedTo: ReadonlySet<string> = new Set(),
  log: (message: string) => void = () => {}
): Promise<ReplicationResult> {
  const budget = getReplicationBudget(object);
  const hadExplicitBudget = typeof object.replication_policy?.replication_budget === 'number';
  log(`REPLICATION considering object_id=${object.object_id} budget=${budget}${hadExplicitBudget ? '' : ' (defaulted)'} existingReplicas=${alreadyReplicatedTo.size}`);

  const remaining = Math.max(0, budget - alreadyReplicatedTo.size);
  if (remaining === 0) {
    log(`REPLICATION target already satisfied for object_id=${object.object_id}: existingReplicas=${alreadyReplicatedTo.size}/${budget}, stopping`);
    return { objectId: object.object_id, budget, targeted: [], stored: [], skipped: [] };
  }

  const candidates = transport.connectedPeers().filter((peerId) => peerId !== sender);
  const targeted: string[] = [];
  const stored: string[] = [];
  const skipped: string[] = [];

  for (const peerId of candidates) {
    if (stored.length >= remaining) {
      log(`REPLICATION budget reached for object_id=${object.object_id}: newReplicas=${stored.length} existingReplicas=${alreadyReplicatedTo.size} budget=${budget}, stopping`);
      break;
    }
    if (alreadyReplicatedTo.has(peerId)) {
      log(`REPLICATION duplicate skipped object_id=${object.object_id} peer=${peerId} already holds a replica`);
      skipped.push(peerId);
      continue;
    }
    targeted.push(peerId);
    log(`REPLICATION target selected object_id=${object.object_id} peer=${peerId}`);
    try {
      const packet = await buildObjectStorePacket(sender, peerId, object, signer);
      await transport.send(peerId, packet);
      stored.push(peerId);
      log(`REPLICATION stored object_id=${object.object_id} on peer=${peerId} (${alreadyReplicatedTo.size + stored.length}/${budget})`);
    } catch (error) {
      log(`REPLICATION failed to store object_id=${object.object_id} on peer=${peerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`REPLICATION complete object_id=${object.object_id} newReplicas=${stored.length} totalKnownReplicas=${alreadyReplicatedTo.size + stored.length} budget=${budget} candidatesConsidered=${targeted.length + skipped.length}`);
  return { objectId: object.object_id, budget, targeted, stored, skipped };
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