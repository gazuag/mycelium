interface SettingsPageProps {
  onResetApp: () => void;
  logs: string[];
  onClearLogs: () => void;
  signalEndpoint: string;
  discoveryEndpoint: string;
  connectionStatus: string;
  signallingStatus: string;
  connectedPeers: number;
  syncStatus: string;
}

export function SettingsPage({
  onResetApp,
  logs,
  onClearLogs,
  signalEndpoint,
  discoveryEndpoint,
  connectionStatus,
  signallingStatus,
  connectedPeers,
  syncStatus
}: SettingsPageProps) {
  const isGood = connectionStatus === 'connected' && signallingStatus === 'connected';
  const isWarning = connectionStatus === 'signalling' || connectionStatus === 'connecting' || signallingStatus === 'connecting' || signallingStatus === 'reconnecting';
  const tone = isGood ? 'good' : isWarning ? 'warn' : 'bad';
  const summary = isGood
    ? `Connected to server and ${connectedPeers} peers`
    : 'Disconnected. See diagnostics';

  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Diagnostics</h2>
        <p className="note">Runtime status, endpoints, and app diagnostics.</p>
      </div>

      <div className="card">
        <h3>Connection status</h3>
        <div className={`network-status ${tone}`}>
          <span className="status-light" aria-hidden="true" />
          <strong>{summary}</strong>
        </div>
        <p className="note">Network: {connectionStatus}</p>
        <p className="note">Signal: {signallingStatus}</p>
        <p className="note">Peers: {connectedPeers}</p>
        <p className="note">Sync: {syncStatus}</p>
      </div>

      <div className="card">
        <h3>Network Endpoints</h3>
        <p className="note">Resolved runtime endpoints used by this client.</p>
        <p><strong>Signalling</strong></p>
        <p className="monospace break-word">{signalEndpoint}</p>
        <p><strong>Discovery</strong></p>
        <p className="monospace break-word">{discoveryEndpoint}/api/discovery</p>
      </div>

      <div className="card">
        <h3>Diagnostics</h3>
        <p className="note">Live runtime log of events, discovery fetches, and peer sync activity.</p>
        <div className="log-box" role="log" aria-live="polite">
          {logs.length === 0 ? (
            <p>No diagnostics yet.</p>
          ) : (
            logs.slice().reverse().map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)
          )}
        </div>
        <div className="row">
          <button className="btn secondary" type="button" onClick={onClearLogs}>Clear diagnostics log</button>
        </div>
      </div>

      <div className="card">
        <button className="btn secondary" onClick={onResetApp}>Reset local state</button>
      </div>
    </section>
  );
}
