import type { Contact, StoredPost } from '../types';

interface MyProfilePageProps {
  identityId: string;
  publicKey: string;
  contacts: Contact[];
  posts: StoredPost[];
  nickname: string;
  bio: string;
  onNicknameChange: (value: string) => void;
  onBioChange: (value: string) => void;
  onSaveProfile: () => void;
  onExportIdentity: () => void;
  onImportIdentity: () => void;
}

export function MyProfilePage({
  identityId,
  publicKey,
  contacts,
  posts,
  nickname,
  bio,
  onNicknameChange,
  onBioChange,
  onSaveProfile,
  onExportIdentity,
  onImportIdentity
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
        <div className="row">
          <button className="btn" onClick={onSaveProfile}>Save Profile</button>
          <button className="btn secondary" onClick={onExportIdentity}>Export Identity</button>
        </div>
        <button className="btn secondary" onClick={onImportIdentity}>Import Identity</button>
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
