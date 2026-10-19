import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  it('separates settings from diagnostics and keeps Add Peer in the Settings panel', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        identityId="my-peer-id"
        publicKey="my-public-key"
        onResetApp={vi.fn()}
        onAddPeerAddress={vi.fn(async () => true)}
        logs={[]}
        onClearLogs={vi.fn()}
        signalEndpoint="wss://signal.example"
        discoveryEndpoint="https://discovery.example"
        connectionStatus="connected"
        signallingStatus="connected"
        connectedPeers={1}
        syncStatus="synced"
        recommendationFrequency={2}
        discoveryFrequency={6}
        onInjectionFrequencyChange={vi.fn()}
      />
    );

    expect(markup).toContain('<h3>Settings</h3>');
    expect(markup).toContain('<h3>Diagnostics</h3>');
    expect(markup).toContain('Copy fingerprint');
    expect(markup).toContain('my-peer-id');
    expect(markup).toContain('Follow peer by address');
    expect(markup).toContain('aria-label="Peer address"');
    expect(markup).toContain('>Follow peer</button>');
    expect(markup).toContain('Recommendations frequency');
    expect(markup).toContain('Discovery frequency');
    expect(markup).toContain('aria-label="Recommendations frequency"');
    expect(markup).toContain('aria-label="Discovery frequency"');
    expect(markup).toContain('value="2"');
    expect(markup).toContain('value="6"');
    expect(markup).toContain('Set to 0 to disable recommendation injections.');
    expect(markup).toContain('Set to 0 to disable Discovery injections.');
    expect(markup.match(/type="number" min="0" step="1"/g)).toHaveLength(2);

    const settingsPanelEnd = markup.indexOf('</div><div class="card">', markup.indexOf('<h3>Settings</h3>'));
    expect(settingsPanelEnd).toBeGreaterThan(markup.indexOf('<h3>Settings</h3>'));
    expect(markup.indexOf('Recommendations frequency')).toBeLessThan(settingsPanelEnd);
    expect(markup.indexOf('Follow peer by address')).toBeLessThan(settingsPanelEnd);
    expect(markup.indexOf('<h3>Diagnostics</h3>')).toBeGreaterThan(settingsPanelEnd);
    expect(markup.indexOf('Fingerprint')).toBeGreaterThan(markup.indexOf('<h3>Diagnostics</h3>'));
  });
});
