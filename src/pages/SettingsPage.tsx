interface SettingsPageProps {
  onResetApp: () => void;
  logs: string[];
  onClearLogs: () => void;
  signalEndpoint: string;
  discoveryEndpoint: string;
}

export function SettingsPage({
  onResetApp,
  logs,
  onClearLogs,
  signalEndpoint,
  discoveryEndpoint
}: SettingsPageProps) {
  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Settings</h2>
        <p className="note">App-level options and diagnostics.</p>
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
