import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  it('keeps Add Peer available under Advanced settings', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        identityId="my-peer-id"
        publicKey="my-public-key"
        onResetApp={vi.fn()}
        onAddPeerAddress={vi.fn(async () => {})}
        logs={[]}
        onClearLogs={vi.fn()}
        signalEndpoint="wss://signal.example"
        discoveryEndpoint="https://discovery.example"
        connectionStatus="connected"
        signallingStatus="connected"
        connectedPeers={1}
        syncStatus="synced"
      />
    );

    expect(markup).toContain('<h3>Advanced</h3>');
    expect(markup).toContain('Add Peer by Address');
    expect(markup).toContain('aria-label="Peer address"');
    expect(markup).toContain('Add peer');
  });
});
