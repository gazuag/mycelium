import type { Contact } from '../types';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import { IdentityAvatar } from './IdentityAvatar';

interface PeerCardProps {
  contact: Contact;
  onViewProfile: (peerId: string) => void;
  onMessage: (peerId: string) => void;
  onToggleFollow: (peerId: string) => void;
  onBlock?: (peerId: string) => void;
}

export function PeerCard({ contact, onViewProfile, onMessage, onToggleFollow, onBlock }: PeerCardProps) {
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);

  return (
    <article className="peer-card">
      <div className="peer-card-main">
        <button className="ghost-link" onClick={() => onViewProfile(contact.fingerprint)} type="button">
          <IdentityAvatar seed={contact.fingerprint} size={36} alt={displayName} />
          <div className="peer-label-block">
            <strong>{displayName}</strong>
            <span className="note">{contact.fingerprint}</span>
          </div>
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
        {onBlock ? <button className="chip secondary" onClick={() => onBlock(contact.fingerprint)} type="button">Block</button> : null}
      </div>
    </article>
  );
}
