import { useState } from 'react';
import type { LogCategory, LogEntry } from '../App';

interface SettingsPageProps {
  identityId: string;
  publicKey: string;
  contacts: number;
  posts: number;
  onResetApp: () => void;
  onClearOldMessages: () => void;
  onClearAllMessages: () => void;
  logs: LogEntry[];
  onClearLogs: () => void;
  signalEndpoint: string;
  discoveryEndpoint: string;
  connectionStatus: string;
  signallingStatus: string;
  connectedPeers: number;
  syncStatus: string;
  objectTransportTest?: {
    connectedPeers: string[];
    selectedPeerId: string;
    objectIds: string;
    suppressFindResponses: boolean;
    status: string;
    objects: Array<{ object_id: string; object_type: string; author: string; created_at: string; payload: unknown }>;
    onPeerChange: (peerId: string) => void;
    onObjectIdsChange: (objectIds: string) => void;
    onCreateSet: () => void;
    onSelectFirstBranch: () => void;
    onSelectSecondBranch: () => void;
    onSelectAll: () => void;
    onSendListed: () => void;
    onRemoveListed: () => void;
    onFindListed: () => void;
    onToggleSuppressFindResponses: () => void;
    onClearObjectStore: () => void;
    onRefresh: () => void;
  };
  phase7Test?: {
    author: string;
    startTime: string;
    endTime: string;
    status: string;
    requestId: string;
    objectIds: string;
    selectedObjectId: string;
    objects: Array<{ object_id: string; created_at: string; author: string }>;
    onAuthorChange: (value: string) => void;
    onStartTimeChange: (value: string) => void;
    onEndTimeChange: (value: string) => void;
    onSelectedObjectIdChange: (value: string) => void;
    onCreateSet: () => void;
    onUseCurrentObjectIds: () => void;
    onRunNarrow: () => void;
    onRunBroad: () => void;
    onRunSingleObjectFind: () => void;
    onRefresh: () => void;
  };
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
  syncStatus,
  objectTransportTest,
  phase7Test
}: SettingsPageProps) {
  const [logFilters, setLogFilters] = useState<Record<LogCategory, boolean>>({
    pingPong: false,
    discovery: false,
    chat: false,
    postRequests: false,
    objectStorage: true,
    ice: true,
    general: false
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

      {objectTransportTest && (
        <div className="card">
          <h3>Phase 6 aggregation test</h3>
          <p className="note">Known-object-ID multi-peer FIND test. Use the same IDs across browser peers.</p>
          <div className="row">
            <select
              value={objectTransportTest.selectedPeerId}
              onChange={(event) => objectTransportTest.onPeerChange(event.target.value)}
            >
              <option value="">Select connected peer</option>
              {objectTransportTest.connectedPeers.map((peerId) => <option key={peerId} value={peerId}>{peerId}</option>)}
            </select>
            <label>
              <input type="checkbox" checked={objectTransportTest.suppressFindResponses} onChange={objectTransportTest.onToggleSuppressFindResponses} />
              Suppress FIND responses on this peer
            </label>
            <button className="btn" type="button" onClick={objectTransportTest.onCreateSet}>Create five signed objects</button>
            <button className="btn secondary" type="button" onClick={objectTransportTest.onSelectFirstBranch}>Use 1, 2, 3</button>
            <button className="btn secondary" type="button" onClick={objectTransportTest.onSelectSecondBranch}>Use 3, 4, 5</button>
            <button className="btn secondary" type="button" onClick={objectTransportTest.onSelectAll}>Use all five</button>
          </div>
          <label>
            Object IDs (one per line)
            <textarea
              rows={5}
              value={objectTransportTest.objectIds}
              onChange={(event) => objectTransportTest.onObjectIdsChange(event.target.value)}
              placeholder="64-character object IDs"
            />
          </label>
          <div className="row">
            <button className="btn" type="button" disabled={!objectTransportTest.selectedPeerId} onClick={objectTransportTest.onSendListed}>Send listed objects</button>
            <button className="btn secondary" type="button" onClick={objectTransportTest.onRemoveListed}>Remove listed locally</button>
            <button className="btn" type="button" disabled={!objectTransportTest.selectedPeerId} onClick={objectTransportTest.onFindListed}>FIND listed objects</button>
            <button className="btn secondary" type="button" onClick={objectTransportTest.onClearObjectStore}>Clear object store</button>
            <button className="btn secondary" type="button" onClick={objectTransportTest.onRefresh}>Refresh object store</button>
          </div>
          {objectTransportTest.status && <p className="note monospace break-word">{objectTransportTest.status}</p>}
          <p className="note">Local objects: {objectTransportTest.objects.length}</p>
          {objectTransportTest.objects.map((object) => (
            <div className="note monospace break-word" key={object.object_id}>
              <div>{object.object_type}</div>
              <div>{object.object_id}</div>
              <div>author: {object.author}</div>
              <div>created_at: {object.created_at}</div>
              <div>payload: {JSON.stringify(object.payload)}</div>
            </div>
          ))}
        </div>
      )}

      {phase7Test && (
        <div className="card">
          <h3>Phase 7 time-range query test</h3>
          <p className="note">Use the same browser peer as B and distribute the created objects across A/B/C before running the query.</p>
          <div className="row">
            <label>
              Author public key
              <input value={phase7Test.author} onChange={(event) => phase7Test.onAuthorChange(event.target.value)} placeholder="B peer fingerprint" />
            </label>
            <label>
              Start time T1
              <input value={phase7Test.startTime} onChange={(event) => phase7Test.onStartTimeChange(event.target.value)} placeholder="10:03" />
            </label>
            <label>
              End time T2
              <input value={phase7Test.endTime} onChange={(event) => phase7Test.onEndTimeChange(event.target.value)} placeholder="10:09" />
            </label>
          </div>
          <div className="row">
            <button className="btn" type="button" onClick={phase7Test.onCreateSet}>Create 3 signed objects</button>
            <button className="btn secondary" type="button" onClick={phase7Test.onUseCurrentObjectIds}>Use current object IDs</button>
            <button className="btn" type="button" onClick={phase7Test.onRunNarrow}>Run narrow query: 10:03 &lt; created_at &lt; 10:09</button>
            <button className="btn" type="button" onClick={phase7Test.onRunBroad}>Run broad query: 10:00 &lt; created_at &lt; 10:11</button>
            <button className="btn secondary" type="button" onClick={phase7Test.onRefresh}>Refresh object store</button>
          </div>
          <label>
            Object IDs
            <textarea rows={4} value={phase7Test.objectIds} readOnly placeholder="Phase 7 object IDs" />
          </label>
          <label>
            Single-object FIND ID
            <input value={phase7Test.selectedObjectId} onChange={(event) => phase7Test.onSelectedObjectIdChange(event.target.value)} placeholder="64-char object ID" />
          </label>
          <div className="row">
            <button className="btn" type="button" onClick={phase7Test.onRunSingleObjectFind}>Run single-object FIND(object_id)</button>
          </div>
          {phase7Test.requestId && <p className="note monospace break-word">Request ID: {phase7Test.requestId}</p>}
          {phase7Test.status && <p className="note monospace break-word">{phase7Test.status}</p>}
          <p className="note">Matched objects:</p>
          {phase7Test.objects.length === 0 ? <p className="note">No results yet.</p> : (
            <ul>
              {phase7Test.objects.map((object) => (
                <li key={object.object_id} className="note monospace break-word">
                  {object.object_id} — author={object.author} — created_at={object.created_at}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card">
        <h3>Diagnostics</h3>
        <p className="note">Live runtime log of events, discovery fetches, and peer sync activity.</p>
        <div className="row">
          {(['pingPong', 'discovery', 'chat', 'postRequests', 'objectStorage', 'ice', 'general'] as const).map((category) => (
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
