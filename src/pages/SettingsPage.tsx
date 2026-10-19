import { useEffect, useRef, useState } from 'react';
import type { LogCategory, LogEntry } from '../App';

interface SettingsPageProps {
  identityId: string;
  publicKey: string;
  onResetApp: () => void;
  onAddPeerAddress: (address: string) => Promise<boolean>;
  logs: LogEntry[];
  onClearLogs: () => void;
  signalEndpoint: string;
  discoveryEndpoint: string;
  connectionStatus: string;
  signallingStatus: string;
  connectedPeers: number;
  syncStatus: string;
  recommendationFrequency: number;
  discoveryFrequency: number;
  onInjectionFrequencyChange: (source: 'recommendation' | 'discovery', value: number) => void;
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
  syncStatus,
  recommendationFrequency,
  discoveryFrequency,
  onInjectionFrequencyChange
}: SettingsPageProps) {
  const [newPeerAddress, setNewPeerAddress] = useState('');
  const [followConfirmation, setFollowConfirmation] = useState('');
  const followConfirmationTimer = useRef<number | undefined>(undefined);
  const [identityCopyStatus, setIdentityCopyStatus] = useState('');
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

  useEffect(() => () => {
    if (followConfirmationTimer.current !== undefined) {
      window.clearTimeout(followConfirmationTimer.current);
    }
  }, []);

  const handleCopyFingerprint = async () => {
    try {
      try {
        await navigator.clipboard.writeText(identityId);
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = identityId;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('Clipboard copy was rejected.');
      }
      setIdentityCopyStatus('Fingerprint copied.');
    } catch {
      setIdentityCopyStatus('Could not copy fingerprint. Select and copy it manually.');
    }
  };

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
        <p className="note">Configure your Home feed and peer connections.</p>
      </div>

      <div className="card">
        <section>
          <h3>Settings</h3>
        </section>

        <section>
          <h3>Home feed</h3>
          <div className="add-peer-card">
            <label>
              <strong>Recommendations frequency</strong>
              <input
                aria-label="Recommendations frequency"
                type="number"
                min={0}
                step={1}
                value={recommendationFrequency}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isSafeInteger(value) && value >= 0) {
                    onInjectionFrequencyChange('recommendation', value);
                  }
                }}
              />
            </label>
            <p className="note">Inject a recommendation after this many newly eligible posts have been counted (injection happens when the count exceeds this value). Set to 0 to disable recommendation injections.</p>
            <label>
              <strong>Discovery frequency</strong>
              <input
                aria-label="Discovery frequency"
                type="number"
                min={0}
                step={1}
                value={discoveryFrequency}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isSafeInteger(value) && value >= 0) {
                    onInjectionFrequencyChange('discovery', value);
                  }
                }}
              />
            </label>
            <p className="note">Inject a Discovery post after this many newly eligible posts have been counted (injection happens when the count exceeds this value). Set to 0 to disable Discovery injections.</p>
          </div>
        </section>

        <section>
          <h3>Advanced</h3>
          <div className="add-peer-card">
            <h4>Follow peer by address</h4>
            <p className="note">Enter an @handle or 64-bit peer ID (for example, aa:bb:cc:dd:ee:ff:00:11), or paste a public key.</p>
            <div className="row">
              <input
                value={newPeerAddress}
                onChange={(event) => setNewPeerAddress(event.target.value)}
                placeholder="@PeerHandle or 64-bit peer ID"
                aria-label="Peer address"
              />
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  const normalized = newPeerAddress.trim();
                  if (!normalized) return;
                  const followed = await onAddPeerAddress(normalized);
                  if (followed) {
                    setNewPeerAddress('');
                    setFollowConfirmation(`User ${normalized} followed`);
                    if (followConfirmationTimer.current !== undefined) {
                      window.clearTimeout(followConfirmationTimer.current);
                    }
                    followConfirmationTimer.current = window.setTimeout(() => {
                      setFollowConfirmation('');
                      followConfirmationTimer.current = undefined;
                    }, 3000);
                  }
                }}
              >
                Follow peer
              </button>
            </div>
          </div>
        </section>


      </div>

      <div className="card">
        <section>
          <h3>Diagnostics</h3>
        </section>
        <section>
          <h4>Identity</h4>
          <p><strong>Fingerprint</strong></p>
          <p className="note monospace">{identityId}</p>
          <div className="row">
            <button className="btn secondary" type="button" onClick={() => void handleCopyFingerprint()}>Copy fingerprint</button>
            {identityCopyStatus ? <span className="note" role="status">{identityCopyStatus}</span> : null}
          </div>
          <p><strong>Public key</strong></p>
          <p className="note monospace break-word">{publicKey}</p>
        </section>
        <section>
          <h4>Connection status</h4>
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
          <h4>Network Endpoints</h4>
          <p className="note">Resolved runtime endpoints used by this client.</p>
          <p><strong>Signalling</strong></p>
          <p className="monospace break-word">{signalEndpoint}</p>
          <p><strong>Discovery</strong></p>
          <p className="monospace break-word">{discoveryEndpoint}/api/discovery</p>
        </section>
        <section>
          <h4>Diagnostic log</h4>
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

      </div>
      {followConfirmation ? (
        <div className="follow-confirmation" role="status" aria-live="polite">
          {followConfirmation}
        </div>
      ) : null}
    </section>
  );
}
