import { useRef, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';

interface LandingPageProps {
  onCreateIdentity: () => void;
  onImportIdentity: (file: File, passphrase: string) => Promise<void>;
}

export function LandingPage({ onCreateIdentity, onImportIdentity }: LandingPageProps) {
  const importInput = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [importError, setImportError] = useState('');
  const [importStatus, setImportStatus] = useState('');

  return (
    <main className="landing-page">
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

      <section className="landing-faq card">
        <h2>FAQ</h2>

        <h3>What is Mycelium?</h3>
        <p>
          Mycelium is a decentralized social protocol and app. There is no centralized account system,
          and no central authority deciding who you are.
        </p>

        <h3>Where is my data stored?</h3>
        <p>
          Your identity and local app data are stored on your device. You control your local storage,
          and you can export your identity backup at any time.
        </p>

        <h3>Can anyone censor me?</h3>
        <p>
          There is no central moderation authority in the protocol. What you see is filtered by your own
          choices, such as hide and block settings.
        </p>

        <h3>What do signalling and discovery servers do?</h3>
        <p>
          Signalling and discovery servers help peers find each other and bootstrap communication, but they
          are not protocol authorities and do not own your identity.
        </p>

        <h3>How does privacy work?</h3>
        <p>
          Direct messages are intended to be private peer-to-peer traffic, and public data is distributed
          without centralized social graph ownership. Liking content can help propagate it to others.
        </p>

        <h3>What are the caveats?</h3>
        <p>
          Mycelium runs in a browser environment. If your local device is compromised, your local data can be at risk.
          Mycelium does not take responsibility for endpoint security or for material users post or send.
        </p>
      </section>
    </main>
  );
}
