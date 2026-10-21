import { fingerprintToHumanName } from '../utils/fingerprintNames';
import type { Contact } from '../types';
import type { LocalPostView } from '../object-layer';
import { BlockedPeerList } from '../components/BlockedPeerList';

interface MyProfilePageProps {
  identityId: string;
  publicKey: string;
  contacts: Contact[];
  posts: LocalPostView[];
  nickname: string;
  bio: string;
  blockedPeers: string[];
  onNicknameChange: (value: string) => void;
  onBioChange: (value: string) => void;
  onSaveProfile: () => void;
  onUnblockPeer: (peerId: string) => void;
  onViewProfile?: (peerId: string) => void;
}

export function MyProfilePage({
  identityId,
  publicKey,
  contacts,
  posts,
  nickname,
  bio,
  blockedPeers,
  onNicknameChange,
  onBioChange,
  onSaveProfile,
  onUnblockPeer,
  onViewProfile
}: MyProfilePageProps) {
  const generatedNickname = identityId ? fingerprintToHumanName(identityId) : 'Peer';

  return (
    <section className="page-view">
      <div className="page-header">
        <h2>My Profile</h2>
      </div>

      <div className="card profile-edit-card">
        <div className="profile-display-field">
          <span>Generated handle</span>
          <span className="monospace">@{generatedNickname}</span>
        </div>
        <label>
          Display Name
          <input
            value={nickname}
            onChange={(e) => onNicknameChange(e.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Bio
          <textarea value={bio} onChange={(e) => onBioChange(e.target.value)} placeholder="Write a short bio" />
        </label>
        <div className="row">
          <button className="btn" onClick={onSaveProfile}>Save Profile</button>
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
        <h3>Blocked Peers</h3>
        <BlockedPeerList peerIds={blockedPeers} onUnblock={onUnblockPeer} onViewProfile={onViewProfile} />
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
