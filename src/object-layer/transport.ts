import { buildPacket, isMyceliumPacket, type PacketSigner } from '../p2p/protocol';
import { validateObject } from './envelope';
import type { DistributedObject, FindPacket, FindResponsePacket, ObjectPacket, ObjectStore, ObjectStorePacket, ObjectTransport } from './types';

export async function buildObjectStorePacket(
  sender: string,
  recipient: string,
  object: ObjectStorePacket['payload']['object'],
  signer?: PacketSigner
): Promise<ObjectPacket> {
  return await buildPacket(sender, recipient, 'OBJECT_STORE', { object }, signer) as ObjectStorePacket;
}

export async function buildFindPacket(sender: string, recipient: string, objectId: string, signer?: PacketSigner): Promise<FindPacket> {
  return await buildPacket(sender, recipient, 'FIND', { object_id: objectId }, signer) as FindPacket;
}

export async function buildFindResponsePacket(sender: string, recipient: string, objectId: string, object?: DistributedObject, signer?: PacketSigner): Promise<FindResponsePacket> {
  return await buildPacket(sender, recipient, 'FIND_RESPONSE', { object_id: objectId, ...(object ? { object } : {}) }, signer) as FindResponsePacket;
}

export async function receiveObjectPacket(packet: unknown, store: ObjectStore): Promise<boolean> {
  if (!isMyceliumPacket(packet) || packet.type !== 'OBJECT_STORE') return false;
  const object = packet.payload?.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  if (!(await validateObject(object))) return false;

  await store.put(object as DistributedObject);
  return true;
}

export async function receiveFindResponsePacket(packet: unknown, store: ObjectStore): Promise<DistributedObject | null> {
  if (!isMyceliumPacket(packet) || packet.type !== 'FIND_RESPONSE') return null;
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
  sender: string
): Promise<boolean> {
  if (!isMyceliumPacket(packet) || packet.type !== 'FIND') return false;
  const objectId = packet.payload?.object_id;
  if (typeof objectId !== 'string' || !/^[0-9a-f]{64}$/.test(objectId)) return false;
  const object = await store.get(objectId);
  await send(await buildFindResponsePacket(sender, packet.sender, objectId, object ?? undefined));
  return true;
}

export function findObject(
  sender: string,
  peerId: string,
  objectId: string,
  transport: ObjectTransport,
  store: ObjectStore
): Promise<DistributedObject | null> {
  return new Promise(async (resolve, reject) => {
    const unsubscribe = transport.onPacket((sender, packet) => {
      if (sender !== peerId || packet.type !== 'FIND_RESPONSE' || packet.payload.object_id !== objectId) return;
      unsubscribe();
      void receiveFindResponsePacket(packet, store).then(resolve, reject);
    });
    try {
      await transport.send(peerId, await buildFindPacket(sender, peerId, objectId));
    } catch (error) {
      unsubscribe();
      reject(error);
    }
  });
}