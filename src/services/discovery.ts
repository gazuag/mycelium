import type { DistributedObject } from '../object-layer';
import { buildPacket, isMyceliumPacket } from '../p2p/protocol';

const MAX_BATCH_SIZE = 30;
const RESPONSE_TIMEOUT_MS = 15000;
const WEBSOCKET_OPEN = 1;

// Pending DISCOVERY_GET responses keyed by outgoing packet id.
const pendingDiscoveryRequests = new Map<string, (objects: DistributedObject[]) => void>();

/**
 * Called by the signalling message handler whenever a DISCOVERY_RESULT packet
 * arrives over the WebSocket. Resolves the matching pending fetchDiscovery promise.
 */
export function handleDiscoveryResult(packet: unknown): boolean {
  if (!isMyceliumPacket(packet) || packet.type !== 'DISCOVERY_RESULT') return false;
  const requestId = typeof packet.payload?.requestId === 'string' ? packet.payload.requestId : null;
  if (requestId && pendingDiscoveryRequests.has(requestId)) {
    const resolve = pendingDiscoveryRequests.get(requestId)!;
    pendingDiscoveryRequests.delete(requestId);
    const objects = Array.isArray(packet.payload?.objects) ? packet.payload.objects as DistributedObject[] : [];
    resolve(objects);
    return true;
  }
  return false;
}

export async function publishObject(object: DistributedObject, socket: WebSocket) {
  if (socket.readyState !== WEBSOCKET_OPEN) {
    throw new Error('Discovery publish failed: WebSocket not open');
  }
  const packet = await buildPacket(object.author, 'discovery-server', 'DISCOVERY_PUBLISH', { object });
  socket.send(JSON.stringify(packet));
}

export async function fetchDiscovery(socket: WebSocket, limit = 20, tag?: string): Promise<DistributedObject[]> {
  if (socket.readyState !== WEBSOCKET_OPEN) {
    throw new Error('Discovery fetch failed: WebSocket not open');
  }
  const sanitizedLimit = Math.min(limit, MAX_BATCH_SIZE);
  const packet = await buildPacket('discovery-client', 'discovery-server', 'DISCOVERY_GET', {
    limit: sanitizedLimit,
    tag: tag ?? null
  });

  return new Promise<DistributedObject[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDiscoveryRequests.delete(packet.id);
      reject(new Error('Discovery fetch failed: timeout'));
    }, RESPONSE_TIMEOUT_MS);

    pendingDiscoveryRequests.set(packet.id, (posts) => {
      clearTimeout(timer);
      resolve(posts);
    });

    socket.send(JSON.stringify(packet));
  });
}
