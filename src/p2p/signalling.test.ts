import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSignalServerUrl } from './signalling';

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