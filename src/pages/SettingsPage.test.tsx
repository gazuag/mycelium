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
        onSaveInjectionFrequencies={vi.fn()}
        objectStorageLimitMb={500}
        objectStorageUsedBytes={12_345_678}
        onSaveObjectStorageLimit={vi.fn(() => true)}
        externalImageLimitMb={5}
        onSaveExternalImageLimit={vi.fn(() => true)}
        onExportIdentity={vi.fn()}
        onImportIdentity={vi.fn()}
        onCreateIdentity={vi.fn()}
        onClearIdentity={vi.fn()}
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
    expect(markup).toContain('aria-label="Decrease Recommendations frequency"');
    expect(markup).toContain('aria-label="Increase Recommendations frequency"');
    expect(markup).toContain('aria-label="Decrease Discovery frequency"');
    expect(markup).toContain('aria-label="Increase Discovery frequency"');
    expect(markup).toContain('>Save Settings</button>');
    expect(markup).toContain('<h3>Object storage</h3>');
    expect(markup).toContain('aria-label="Maximum object storage (MB)"');
    expect(markup).toContain('value="500"');
    expect(markup).toContain('type="number" min="100" max=');
    expect(markup).toContain('>Save Storage Limit</button>');
    expect(markup).toContain('<h3>External images</h3>');
    expect(markup).toContain('aria-label="Maximum known external image size (MB)"');
    expect(markup).toContain('>Save Image Limit</button>');
    expect(markup).toContain('0 MB');
    expect(markup).toContain('10 MiB hard client-side download cap');
    expect(markup).toContain('Storage used: 12.35 MB of 500 MB (2.5%).');
    expect(markup).toContain('Identity management');
    expect(markup).toContain('aria-label="Export passphrase"');
    expect(markup).toContain('aria-label="Import passphrase"');
    expect(markup).toContain('>Export Identity</button>');
    expect(markup).toContain('>Import Identity</button>');
    expect(markup).toContain('>Create New Identity</button>');
    expect(markup).toContain('>Clear Identity (Log Out)</button>');

    const settingsPanelEnd = markup.indexOf('</div><div class="card">', markup.indexOf('<h3>Settings</h3>'));
    expect(settingsPanelEnd).toBeGreaterThan(markup.indexOf('<h3>Settings</h3>'));
    expect(markup.indexOf('Recommendations frequency')).toBeLessThan(settingsPanelEnd);
    expect(markup.indexOf('Follow peer by address')).toBeLessThan(settingsPanelEnd);
    expect(markup.indexOf('<h3>Diagnostics</h3>')).toBeGreaterThan(settingsPanelEnd);
    expect(markup.indexOf('Fingerprint')).toBeGreaterThan(markup.indexOf('<h3>Diagnostics</h3>'));
  });
});
