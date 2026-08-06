import type { ConnectionState } from '../types';

interface AppHeaderProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  connectionStatus: ConnectionState;
  signallingStatus: string;
  connectedPeers: number;
  syncStatus: string;
  onOpenMyProfile: () => void;
  onRefreshDiscovery: () => void;
  onImportIdentity: () => void;
  showBack?: boolean;
  onBack?: () => void;
  pageTitle: string;
}

export function AppHeader({
  collapsed,
  onToggleCollapsed,
  connectionStatus,
  signallingStatus,
  connectedPeers,
  syncStatus,
  onOpenMyProfile,
  onRefreshDiscovery,
  onImportIdentity,
  showBack = false,
  onBack,
  pageTitle
}: AppHeaderProps) {
  return (
    <header className="app-header card">
      <div className="header-top">
        {showBack && onBack ? (
          <button className="icon-button" onClick={onBack} aria-label="Back">
            ←
          </button>
        ) : (
          <div className="header-spacer" />
        )}
        <div>
          <p className="eyebrow">Mycelium</p>
          <h1>{pageTitle}</h1>
        </div>
        <button className="icon-button" onClick={onToggleCollapsed} aria-label="Toggle header">
          {collapsed ? '∨' : '∧'}
        </button>
      </div>

      {!collapsed && (
        <div className="header-body">
          <div className="status-row wrap">
            <div className="status-pill">
              <span>Connection</span>
              <strong>{connectionStatus}</strong>
            </div>
            <div className="status-pill secondary">
              <span>Signalling</span>
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

          <div className="button-row">
            <button className="btn" onClick={onOpenMyProfile}>My Profile</button>
            <button className="btn secondary" onClick={onRefreshDiscovery}>Refresh</button>
            <button className="btn secondary" onClick={onImportIdentity}>Import</button>
          </div>
        </div>
      )}
    </header>
  );
}
