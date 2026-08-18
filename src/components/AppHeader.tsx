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
  onRefresh?: () => void;
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
  onOpenPeopleInbox,
  onRefresh
}: AppHeaderProps & { onRefresh?: () => void }) {
  const isGood = signallingStatus === 'connected';
  const isWarning = signallingStatus === 'connecting' || signallingStatus === 'reconnecting' || connectionStatus === 'signalling' || connectionStatus === 'connecting';
  const tone = isGood ? 'good' : isWarning ? 'warn' : 'bad';
  const summary = isGood
    ? `Connected to signalling server and ${connectedPeers} peers`
    : isWarning
      ? 'Connecting to network'
      : 'Disconnected. See diagnostics';

  return (
    <header className={`app-header card ${collapsed ? 'collapsed' : ''}`}>
      <div className="app-header-top">
        <div>
          <p className="app-title">Mycelium - Private peer-to-peer social</p>
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

        <div className="app-header-actions">
          {unreadCount > 0 ? (
            <button className="btn secondary" onClick={onOpenPeopleInbox}>Unread inbox ({unreadCount})</button>
          ) : null}
          <button className="btn" onClick={onOpenMyProfile}>My profile</button>
          {onRefresh ? <button className="btn secondary" onClick={onRefresh}>Refresh</button> : null}
          <button className="btn secondary" onClick={onOpenSettings}>Diagnostics</button>
        </div>
      </div>
    </header>
  );
}
