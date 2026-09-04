import { useState } from 'react';
import type { ConnectionState } from '../types';
import { fingerprintToHumanName } from '../utils/fingerprintNames';

interface AppHeaderProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  connectionStatus: ConnectionState;
  signallingStatus: string;
  connectedPeers: number;
  connectedPeerIds: string[];
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
  connectedPeerIds,
  syncStatus,
  myFingerprint,
  unreadCount = 0,
  onOpenMyProfile,
  onOpenSettings,
  onOpenPeopleInbox,
  onRefresh
}: AppHeaderProps & { onRefresh?: () => void }) {
  const [peersExpanded, setPeersExpanded] = useState(false);
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
        <div className={`network-status-wrap ${peersExpanded ? 'expanded' : ''}`}>
          <button
            className={`network-status ${tone}`}
            onClick={() => setPeersExpanded((expanded) => !expanded)}
            aria-expanded={peersExpanded}
            aria-controls="connected-peer-list"
          >
            <span className="status-light" aria-hidden="true" />
            <strong>{summary}</strong>
            <span className="network-status-arrow" aria-hidden="true">{peersExpanded ? '▲' : '▼'}</span>
          </button>
          {peersExpanded ? (
            <div id="connected-peer-list" className="connected-peer-list">
              <strong>Open peer connections</strong>
              {connectedPeerIds.length > 0 ? connectedPeerIds.map((peerId) => (
                <div className="connected-peer" key={peerId}>
                  <span>{fingerprintToHumanName(peerId)}</span>
                  <code>{peerId}</code>
                </div>
              )) : <span className="connected-peer-empty">No open data channels</span>}
            </div>
          ) : null}
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
