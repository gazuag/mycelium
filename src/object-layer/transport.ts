import { buildPacket, createPacketId, isMyceliumPacket, type PacketSigner } from '../p2p/protocol';
import { validateObject } from './envelope';
import type { DistributedObject, FindPacket, FindResponsePacket, ObjectPacket, ObjectStore, ObjectStorePacket, ObjectTransport } from './types';

const FIND_REQUEST_LIFETIME_MS = 5000;
export const FIND_GRACE_PERIOD_MS = 250;
export type FindAggregationCompletionReason = 'all-objects-found' | 'all-children-responded-or-failed' | 'grace-expired' | 'child-failure-grace-expired' | 'deadline-expired';

export async function buildObjectStorePacket(
  sender: string,
  recipient: string,
  object: ObjectStorePacket['payload']['object'],
  signer?: PacketSigner
): Promise<ObjectPacket> {
  return await buildPacket(sender, recipient, 'OBJECT_STORE', { object }, signer) as ObjectStorePacket;
}

export async function buildFindPacket(
  sender: string,
  recipient: string,
  objectId: string | string[],
  signer?: PacketSigner,
  requestId = createPacketId(),
  ttl = 1,
  origin?: string,
  expiresAt = new Date(Date.now() + FIND_REQUEST_LIFETIME_MS).toISOString()
): Promise<FindPacket> {
  const requestedObjects = Array.isArray(objectId) ? objectId : [objectId];
  return await buildPacket(sender, recipient, 'FIND', {
    requested_objects: requestedObjects,
    object_id: requestedObjects[0],
    requestId,
    ttl,
    expiresAt,
    ...(origin ? { origin } : {})
  }, signer) as FindPacket;
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
    if (requested.length === 0 || requested.some((objectId) => typeof objectId !== 'string' || !/^[0-9a-f]{64}$/.test(objectId))) return null;
    return [...new Set(requested)];
  }
  const legacyObjectId = packet.payload?.object_id;
  return typeof legacyObjectId === 'string' && /^[0-9a-f]{64}$/.test(legacyObjectId) ? [legacyObjectId] : null;
}

export function selectFindPeers(connectedPeers: string[], incomingPeer: string, selfPeer: string, fanout = 2): string[] {
  return connectedPeers.filter((peerId) => peerId !== incomingPeer && peerId !== selfPeer).slice(0, fanout);
}

export async function receiveObjectPacket(packet: unknown, store: ObjectStore): Promise<boolean> {
  if (!isMyceliumPacket(packet) || packet.type !== 'OBJECT_STORE') return false;
  const object = packet.payload?.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  if (!(await validateObject(object))) return false;

  await store.put(object as DistributedObject);
  return true;
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
    if (!requestedObjectIds.has(object.object_id) || !(await validateObject(object))) continue;
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
    private readonly gracePeriodMs = FIND_GRACE_PERIOD_MS
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
      if (this.requestedObjectIds.has(object.object_id)) this.objects.set(object.object_id, object);
    }
  }

  private async maybeComplete() {
    if (this.objects.size === this.requestedObjectIds.size || [...this.children.values()].every((state) => state !== 'pending')) {
      await this.complete(this.objects.size === this.requestedObjectIds.size
        ? 'all-objects-found'
        : 'all-children-responded-or-failed');
    }
  }

  private async complete(reason: FindAggregationCompletionReason) {
    if (this.completed) return;
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
  forwardRequest?: (request: { objectId: string; objectIds?: string[]; localObjects?: DistributedObject[]; requestId: string; ttl: number; fromPeer: string; origin: string; expiresAt: string; }) => Promise<void>
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
  if (objectIds.length > 1) {
    const localObjects: DistributedObject[] = [];
    for (const requestedObjectId of objectIds) {
      const localObject = await store.get(requestedObjectId);
      if (localObject && await validateObject(localObject)) localObjects.push(localObject);
    }
    if (ttl > 0 && forwardRequest) {
      try {
        await forwardRequest({ objectId: objectIds[0], objectIds, localObjects, requestId, ttl: ttl - 1, fromPeer: packet.sender, origin, expiresAt });
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
      await forwardRequest({ objectId, requestId, ttl: ttl - 1, fromPeer: packet.sender, origin, expiresAt });
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
  ttl = 1
): Promise<DistributedObject | null> {
  return resolveFindRequest(sender, peerId, objectId, ttl, transport, store);
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
        for (const object of objects) results.set(object.object_id, object);
        if (results.size === requestedObjectIds.length || Date.now() >= deadlineMs) await finish();
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
        || packet.payload.object_id !== objectId || packet.payload.requestId !== requestPacket.payload.requestId) return;
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
      void receiveFindResponsePacket(packet, store, requestPacket.payload.requestId).then(resolve, reject);
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