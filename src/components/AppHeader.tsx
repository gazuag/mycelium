import type { ConnectionState } from '../types';
import { BrandLogo } from './BrandLogo';
import { CompactUsername } from './CompactUsername';

interface AppHeaderProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  connectionStatus: ConnectionState;
  signallingStatus: string;
  connectedPeers: number;
  connectedPeerIds: string[];
  syncStatus: string;
  myFingerprint?: string;
  onPeerProfileClick: (peerId: string) => void;
}

export function AppHeader({
  collapsed,
  onToggleCollapse,
  connectionStatus,
  signallingStatus,
  connectedPeers,
  connectedPeerIds,
  syncStatus,
  myFingerprint,
  onPeerProfileClick
}: AppHeaderProps) {
  const isGood = signallingStatus === 'connected';
  const isWarning = signallingStatus === 'connecting' || signallingStatus === 'reconnecting' || connectionStatus === 'signalling' || connectionStatus === 'connecting';
  const tone = isGood ? 'good' : isWarning ? 'warn' : 'bad';
  const summary = isGood
    ? `Connected to signalling server and ${connectedPeers} peers`
    : isWarning
      ? 'Connecting to network'
      : 'Disconnected. See diagnostics';
  const statusLabel = isGood ? 'Connected' : isWarning ? 'Connecting' : 'Disconnected';

  return (
    <header className={`app-header card ${collapsed ? 'collapsed' : ''}`}>
      <div className="app-header-top">
        <div className="brand-mark">
          <BrandLogo variant="default" className="brand-logo app-brand-logo" size={32} />
          <p className="app-title">Mycelium - Private peer-to-peer social</p>
        </div>
        <button
          className={`icon-btn header-menu-toggle ${tone}`}
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Open main menu' : 'Close main menu'}
          aria-expanded={!collapsed}
        >
          <span className="status-light" aria-hidden="true" />
        </button>
      </div>

      <div className={`app-header-body ${collapsed ? 'collapsed' : ''}`}>
        <section className={`network-status-panel ${tone}`} aria-label="Peer connection status">
          <div className="network-status-summary">
            <span className="status-light" aria-hidden="true" />
            <strong>{statusLabel}</strong>
            <span>{summary}</span>
          </div>
          <div id="connected-peer-list" className="connected-peer-list">
            <strong>Open peer connections</strong>
            {connectedPeerIds.length > 0 ? connectedPeerIds.map((peerId) => (
              <div className="connected-peer" key={peerId}>
                <CompactUsername peerId={peerId} onProfileClick={onPeerProfileClick} />
                <code>{peerId}</code>
              </div>
            )) : <span className="connected-peer-empty">No open data channels</span>}
          </div>
        </section>
      </div>
    </header>
  );
}
