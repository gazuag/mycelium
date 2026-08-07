interface LandingPageProps {
  onCreateIdentity: () => void;
  onImportIdentity: () => void;
}

export function LandingPage({ onCreateIdentity, onImportIdentity }: LandingPageProps) {
  return (
    <main className="landing-page">
      <section className="landing-hero card">
        <h1>Mycelium</h1>
        <p>
          Mycelium is a peer-to-peer social network where your identity is your keypair,
          your data is local-first, and social communication happens directly between peers.
        </p>
        <div className="row">
          <button className="btn" type="button" onClick={onCreateIdentity}>Create New Identity</button>
          <button className="btn secondary" type="button" onClick={onImportIdentity}>Load Identity File</button>
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
