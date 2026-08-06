import type { Contact } from '../types';

interface PeerCardProps {
  contact: Contact;
  onViewProfile: (peerId: string) => void;
  onMessage: (peerId: string) => void;
  onToggleFollow: (peerId: string) => void;
}

export function PeerCard({ contact, onViewProfile, onMessage, onToggleFollow }: PeerCardProps) {
  return (
    <article className="peer-card">
      <div className="peer-card-main">
        <button className="ghost-link" onClick={() => onViewProfile(contact.fingerprint)} type="button">
          <strong>{contact.displayName ?? contact.fingerprint.slice(0, 16)}</strong>
          <span className="note">{contact.fingerprint.slice(0, 16)}</span>
        </button>
        <div className="peer-badges">
          <span className={`status-pill ${contact.online ? 'online' : 'offline'}`}>{contact.online ? 'Online' : 'Offline'}</span>
          {contact.unreadMessages ? <span className="status-pill unread">{contact.unreadMessages} new</span> : null}
        </div>
      </div>
      <div className="peer-card-footer">
        <button className="chip" onClick={() => onMessage(contact.fingerprint)} type="button">Message</button>
        <button className="chip" onClick={() => onToggleFollow(contact.publicKey)} type="button">
          {contact.followed ? 'Unfollow' : 'Follow'}
        </button>
      </div>
    </article>
  );
}
