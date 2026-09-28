import { describe, expect, it, vi } from 'vitest';
import { fetchMeteredIceServers } from './metered-turn';

describe('Metered TURN credential loading', () => {
  it('loads and validates Metered ICE server entries', async () => {
    const iceServers = [
      { urls: 'stun:turn.example:80' },
      { urls: ['turn:turn.example:80', 'turns:turn.example:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-secret' }
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => iceServers });

    await expect(fetchMeteredIceServers('myceliumnet.metered.live', 'credential-api-key', fetchMock))
      .resolves.toEqual(iceServers);
    const [requestUrl] = fetchMock.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(url.origin).toBe('https://myceliumnet.metered.live');
    expect(url.pathname).toBe('/api/v1/turn/credentials');
    expect(url.searchParams.get('apiKey')).toBe('credential-api-key');
  });

  it('rejects incomplete API configuration and unusable responses', async () => {
    await expect(fetchMeteredIceServers('', 'api-key', vi.fn())).rejects.toThrow('not configured');
    const noTurnCredentials = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ urls: 'stun:only.example' }] });
    await expect(fetchMeteredIceServers('app.metered.live', 'api-key', noTurnCredentials))
      .rejects.toThrow('no usable TURN server credentials');
  });
});
