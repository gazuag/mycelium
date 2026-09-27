import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPeerPool, fetchPopularPeers } from './peer-discovery';

afterEach(() => vi.unstubAllGlobals());

describe('peer discovery endpoints', () => {
  it('loads distinct peer IDs from the peer pool endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ peers: ['peer-a', 'peer-b', 4] }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPeerPool()).resolves.toEqual(['peer-a', 'peer-b']);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^https?:\/\/[^/]+\/api\/peer-pool$/));
  });

  it('loads popular reply targets with their reply counts', async () => {
    const popular = [{ peer_id: 'peer-a', reply_count: 7 }, { peer_id: 'peer-b', reply_count: 3 }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ peers: popular }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPopularPeers()).resolves.toEqual(popular);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^https?:\/\/[^/]+\/api\/popular-peers$/));
  });
});
