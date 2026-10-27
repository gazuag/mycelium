import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestOnlinePeerList, resolveOnlinePeerList, resolveSignalServerUrl } from './signalling';

const DEFAULT_SIGNAL_URL = 'wss://discover.unfilter.ing:8443';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('signalling URL security', () => {
  it('rejects remote ws URLs with a warning and falls back to WSS', () => {
    vi.stubGlobal('VITE_SIGNAL_SERVER_URL', 'ws://signal.example:8080');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveSignalServerUrl()).toBe(DEFAULT_SIGNAL_URL);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('loopback hosts'));
  });

  it('allows ws URLs only for loopback hosts', () => {
    for (const url of ['ws://localhost:8080/signal', 'ws://127.0.0.1:8080/signal', 'ws://[::1]:8080/signal']) {
      vi.stubGlobal('VITE_SIGNAL_SERVER_URL', url);
      expect(resolveSignalServerUrl()).toBe(url);
    }
  });

  it('allows wss URLs for remote hosts', () => {
    const url = 'wss://signal.example:8443/signal';
    vi.stubGlobal('VITE_SIGNAL_SERVER_URL', url);

    expect(resolveSignalServerUrl()).toBe(url);
  });
});

describe('online peer-list signalling', () => {
  it('correlates a live peer-list response to its request', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const sentMessages: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: 1,
      send: (message: string) => sentMessages.push(JSON.parse(message))
    } as unknown as WebSocket;

    const response = requestOnlinePeerList(socket, 'local-peer');
    const requestId = sentMessages[0].requestId;

    expect(sentMessages[0]).toMatchObject({
      type: 'peer-list-request',
      id: 'local-peer'
    });
    expect(resolveOnlinePeerList({
      type: 'peer-list',
      peers: ['online-peer'],
      requestId: String(requestId)
    })).toBe(true);
    await expect(response).resolves.toEqual(['online-peer']);
    expect(resolveOnlinePeerList({
      type: 'peer-list',
      peers: [],
      requestId: String(requestId)
    })).toBe(false);
  });

  it('rejects a request when the signalling socket is not open', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const socket = { readyState: 0 } as WebSocket;

    await expect(requestOnlinePeerList(socket, 'local-peer'))
      .rejects.toThrow('WebSocket not open');
  });
});