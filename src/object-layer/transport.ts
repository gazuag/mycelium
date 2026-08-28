import { buildPacket, createPacketId, isMyceliumPacket, type PacketSigner } from '../p2p/protocol';
import { validateObject } from './envelope';
import type { DistributedObject, FindPacket, FindResponsePacket, ObjectPacket, ObjectStore, ObjectStorePacket, ObjectTransport } from './types';

const FIND_REQUEST_LIFETIME_MS = 5000;

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
  objectId: string,
  signer?: PacketSigner,
  requestId = createPacketId(),
  ttl = 1,
  origin?: string,
  expiresAt = new Date(Date.now() + FIND_REQUEST_LIFETIME_MS).toISOString()
): Promise<FindPacket> {
  return await buildPacket(sender, recipient, 'FIND', {
    object_id: objectId,
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
    object_id: objectId,
    requestId,
    ...(expiresAt ? { expiresAt } : {}),
    ...(origin ? { origin } : {}),
    ...(object ? { object } : {})
  }, signer) as FindResponsePacket;
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

export async function respondToFindPacket(
  packet: unknown,
  store: ObjectStore,
  send: (packet: FindResponsePacket) => Promise<void>,
  sender: string,
  requestCache = new Map<string, number>(),
  forwardRequest?: (request: { objectId: string; requestId: string; ttl: number; fromPeer: string; origin: string; expiresAt: string; }) => Promise<void>
): Promise<boolean> {
  if (!isMyceliumPacket(packet) || packet.type !== 'FIND') return false;
  const objectId = packet.payload?.object_id;
  const requestId = packet.payload?.requestId;
  const ttl = packet.payload?.ttl;
  const expiresAt = typeof packet.payload?.expiresAt === 'string' ? packet.payload.expiresAt : null;
  const origin = typeof packet.payload?.origin === 'string' ? packet.payload.origin : packet.sender;
  if (typeof objectId !== 'string' || !/^[0-9a-f]{64}$/.test(objectId) || typeof requestId !== 'string' || !requestId
    || typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 0 || !expiresAt || Number.isNaN(Date.parse(expiresAt))) return false;
  const deadlineMs = Date.parse(expiresAt);
  const now = Date.now();
  if (now >= deadlineMs) return false;
  for (const [seenRequestId, expiresAtMs] of requestCache) {
    if (expiresAtMs <= now) requestCache.delete(seenRequestId);
  }
  if (requestCache.has(requestId)) return false;
  requestCache.set(requestId, deadlineMs);
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