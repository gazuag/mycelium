import {
  isObjectExpired,
  isRecommendationObject,
  validateObject,
  type DistributedObject,
  type PostObject,
  type RecommendationObject
} from '../object-layer';
import { buildPacket, isMyceliumPacket } from '../p2p/protocol';

const MAX_BATCH_SIZE = 30;
const RESPONSE_TIMEOUT_MS = 15000;
const WEBSOCKET_OPEN = 1;
const DISCOVERY_PUBLISHABLE_OBJECT_TYPES = new Set(['mycelium.post', 'mycelium.recommendation']);

// Pending DISCOVERY_GET responses keyed by outgoing packet id.
const pendingDiscoveryRequests = new Map<string, (objects: DistributedObject[]) => void>();

export interface ValidatedDiscoveryObjects {
  readonly posts: PostObject[];
  readonly replies: PostObject[];
  readonly recommendations: RecommendationObject[];
  readonly invalidCount: number;
  readonly unsupportedCount: number;
}

export async function validateDiscoveryObjects(objects: readonly unknown[]): Promise<ValidatedDiscoveryObjects> {
  const posts: PostObject[] = [];
  const replies: PostObject[] = [];
  const recommendations: RecommendationObject[] = [];
  const seenObjectIds = new Set<string>();
  let invalidCount = 0;
  let unsupportedCount = 0;

  for (const value of objects) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalidCount += 1;
      continue;
    }
    const object = value as DistributedObject;
    if (object.object_type !== 'mycelium.post' && object.object_type !== 'mycelium.recommendation') {
      unsupportedCount += 1;
      continue;
    }
    if (!(await validateObject(object)) || isObjectExpired(object)) {
      invalidCount += 1;
      continue;
    }
    if (seenObjectIds.has(object.object_id)) continue;

    if (object.object_type === 'mycelium.recommendation') {
      if (!isRecommendationObject(object)) {
        invalidCount += 1;
        continue;
      }
      recommendations.push(object);
    } else {
      const payload = object.payload;
      const replyTo = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).reply_to
        : undefined;
      if (replyTo === undefined) {
        posts.push(object as PostObject);
      } else if (typeof replyTo === 'string' && /^[0-9a-f]{64}$/.test(replyTo)) {
        replies.push(object as PostObject);
      } else {
        invalidCount += 1;
        continue;
      }
    }
    seenObjectIds.add(object.object_id);
  }

  return { posts, replies, recommendations, invalidCount, unsupportedCount };
}

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
  if (!DISCOVERY_PUBLISHABLE_OBJECT_TYPES.has(object.object_type)) {
    throw new Error(`Discovery publish failed: unsupported object type '${object.object_type}'`);
  }
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
