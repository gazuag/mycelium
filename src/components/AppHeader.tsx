import type { ConnectionState } from '../types';

interface AppHeaderProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  connectionStatus: ConnectionState;
  signallingStatus: string;
  connectedPeers: number;
  syncStatus: string;
  myFingerprint?: string;
  unreadCount?: number;
  onOpenMyProfile: () => void;
  onOpenSettings: () => void;
  onOpenPeopleInbox: () => void;
}

export function AppHeader({
  collapsed,
  onToggleCollapse,
  connectionStatus,
  signallingStatus,
  connectedPeers,
  syncStatus,
  myFingerprint,
  unreadCount = 0,
  onOpenMyProfile,
  onOpenSettings,
  onOpenPeopleInbox
}: AppHeaderProps) {
  const isGood = connectionStatus === 'connected' && signallingStatus === 'connected';
  const isWarning = connectionStatus === 'signalling' || connectionStatus === 'connecting' || signallingStatus === 'connecting' || signallingStatus === 'reconnecting';
  const tone = isGood ? 'good' : isWarning ? 'warn' : 'bad';
  const summary = isGood
    ? `Connected to server and ${connectedPeers} peers`
    : 'Disconnected. See diagnostics';

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
        <div className={`network-status ${tone}`}>
          <span className="status-light" aria-hidden="true" />
          <strong>{summary}</strong>
        </div>

        {myFingerprint && (
          <div className="identity-line">
            <span>My identity key:</span>
            <strong>{myFingerprint}</strong>
          </div>
        )}

        <div className="app-header-actions">
          {unreadCount > 0 ? (
            <button className="btn secondary" onClick={onOpenPeopleInbox}>Unread inbox ({unreadCount})</button>
          ) : null}
          <button className="btn" onClick={onOpenMyProfile}>My profile</button>
          <button className="btn secondary" onClick={onOpenSettings}>Diagnostics</button>
        </div>
      </div>
    </header>
  );
}
