interface SettingsPageProps {
  identityId: string;
  publicKey: string;
  contacts: number;
  posts: number;
  onResetApp: () => void;
  onClearOldMessages: () => void;
  onClearAllMessages: () => void;
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
  identityId,
  publicKey,
  contacts,
  posts,
  onResetApp,
  onClearOldMessages,
  onClearAllMessages,
  logs,
  onClearLogs,
  signalEndpoint,
  discoveryEndpoint,
  connectionStatus,
  signallingStatus,
  connectedPeers,
  syncStatus
}: SettingsPageProps) {
  const isGood = signallingStatus === 'connected';
  const isWarning = signallingStatus === 'connecting' || signallingStatus === 'reconnecting' || connectionStatus === 'signalling' || connectionStatus === 'connecting';
  const tone = isGood ? 'good' : isWarning ? 'warn' : 'bad';
  const summary = isGood
    ? `Connected to signalling server and ${connectedPeers} peers`
    : isWarning
      ? 'Connecting to network'
      : 'Disconnected. See diagnostics';

  const handleCopyDiagnostics = async () => {
    const text = logs.join('\n');
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
        <h2>Diagnostics</h2>
        <p className="note">Runtime status, endpoints, and app diagnostics.</p>
      </div>

      <div className="card">
        <h3>Identity</h3>
        <p><strong>Fingerprint</strong></p>
        <p className="note monospace">{identityId}</p>
        <p><strong>Public key</strong></p>
        <p className="note monospace break-word">{publicKey}</p>
      </div>

      <div className="card">
        <h3>Stats</h3>
        <div className="stat-grid">
          <div>
            <strong>{contacts}</strong>
            <p className="note">Peers</p>
          </div>
          <div>
            <strong>{posts}</strong>
            <p className="note">Posts</p>
          </div>
        </div>
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
          <button className="btn secondary" type="button" onClick={handleCopyDiagnostics}>Copy diagnostics</button>
          <button className="btn secondary" type="button" onClick={onClearLogs}>Clear diagnostics log</button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <button className="btn secondary" onClick={onResetApp}>Reset local state</button>
          <button className="btn secondary" onClick={onClearOldMessages}>Clear up old messages</button>
          <button className="btn secondary" onClick={onClearAllMessages}>Clear up ALL messages</button>
        </div>
      </div>
    </section>
  );
}
