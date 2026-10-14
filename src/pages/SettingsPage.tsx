import { useState } from 'react';
import type { LogCategory, LogEntry } from '../App';

interface SettingsPageProps {
  identityId: string;
  publicKey: string;
  onResetApp: () => void;
  onAddPeerAddress: (address: string) => Promise<void>;
  logs: LogEntry[];
  onClearLogs: () => void;
  signalEndpoint: string;
  discoveryEndpoint: string;
  connectionStatus: string;
  signallingStatus: string;
  connectedPeers: number;
  syncStatus: string;
}

export function SettingsPage({
  identityId,
  publicKey,
  onResetApp,
  onAddPeerAddress,
  logs,
  onClearLogs,
  signalEndpoint,
  discoveryEndpoint,
  connectionStatus,
  signallingStatus,
  connectedPeers,
  syncStatus
}: SettingsPageProps) {
  const [newPeerAddress, setNewPeerAddress] = useState('');
  const [logFilters, setLogFilters] = useState<Record<LogCategory, boolean>>({
    pingPong: true,
    discovery: true,
    postRequests: true,
    objectStorage: true,
    ice: true,
    general: true
  });
  const isGood = signallingStatus === 'connected';
  const isWarning = signallingStatus === 'connecting' || signallingStatus === 'reconnecting' || connectionStatus === 'signalling' || connectionStatus === 'connecting';
  const tone = isGood ? 'good' : isWarning ? 'warn' : 'bad';
  const summary = isGood
    ? `Connected to signalling server and ${connectedPeers} peers`
    : isWarning
      ? 'Connecting to network'
      : 'Disconnected. See diagnostics';

  const handleCopyDiagnostics = async () => {
    const text = logs.filter((entry) => logFilters[entry.category]).map((entry) => entry.text).join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback to a hidden textarea for browsers that block clipboard access
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  };

  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Settings</h2>
        <p className="note">Runtime status, endpoints, and app diagnostics.</p>
      </div>

      <div className="card">
        <section>
          <h3>Identity</h3>
          <p><strong>Fingerprint</strong></p>
          <p className="note monospace">{identityId}</p>
          <p><strong>Public key</strong></p>
          <p className="note monospace break-word">{publicKey}</p>
        </section>

        <section>
          <h3>Connection status</h3>
          <div className={`network-status ${tone}`}>
            <span className="status-light" aria-hidden="true" />
            <strong>{summary}</strong>
          </div>
          <p className="note">Network: {connectionStatus}</p>
          <p className="note">Signal: {signallingStatus}</p>
          <p className="note">Peers: {connectedPeers}</p>
          <p className="note">Sync: {syncStatus}</p>
        </section>

        <section>
          <h3>Network Endpoints</h3>
          <p className="note">Resolved runtime endpoints used by this client.</p>
          <p><strong>Signalling</strong></p>
          <p className="monospace break-word">{signalEndpoint}</p>
          <p><strong>Discovery</strong></p>
          <p className="monospace break-word">{discoveryEndpoint}/api/discovery</p>
        </section>

        <section>
          <h3>Diagnostics</h3>
          <p className="note">Live runtime log of events, discovery fetches, and peer sync activity.</p>
          <div className="row">
            {(['pingPong', 'discovery', 'postRequests', 'objectStorage', 'ice', 'general'] as const).map((category) => (
              <label key={category}>
                <input
                  type="checkbox"
                  checked={logFilters[category]}
                  onChange={() => setLogFilters((current) => ({ ...current, [category]: !current[category] }))}
                />
                {category === 'pingPong' ? 'Ping / pong' : category === 'postRequests' ? 'Post requests' : category === 'objectStorage' ? 'Object storage' : category === 'ice' ? 'ICE' : category[0].toUpperCase() + category.slice(1)}
              </label>
            ))}
          </div>
          <div className="log-box" role="log" aria-live="polite">
            {logs.filter((entry) => logFilters[entry.category]).length === 0 ? (
              <p>No diagnostics yet.</p>
            ) : (
              logs.filter((entry) => logFilters[entry.category]).slice().reverse().map((entry, index) => <p key={`${entry.text}-${index}`}>{entry.text}</p>)
            )}
          </div>
          <div className="row">
            <button className="btn secondary" type="button" onClick={handleCopyDiagnostics}>Copy diagnostics</button>
            <button className="btn secondary" type="button" onClick={onClearLogs}>Clear diagnostics log</button>
          </div>
        </section>

        <section>
          <h3>Advanced</h3>
          <div className="add-peer-card">
            <h4>Add Peer by Address</h4>
            <p className="note">Paste peer node ID or public key, then add and connect.</p>
            <div className="row">
              <input
                value={newPeerAddress}
                onChange={(event) => setNewPeerAddress(event.target.value)}
                placeholder="Peer address"
                aria-label="Peer address"
              />
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  const normalized = newPeerAddress.trim();
                  if (!normalized) return;
                  await onAddPeerAddress(normalized);
                  setNewPeerAddress('');
                }}
              >
                Add peer
              </button>
            </div>
          </div>
        </section>
        <section>
          <div className="row">
            <button className="btn secondary destructive" onClick={onResetApp}>Reset local state</button>
          </div>
        </section>
      </div>
    </section>
  );
}
