import { useRef, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';

interface LandingPageProps {
  onCreateIdentity: () => void;
  onImportIdentity: (file: File, passphrase: string) => Promise<void>;
  onOpenHelp: () => void;
}

export function LandingPage({ onCreateIdentity, onImportIdentity, onOpenHelp }: LandingPageProps) {
  const importInput = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [importError, setImportError] = useState('');
  const [importStatus, setImportStatus] = useState('');

  return (
    <main className="landing-page">
      <div className="landing-help-row">
        <button className="btn secondary" type="button" onClick={onOpenHelp} aria-label="Open Help centre">
          ? Help
        </button>
      </div>
      <section className="landing-hero card">
        <BrandLogo className="landing-brand-logo" size={220} />
        <h1>Mycelium</h1>
        <p>
          Mycelium is a peer-to-peer social network where your identity is your keypair,
          your data is local-first, and social communication happens directly between peers.
        </p>
        <div className="row">
          <button className="btn" type="button" onClick={onCreateIdentity}>Create New Identity</button>
          <label>
            Backup passphrase (only for encrypted backups)
            <input
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              aria-label="Backup passphrase"
            />
          </label>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setImportError('');
              setImportStatus('');
              try {
                await onImportIdentity(file, passphrase);
                setImportStatus('Identity imported successfully.');
              } catch (error) {
                setImportError(error instanceof Error ? error.message : String(error));
              }
            }}
          />
          <button className="btn secondary" type="button" onClick={() => importInput.current?.click()}>
            Load Identity File
          </button>
          {importError ? <span className="note" role="alert">{importError}</span> : null}
          {importStatus ? <span className="note" role="status">{importStatus}</span> : null}
        </div>
      </section>

    </main>
  );
}
