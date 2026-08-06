import type { StoredPost } from '../types';

interface MyProfilePageProps {
  fingerprint: string;
  publicKey: string;
  nickname: string;
  bio: string;
  connectedPeerCount: number;
  onSaveProfile: (nickname: string, bio: string) => void;
  onExportIdentity: () => void;
  onImportIdentity: () => void;
  onBack: () => void;
  posts: StoredPost[];
}

export function MyProfilePage({ fingerprint, publicKey, nickname, bio, connectedPeerCount, onSaveProfile, onExportIdentity, onImportIdentity, onBack, posts }: MyProfilePageProps) {
  const [draftNickname, setDraftNickname] = useState(nickname);
  const [draftBio, setDraftBio] = useState(bio);

  return (
    <main className="page-content">
      <section className="page-header">
        <button className="link-button" onClick={onBack}>Back</button>
        <div>
          <h2>My Profile</h2>
          <p className="note">Manage your identity and connection stats.</p>
        </div>
      </section>

      <div className="profile-editor card">
        <label>
          Nickname
          <input value={draftNickname} onChange={(e) => setDraftNickname(e.target.value)} />
        </label>
        <label>
          Bio
          <textarea value={draftBio} onChange={(e) => setDraftBio(e.target.value)} />
        </label>
        <div className="button-row">
          <button className="btn" onClick={() => onSaveProfile(draftNickname, draftBio)}>Save Profile</button>
          <button className="btn secondary" onClick={onExportIdentity}>Export Identity</button>
          <button className="btn secondary" onClick={onImportIdentity}>Import Identity</button>
        </div>
      </div>

      <div className="card">
        <p><strong>Fingerprint</strong></p>
        <p className="note">{fingerprint}</p>
        <p><strong>Public key</strong></p>
        <p className="note">{publicKey}</p>
        <p><strong>Connected peers</strong></p>
        <p className="note">{connectedPeerCount}</p>
      </div>

      <div className="card">
        <h3>Your posts</h3>
        {posts.length === 0 ? <p className="note">No posts yet.</p> : posts.map((post) => (
          <article key={post.id} className="post-card">
            <p>{post.content}</p>
            <p className="note">{new Date(post.timestamp).toLocaleString()}</p>
          </article>
        ))}
      </div>
    </main>
  );
}
