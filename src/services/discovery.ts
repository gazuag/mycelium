import type { SignedPost } from '../types';
import { buildPacket, isMyceliumPacket } from '../p2p/protocol';

const MAX_BATCH_SIZE = 30;
const RESPONSE_TIMEOUT_MS = 15000;

// Pending DISCOVERY_GET responses keyed by outgoing packet id.
const pendingDiscoveryRequests = new Map<string, (posts: SignedPost[]) => void>();

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
    const posts = Array.isArray(packet.payload?.posts) ? (packet.payload.posts as SignedPost[]) : [];
    resolve(posts);
    return true;
  }
  return false;
}

export async function publishPost(post: SignedPost, socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('Discovery publish failed: WebSocket not open');
  }
  const packet = await buildPacket(post.author, 'discovery-server', 'DISCOVERY_PUBLISH', { post });
  socket.send(JSON.stringify(packet));
}

export async function fetchDiscovery(socket: WebSocket, limit = 20, tag?: string): Promise<SignedPost[]> {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('Discovery fetch failed: WebSocket not open');
  }
  const sanitizedLimit = Math.min(limit, MAX_BATCH_SIZE);
  const packet = await buildPacket('discovery-client', 'discovery-server', 'DISCOVERY_GET', {
    limit: sanitizedLimit,
    tag: tag ?? null
  });

  return new Promise<SignedPost[]>((resolve, reject) => {
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
