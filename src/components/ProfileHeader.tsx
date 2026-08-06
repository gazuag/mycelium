import type { Contact } from '../types';

interface ProfileHeaderProps {
  contact: Contact;
  onFollowToggle: () => void;
  onBlock: () => void;
  onMessage: () => void;
}

export function ProfileHeader({ contact, onFollowToggle, onBlock, onMessage }: ProfileHeaderProps) {
  return (
    <section className="profile-header card">
      <div className="profile-title">
        <div>
          <strong>{contact.displayName ?? contact.fingerprint.slice(0, 16)}</strong>
          <p className="note">{contact.fingerprint}</p>
        </div>
        <span className={`status-pill ${contact.online ? 'online' : 'offline'}`}>{contact.online ? 'Online' : 'Offline'}</span>
      </div>
      <p className="note">{contact.profile?.bio ?? 'No bio yet.'}</p>
      <div className="profile-actions">
        <button className="btn" onClick={onFollowToggle}>{contact.followed ? 'Unfollow' : 'Follow'}</button>
        <button className="btn secondary" onClick={onBlock}>Block</button>
        <button className="btn secondary" onClick={onMessage}>Message</button>
      </div>
    </section>
  );
}
