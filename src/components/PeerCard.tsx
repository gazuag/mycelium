import type { Contact } from '../types';

interface PeerCardProps {
  contact: Contact;
  onSelect: (id: string) => void;
  onToggleFollow: (publicKey: string) => void;
  onOpenProfile: (id: string) => void;
  collapsed?: boolean;
}

export function PeerCard({ contact, onSelect, onToggleFollow, onOpenProfile }: PeerCardProps) {
  return (
    <article className="peer-card">
      <div>
        <button className="peer-name" onClick={() => onOpenProfile(contact.fingerprint)}>
          <strong>{contact.displayName ?? contact.fingerprint.slice(0, 12)}</strong>
          <span>{contact.fingerprint.slice(0, 16)}</span>
        </button>
        <div className="peer-meta">
          <span className={contact.online ? 'status-dot online' : 'status-dot offline'} />
          <span>{contact.online ? 'Online' : 'Offline'}</span>
          <span>{contact.lastSeen ? ` · ${contact.lastSeen}` : ''}</span>
        </div>
      </div>

      <div className="peer-actions">
        <button className="btn secondary" onClick={() => onSelect(contact.fingerprint)}>
          Message{contact.unreadMessages ? ` (${contact.unreadMessages})` : ''}
        </button>
        <button className="btn secondary" onClick={() => onToggleFollow(contact.publicKey)}>
          {contact.followed ? 'Unfollow' : 'Follow'}
        </button>
      </div>
    </article>
  );
}
