import type { Contact } from '../types';

interface ProfileHeaderProps {
  contact: Contact;
  onFollowToggle: (publicKey: string) => void;
  onMessage: (id: string) => void;
  onBlock: (id: string) => void;
}

export function ProfileHeader({ contact, onFollowToggle, onMessage, onBlock }: ProfileHeaderProps) {
  return (
    <section className="profile-header card">
      <div className="profile-avatar">{contact.displayName?.charAt(0) ?? contact.fingerprint.charAt(0)}</div>
      <div>
        <h2>{contact.displayName ?? contact.fingerprint.slice(0, 12)}</h2>
        <p className="note">{contact.fingerprint}</p>
        <p className="note">{contact.bio ?? 'No bio yet.'}</p>
        <div className="status-pill-row">
          <span className={contact.online ? 'status-dot online' : 'status-dot offline'} />
          <span>{contact.online ? 'Online' : 'Offline'}</span>
        </div>
      </div>
      <div className="button-row">
        <button className="btn" onClick={() => onFollowToggle(contact.publicKey)}>
          {contact.followed ? 'Unfollow' : 'Follow'}
        </button>
        <button className="btn secondary" onClick={() => onMessage(contact.fingerprint)}>Message</button>
        <button className="btn secondary" onClick={() => onBlock(contact.fingerprint)}>Block</button>
      </div>
    </section>
  );
}
