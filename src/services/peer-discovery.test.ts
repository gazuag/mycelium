import { describe, expect, it, vi } from 'vitest';
import { buildPacket } from '../p2p/protocol';
import { fetchPeerPool, fetchPopularPeers, handlePeerDiscoveryResult } from './peer-discovery';

function fakeSocket() {
  return {
    readyState: 1,
    send: vi.fn()
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

async function sentRequest(socket: ReturnType<typeof fakeSocket>) {
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
  return JSON.parse(socket.send.mock.calls[0][0]) as { id: string; sender: string; type: string };
}

describe('peer discovery WebSocket packets', () => {
  it('loads distinct peer IDs from a correlated peer-pool response', async () => {
    const socket = fakeSocket();
    const result = fetchPeerPool(socket);
    const request = await sentRequest(socket);
    expect(request.type).toBe('PEER_POOL_GET');

    const response = await buildPacket('discovery-server', request.sender, 'PEER_POOL_RESULT', {
      requestId: request.id,
      peers: ['peer-a', 'peer-b', 4]
    });
    expect(handlePeerDiscoveryResult(response)).toBe(true);
    await expect(result).resolves.toEqual(['peer-a', 'peer-b']);
  });

  it('loads popular reply targets and counts from a correlated response', async () => {
    const socket = fakeSocket();
    const result = fetchPopularPeers(socket);
    const request = await sentRequest(socket);
    expect(request.type).toBe('POPULAR_PEERS_GET');

    const popular = [{ peer_id: 'peer-a', reply_count: 7 }, { peer_id: 'peer-b', reply_count: 3 }];
    const response = await buildPacket('discovery-server', request.sender, 'POPULAR_PEERS_RESULT', {
      requestId: request.id,
      peers: popular
    });
    expect(handlePeerDiscoveryResult(response)).toBe(true);
    await expect(result).resolves.toEqual(popular);
  });
});
