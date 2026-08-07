import type { Contact, StoredPost } from '../types';

interface MyProfilePageProps {
  identityId: string;
  publicKey: string;
  contacts: Contact[];
  posts: StoredPost[];
  nickname: string;
  bio: string;
  followedAuthorsRatio: number;
  followedLikesRatio: number;
  discoveryRatio: number;
  onNicknameChange: (value: string) => void;
  onBioChange: (value: string) => void;
  onFollowedAuthorsRatioChange: (value: number) => void;
  onFollowedLikesRatioChange: (value: number) => void;
  onDiscoveryRatioChange: (value: number) => void;
  onSaveProfile: () => void;
  onExportIdentity: () => void;
  onImportIdentity: () => void;
  onCreateIdentity: () => void;
  onClearIdentity: () => void;
}

export function MyProfilePage({
  identityId,
  publicKey,
  contacts,
  posts,
  nickname,
  bio,
  followedAuthorsRatio,
  followedLikesRatio,
  discoveryRatio,
  onNicknameChange,
  onBioChange,
  onFollowedAuthorsRatioChange,
  onFollowedLikesRatioChange,
  onDiscoveryRatioChange,
  onSaveProfile,
  onExportIdentity,
  onImportIdentity,
  onCreateIdentity,
  onClearIdentity
}: MyProfilePageProps) {
  return (
    <section className="page-view">
      <div className="page-header">
        <h2>My Profile</h2>
        <p className="note">Manage your identity and export/import data safely.</p>
      </div>

      <div className="card profile-edit-card">
        <label>
          Nickname
          <input value={nickname} onChange={(e) => onNicknameChange(e.target.value)} placeholder="Your display name" />
        </label>
        <label>
          Bio
          <textarea value={bio} onChange={(e) => onBioChange(e.target.value)} placeholder="Write a short bio" />
        </label>
        <h3>Home Feed Mix</h3>
        <p className="note">These values are weighted ratios for Home feed composition.</p>
        <label>
          From people you follow
          <input
            type="number"
            min={0}
            value={followedAuthorsRatio}
            onChange={(e) => onFollowedAuthorsRatioChange(Number(e.target.value) || 0)}
          />
        </label>
        <label>
          From what people you follow like
          <input
            type="number"
            min={0}
            value={followedLikesRatio}
            onChange={(e) => onFollowedLikesRatioChange(Number(e.target.value) || 0)}
          />
        </label>
        <label>
          Random discovery content
          <input
            type="number"
            min={0}
            value={discoveryRatio}
            onChange={(e) => onDiscoveryRatioChange(Number(e.target.value) || 0)}
          />
        </label>
        <div className="row">
          <button className="btn" onClick={onSaveProfile}>Save Profile</button>
          <button className="btn secondary" onClick={onExportIdentity}>Export Identity</button>
        </div>
        <div className="row">
          <button className="btn secondary" onClick={onImportIdentity}>Import Identity</button>
          <button className="btn secondary" onClick={onCreateIdentity}>Create New Identity</button>
          <button className="btn secondary" onClick={onClearIdentity}>Clear Identity (Log Out)</button>
        </div>
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
            <strong>{contacts.length}</strong>
            <p className="note">Peers</p>
          </div>
          <div>
            <strong>{posts.length}</strong>
            <p className="note">Posts</p>
          </div>
        </div>
      </div>
    </section>
  );
}
