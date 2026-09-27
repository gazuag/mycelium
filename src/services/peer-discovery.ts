import { resolveSignalServerUrl } from '../p2p/signalling';

export interface PopularPeer {
  peer_id: string;
  reply_count: number;
}

function endpointUrl(path: string, signalUrl = resolveSignalServerUrl()): string {
  const url = new URL(signalUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(endpointUrl(path));
  if (!response.ok) throw new Error(`Peer discovery request failed: HTTP ${response.status}`);
  return response.json();
}

export async function fetchPeerPool(): Promise<string[]> {
  const result = await fetchJson('/api/peer-pool') as { peers?: unknown };
  return Array.isArray(result.peers) ? result.peers.filter((peer): peer is string => typeof peer === 'string') : [];
}

export async function fetchPopularPeers(): Promise<PopularPeer[]> {
  const result = await fetchJson('/api/popular-peers') as { peers?: unknown };
  if (!Array.isArray(result.peers)) return [];
  return result.peers.flatMap((peer) => {
    if (!peer || typeof peer !== 'object') return [];
    const value = peer as { peer_id?: unknown; reply_count?: unknown };
    return typeof value.peer_id === 'string' && typeof value.reply_count === 'number'
      ? [{ peer_id: value.peer_id, reply_count: value.reply_count }]
      : [];
  });
}
