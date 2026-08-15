import type { Contact } from '../types';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import { IdentityAvatar } from './IdentityAvatar';

interface ProfileHeaderProps {
  contact: Contact;
  onFollowToggle: () => void;
  onBlock: () => void;
  onMessage: () => void;
}

export function ProfileHeader({ contact, onFollowToggle, onBlock, onMessage }: ProfileHeaderProps) {
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);

  return (
    <section className="profile-header card">
      <div className="profile-title">
        <div className="profile-title-main">
          <IdentityAvatar seed={contact.fingerprint} size={42} alt={displayName} />
          <div>
            <strong>{displayName}</strong>
            <p className="note">{contact.fingerprint}</p>
          </div>
        </div>
        <span className={`status-pill ${contact.online ? 'online' : 'offline'}`}>{contact.online ? 'Online' : 'Offline'}</span>
      </div>
      <p className="note">{contact.profile?.bio ?? 'No bio yet.'}</p>
      <div className="profile-actions">
        <button className="btn" onClick={onFollowToggle}>{contact.followed ? 'Unfollow' : 'Follow'}</button>
        <button className="btn secondary" onClick={onMessage}>Message</button>
        <button className="btn secondary" onClick={onBlock}>Block</button>
      </div>
    </section>
  );
}
