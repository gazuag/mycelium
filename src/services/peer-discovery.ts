import { buildPacket, isMyceliumPacket } from '../p2p/protocol';
import type { IdentityObject } from '../object-layer/identity-object';

export interface PopularPeer {
  peer_id: string;
  activity_score: number;
  identity_profile?: unknown;
}

export interface PopularPeerWithIdentityProfile extends Omit<PopularPeer, 'identity_profile'> {
  identity_profile?: IdentityObject;
}

type PendingPeerDiscovery = {
  kind: 'peer-pool' | 'popular-peers';
  resolve: (value: string[] | PopularPeer[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingPeerDiscovery = new Map<string, PendingPeerDiscovery>();
const RESPONSE_TIMEOUT_MS = 15000;
const WEBSOCKET_OPEN = 1;

export function handlePeerDiscoveryResult(packet: unknown): boolean {
  if (!isMyceliumPacket(packet) || !['PEER_POOL_RESULT', 'POPULAR_PEERS_RESULT'].includes(packet.type)) return false;
  const requestId = typeof packet.payload?.requestId === 'string' ? packet.payload.requestId : null;
  if (!requestId) return false;
  const pending = pendingPeerDiscovery.get(requestId);
  if (!pending) return false;
  const expectedType = pending.kind === 'peer-pool' ? 'PEER_POOL_RESULT' : 'POPULAR_PEERS_RESULT';
  if (packet.type !== expectedType) return false;
  pendingPeerDiscovery.delete(requestId);
  clearTimeout(pending.timer);
  const peers = Array.isArray(packet.payload?.peers) ? packet.payload.peers : [];
  if (pending.kind === 'peer-pool') {
    pending.resolve(peers.filter((peer): peer is string => typeof peer === 'string'));
  } else {
    pending.resolve(peers.flatMap((peer) => {
      if (!peer || typeof peer !== 'object') return [];
      const value = peer as {
        peer_id?: unknown;
        activity_score?: unknown;
        reply_count?: unknown;
        identity_profile?: unknown;
      };
      const score = typeof value.activity_score === 'number' ? value.activity_score : value.reply_count;
      if (typeof value.peer_id !== 'string' || typeof score !== 'number') return [];
      return [{
        peer_id: value.peer_id,
        activity_score: score,
        ...(value.identity_profile && typeof value.identity_profile === 'object' && !Array.isArray(value.identity_profile)
          ? { identity_profile: value.identity_profile }
          : {})
      }];
    }));
  }
  return true;
}

function requestPeerDiscovery<T extends string[] | PopularPeer[]>(socket: WebSocket, kind: 'peer-pool' | 'popular-peers'): Promise<T> {
  if (socket.readyState !== WEBSOCKET_OPEN) return Promise.reject(new Error('Peer discovery request failed: WebSocket not open'));
  const isPool = kind === 'peer-pool';
  const requestType = isPool ? 'PEER_POOL_GET' : 'POPULAR_PEERS_GET';
  return new Promise<T>((resolve, reject) => {
    void buildPacket('discovery-client', 'discovery-server', requestType, {}).then((packet) => {
      const timer = setTimeout(() => {
        pendingPeerDiscovery.delete(packet.id);
        reject(new Error(`Peer discovery request failed: ${kind} timeout`));
      }, RESPONSE_TIMEOUT_MS);
      pendingPeerDiscovery.set(packet.id, { kind, resolve: resolve as (value: string[] | PopularPeer[]) => void, reject, timer });
      try {
        socket.send(JSON.stringify(packet));
      } catch (error) {
        clearTimeout(timer);
        pendingPeerDiscovery.delete(packet.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

export function fetchPeerPool(socket: WebSocket): Promise<string[]> {
  return requestPeerDiscovery<string[]>(socket, 'peer-pool');
}

export function fetchPopularPeers(socket: WebSocket): Promise<PopularPeer[]> {
  return requestPeerDiscovery<PopularPeer[]>(socket, 'popular-peers');
}
