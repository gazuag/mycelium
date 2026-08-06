import type { ConnectionState } from '../types';

interface AppHeaderProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  connectionStatus: ConnectionState;
  signallingStatus: string;
  connectedPeers: number;
  syncStatus: string;
  myFingerprint?: string;
  onOpenMyProfile: () => void;
  onOpenSettings: () => void;
  onRefreshDiscovery: () => void;
}

export function AppHeader({
  collapsed,
  onToggleCollapse,
  connectionStatus,
  signallingStatus,
  connectedPeers,
  syncStatus,
  myFingerprint,
  onOpenMyProfile,
  onOpenSettings,
  onRefreshDiscovery
}: AppHeaderProps) {
  return (
    <header className={`app-header card ${collapsed ? 'collapsed' : ''}`}>
      <div className="app-header-top">
        <div>
          <p className="app-title">Mycelium</p>
          <p className="app-subtitle">Private peer-to-peer social</p>
        </div>
        <button className="icon-btn" onClick={onToggleCollapse} aria-label="Toggle header">
          {collapsed ? '▼' : '▲'}
        </button>
      </div>

      <div className={`app-header-body ${collapsed ? 'collapsed' : ''}`}>
        <div className="status-row">
          <div className="status-pill">
            <span>Net</span>
            <strong>{connectionStatus}</strong>
          </div>
          <div className="status-pill secondary">
            <span>Signal</span>
            <strong>{signallingStatus}</strong>
          </div>
          <div className="status-pill secondary">
            <span>Peers</span>
            <strong>{connectedPeers}</strong>
          </div>
          <div className="status-pill secondary">
            <span>Sync</span>
            <strong>{syncStatus}</strong>
          </div>
        </div>

        {myFingerprint && (
          <div className="identity-line">
            <span>Me</span>
            <strong>{myFingerprint}</strong>
          </div>
        )}

        <div className="app-header-actions">
          <button className="btn" onClick={onOpenMyProfile}>My profile</button>
          <button className="btn secondary" onClick={onRefreshDiscovery}>Refresh</button>
          <button className="btn secondary" onClick={onOpenSettings}>Settings</button>
        </div>
      </div>
    </header>
  );
}
