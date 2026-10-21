import { useEffect, useRef, useState } from 'react';
import type { LogCategory, LogEntry } from '../App';
import {
  BYTES_PER_MB,
  DEFAULT_OBJECT_STORAGE_BYTES,
  MAX_OBJECT_STORAGE_LIMIT_MB,
  MIN_OBJECT_STORAGE_BYTES
} from '../object-layer/storage-gc';
import { DEFAULT_EXTERNAL_IMAGE_LIMIT_MB, MAX_EXTERNAL_IMAGE_LIMIT_MB } from '../markdown/external-content';

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
  onSaveInjectionFrequencies: (recommendationFrequency: number, discoveryFrequency: number) => void;
  objectStorageLimitMb: number;
  objectStorageUsedBytes: number | null;
  onSaveObjectStorageLimit: (limitMb: number) => boolean;
  externalImageLimitMb: number;
  onSaveExternalImageLimit: (limitMb: number) => boolean;
  onExportIdentity: (passphrase: string) => Promise<void>;
  onImportIdentity: (file: File, passphrase: string) => Promise<void>;
  onCreateIdentity: () => void;
  onClearIdentity: () => void;
}

function parseFrequencyDraft(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
  onSaveInjectionFrequencies,
  objectStorageLimitMb,
  objectStorageUsedBytes,
  onSaveObjectStorageLimit,
  externalImageLimitMb,
  onSaveExternalImageLimit,
  onExportIdentity,
  onImportIdentity,
  onCreateIdentity,
  onClearIdentity
}: SettingsPageProps) {
  const [newPeerAddress, setNewPeerAddress] = useState('');
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportPassphraseConfirmation, setExportPassphraseConfirmation] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [identityBackupError, setIdentityBackupError] = useState('');
  const [identityBackupStatus, setIdentityBackupStatus] = useState('');
  const identityImportInput = useRef<HTMLInputElement>(null);
  const [recommendationFrequencyDraft, setRecommendationFrequencyDraft] = useState(String(recommendationFrequency));
  const [discoveryFrequencyDraft, setDiscoveryFrequencyDraft] = useState(String(discoveryFrequency));
  const [frequencyError, setFrequencyError] = useState('');
  const [frequencySaveStatus, setFrequencySaveStatus] = useState('');
  const [objectStorageLimitDraft, setObjectStorageLimitDraft] = useState(String(objectStorageLimitMb));
  const [objectStorageLimitError, setObjectStorageLimitError] = useState('');
  const [objectStorageLimitSaveStatus, setObjectStorageLimitSaveStatus] = useState('');
  const [externalImageLimitDraft, setExternalImageLimitDraft] = useState(String(externalImageLimitMb));
  const [externalImageLimitError, setExternalImageLimitError] = useState('');
  const [externalImageLimitSaveStatus, setExternalImageLimitSaveStatus] = useState('');
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

  useEffect(() => {
    setRecommendationFrequencyDraft(String(recommendationFrequency));
    setDiscoveryFrequencyDraft(String(discoveryFrequency));
  }, [recommendationFrequency, discoveryFrequency]);

  useEffect(() => {
    setObjectStorageLimitDraft(String(objectStorageLimitMb));
  }, [objectStorageLimitMb]);

  useEffect(() => {
    setExternalImageLimitDraft(String(externalImageLimitMb));
  }, [externalImageLimitMb]);

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
          <h3>External images</h3>
          <div className="add-peer-card">
            <label>
              <strong>Maximum known external image size (MB)</strong>
              <input
                aria-label="Maximum known external image size (MB)"
                type="number"
                min={0}
                max={MAX_EXTERNAL_IMAGE_LIMIT_MB}
                step={0.1}
                value={externalImageLimitDraft}
                onChange={(event) => {
                  setExternalImageLimitDraft(event.currentTarget.value);
                  setExternalImageLimitError('');
                  setExternalImageLimitSaveStatus('');
                }}
              />
            </label>
            <div className="row" aria-label="External image size presets">
              {[0, 1, DEFAULT_EXTERNAL_IMAGE_LIMIT_MB, 10, 25].map((limit) => (
                <button
                  key={limit}
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    setExternalImageLimitDraft(String(limit));
                    setExternalImageLimitError('');
                    setExternalImageLimitSaveStatus('');
                  }}
                >
                  {limit} MB
                </button>
              ))}
            </div>
            <p className="note">
              MB uses decimal units (1 MB = 1,000,000 bytes). Images with unknown or larger reported sizes require an explicit load action. Setting this to 0 disables automatic image display. Every loaded image also has a separate 10 MiB hard client-side download cap.
            </p>
            <div className="row">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const parsed = Number(externalImageLimitDraft);
                  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_EXTERNAL_IMAGE_LIMIT_MB) {
                    setExternalImageLimitError(`Enter a number between 0 and ${MAX_EXTERNAL_IMAGE_LIMIT_MB} MB.`);
                    setExternalImageLimitSaveStatus('');
                    return;
                  }
                  if (!onSaveExternalImageLimit(parsed)) {
                    setExternalImageLimitError('The external image display limit could not be saved.');
                    setExternalImageLimitSaveStatus('');
                    return;
                  }
                  setExternalImageLimitDraft(String(parsed));
                  setExternalImageLimitError('');
                  setExternalImageLimitSaveStatus('External image display limit saved.');
                }}
              >
                Save Image Limit
              </button>
              {externalImageLimitError ? <span className="note" role="alert">{externalImageLimitError}</span> : null}
              {externalImageLimitSaveStatus ? <span className="note" role="status">{externalImageLimitSaveStatus}</span> : null}
            </div>
          </div>
        </section>

        <section>
          <h3>Object storage</h3>
          <div className="add-peer-card">
            <label>
              <strong>Maximum object storage (MB)</strong>
              <input
                aria-label="Maximum object storage (MB)"
                type="number"
                min={MIN_OBJECT_STORAGE_BYTES / BYTES_PER_MB}
                max={MAX_OBJECT_STORAGE_LIMIT_MB}
                step={1}
                value={objectStorageLimitDraft}
                onChange={(event) => {
                  setObjectStorageLimitDraft(event.currentTarget.value);
                  setObjectStorageLimitError('');
                  setObjectStorageLimitSaveStatus('');
                }}
                onBlur={() => {
                  const parsed = parseFrequencyDraft(objectStorageLimitDraft);
                  setObjectStorageLimitDraft(String(
                    parsed !== undefined
                      && parsed >= MIN_OBJECT_STORAGE_BYTES / BYTES_PER_MB
                      && parsed <= MAX_OBJECT_STORAGE_LIMIT_MB
                      ? parsed
                      : objectStorageLimitMb
                  ));
                }}
              />
            </label>
            <p className="note" role="status" aria-live="polite">
              {objectStorageUsedBytes === null
                ? 'Storage usage is being calculated.'
                : `Storage used: ${(objectStorageUsedBytes / BYTES_PER_MB).toFixed(2)} MB of ${objectStorageLimitMb} MB (${((objectStorageUsedBytes / (objectStorageLimitMb * BYTES_PER_MB)) * 100).toFixed(1)}%).`}
            </p>
            <p className="note">Usage includes stored objects, deletion tombstones, and GC observation records. It excludes IndexedDB overhead and unrelated stores. Garbage collection starts near 90% and targets 78%. The default is {DEFAULT_OBJECT_STORAGE_BYTES / BYTES_PER_MB} MB.</p>
            <div className="row">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const parsed = parseFrequencyDraft(objectStorageLimitDraft);
                  if (parsed === undefined
                    || parsed < MIN_OBJECT_STORAGE_BYTES / BYTES_PER_MB
                    || parsed > MAX_OBJECT_STORAGE_LIMIT_MB) {
                    setObjectStorageLimitError(`Enter a whole number between ${MIN_OBJECT_STORAGE_BYTES / BYTES_PER_MB} and ${MAX_OBJECT_STORAGE_LIMIT_MB} MB.`);
                    setObjectStorageLimitSaveStatus('');
                    return;
                  }
                  if (!onSaveObjectStorageLimit(parsed)) {
                    setObjectStorageLimitError('The object storage limit could not be saved.');
                    setObjectStorageLimitSaveStatus('');
                    return;
                  }
                  setObjectStorageLimitDraft(String(parsed));
                  setObjectStorageLimitError('');
                  setObjectStorageLimitSaveStatus('Object storage limit saved. Garbage collection reevaluated the store.');
                }}
              >Save Storage Limit</button>
              {objectStorageLimitError ? <span className="note" role="alert">{objectStorageLimitError}</span> : null}
              {objectStorageLimitSaveStatus ? <span className="note" role="status">{objectStorageLimitSaveStatus}</span> : null}
            </div>
          </div>
        </section>

        <section>
          <h3>Home feed</h3>
          <div className="add-peer-card">
            <label>
              <strong>Recommendations frequency</strong>
              <div className="row">
                <button
                  className="btn secondary"
                  type="button"
                  aria-label="Decrease Recommendations frequency"
                  onClick={() => {
                    const current = parseFrequencyDraft(recommendationFrequencyDraft) ?? recommendationFrequency;
                    setRecommendationFrequencyDraft(String(Math.max(0, current - 1)));
                    setFrequencyError('');
                    setFrequencySaveStatus('');
                  }}
                >−</button>
                <input
                  aria-label="Recommendations frequency"
                  type="number"
                  min={0}
                  step={1}
                  value={recommendationFrequencyDraft}
                  onChange={(event) => {
                    setRecommendationFrequencyDraft(event.currentTarget.value);
                    setFrequencyError('');
                    setFrequencySaveStatus('');
                  }}
                  onBlur={() => {
                    const parsed = parseFrequencyDraft(recommendationFrequencyDraft);
                    setRecommendationFrequencyDraft(String(parsed ?? recommendationFrequency));
                  }}
                />
                <button
                  className="btn secondary"
                  type="button"
                  aria-label="Increase Recommendations frequency"
                  disabled={(parseFrequencyDraft(recommendationFrequencyDraft) ?? recommendationFrequency) === Number.MAX_SAFE_INTEGER}
                  onClick={() => {
                    const current = parseFrequencyDraft(recommendationFrequencyDraft) ?? recommendationFrequency;
                    setRecommendationFrequencyDraft(String(current + 1));
                    setFrequencyError('');
                    setFrequencySaveStatus('');
                  }}
                >+</button>
              </div>
            </label>
            <p className="note">Inject a recommendation after this many newly eligible posts have been counted (injection happens when the count exceeds this value). Set to 0 to disable recommendation injections.</p>
            <label>
              <strong>Discovery frequency</strong>
              <div className="row">
                <button
                  className="btn secondary"
                  type="button"
                  aria-label="Decrease Discovery frequency"
                  onClick={() => {
                    const current = parseFrequencyDraft(discoveryFrequencyDraft) ?? discoveryFrequency;
                    setDiscoveryFrequencyDraft(String(Math.max(0, current - 1)));
                    setFrequencyError('');
                    setFrequencySaveStatus('');
                  }}
                >−</button>
                <input
                  aria-label="Discovery frequency"
                  type="number"
                  min={0}
                  step={1}
                  value={discoveryFrequencyDraft}
                  onChange={(event) => {
                    setDiscoveryFrequencyDraft(event.currentTarget.value);
                    setFrequencyError('');
                    setFrequencySaveStatus('');
                  }}
                  onBlur={() => {
                    const parsed = parseFrequencyDraft(discoveryFrequencyDraft);
                    setDiscoveryFrequencyDraft(String(parsed ?? discoveryFrequency));
                  }}
                />
                <button
                  className="btn secondary"
                  type="button"
                  aria-label="Increase Discovery frequency"
                  disabled={(parseFrequencyDraft(discoveryFrequencyDraft) ?? discoveryFrequency) === Number.MAX_SAFE_INTEGER}
                  onClick={() => {
                    const current = parseFrequencyDraft(discoveryFrequencyDraft) ?? discoveryFrequency;
                    setDiscoveryFrequencyDraft(String(current + 1));
                    setFrequencyError('');
                    setFrequencySaveStatus('');
                  }}
                >+</button>
              </div>
            </label>
            <p className="note">Inject a Discovery post after this many newly eligible posts have been counted (injection happens when the count exceeds this value). Set to 0 to disable Discovery injections.</p>
            <div className="row">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const recommendationValue = parseFrequencyDraft(recommendationFrequencyDraft);
                  const discoveryValue = parseFrequencyDraft(discoveryFrequencyDraft);
                  if (recommendationValue === undefined || discoveryValue === undefined) {
                    setFrequencyError('Enter a non-negative whole number for both frequencies.');
                    setFrequencySaveStatus('');
                    return;
                  }
                  onSaveInjectionFrequencies(recommendationValue, discoveryValue);
                  setRecommendationFrequencyDraft(String(recommendationValue));
                  setDiscoveryFrequencyDraft(String(discoveryValue));
                  setFrequencyError('');
                  setFrequencySaveStatus('Home feed settings saved.');
                }}
              >Save Settings</button>
              {frequencyError ? <span className="note" role="alert">{frequencyError}</span> : null}
              {frequencySaveStatus ? <span className="note" role="status">{frequencySaveStatus}</span> : null}
            </div>
          </div>
        </section>

        <section>
          <h3>Identity management</h3>
          <p className="note">Identity backups can be exported as plain JSON or encrypted with a passphrase. If you forget the passphrase, the encrypted backup cannot be restored.</p>
          <div className="row">
            <label>
              Export passphrase (leave blank for unencrypted)
              <input
                type="password"
                autoComplete="new-password"
                value={exportPassphrase}
                onChange={(event) => setExportPassphrase(event.target.value)}
                aria-label="Export passphrase"
              />
            </label>
            {exportPassphrase ? (
              <label>
                Confirm export passphrase
                <input
                  type="password"
                  autoComplete="new-password"
                  value={exportPassphraseConfirmation}
                  onChange={(event) => setExportPassphraseConfirmation(event.target.value)}
                  aria-label="Confirm export passphrase"
                />
              </label>
            ) : null}
            <button
              className="btn secondary"
              type="button"
              onClick={async () => {
                setIdentityBackupError('');
                setIdentityBackupStatus('');
                if (exportPassphrase && exportPassphrase.length < 8) {
                  setIdentityBackupError('Use a passphrase with at least 8 characters, or leave it blank for an unencrypted backup.');
                  return;
                }
                if (exportPassphrase && exportPassphrase !== exportPassphraseConfirmation) {
                  setIdentityBackupError('The passphrases do not match.');
                  return;
                }
                try {
                  await onExportIdentity(exportPassphrase);
                  setIdentityBackupStatus('Identity backup download started.');
                } catch (error) {
                  setIdentityBackupError(error instanceof Error ? error.message : String(error));
                }
              }}
            >Export Identity</button>
            <label>
              Import passphrase (only for encrypted backups)
              <input
                type="password"
                autoComplete="current-password"
                value={importPassphrase}
                onChange={(event) => setImportPassphrase(event.target.value)}
                aria-label="Import passphrase"
              />
            </label>
            <input
              ref={identityImportInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                setIdentityBackupError('');
                setIdentityBackupStatus('');
                try {
                  await onImportIdentity(file, importPassphrase);
                  setIdentityBackupStatus('Identity imported successfully.');
                } catch (error) {
                  setIdentityBackupError(error instanceof Error ? error.message : String(error));
                }
              }}
            />
            <button className="btn secondary" type="button" onClick={() => identityImportInput.current?.click()}>
              Import Identity
            </button>
            {identityBackupError ? <span className="note" role="alert">{identityBackupError}</span> : null}
            {identityBackupStatus ? <span className="note" role="status">{identityBackupStatus}</span> : null}
            <button className="btn secondary" type="button" onClick={onCreateIdentity}>Create New Identity</button>
            <button className="btn secondary destructive" type="button" onClick={onClearIdentity}>Clear Identity (Log Out)</button>
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
