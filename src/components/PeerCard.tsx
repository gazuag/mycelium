import type { Contact } from '../types';
import { displayNameOrFallback, shortPeerId } from '../utils/fingerprintNames';
import { FollowButton } from './FollowButton';
import { IdentityAvatar } from './IdentityAvatar';
import { CompactUsername } from './CompactUsername';
import { BlockButton } from './BlockButton';
import { useDmUnread } from '../hooks/useDmUnread';

interface PeerCardProps {
  contact: Contact;
  myPeerId?: string;
  onViewProfile: (peerId: string) => void;
  onMessage: (peerId: string) => void;
  onToggleFollow: (peerId: string) => void;
  onBlock?: (peerId: string) => void;
}

export function PeerCard({ contact, myPeerId, onViewProfile, onMessage, onToggleFollow, onBlock }: PeerCardProps) {
  const { byContact } = useDmUnread();
  const unreadCount = byContact[contact.publicKey] ?? 0;
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);

  return (
    <article className="peer-card">
      <div className="peer-card-main">
        <div className="ghost-link">
          <button
            className="peer-card-avatar-button"
            onClick={() => onViewProfile(contact.fingerprint)}
            type="button"
            aria-label={`View ${displayName}'s profile`}
          >
            <IdentityAvatar seed={contact.fingerprint} size={36} alt="" online={contact.online === true} />
          </button>
          <div className="peer-label-block">
            <strong>
              <CompactUsername
                peerId={contact.fingerprint}
                displayName={displayName}
                onProfileClick={onViewProfile}
              />
            </strong>
            <span className="note" title={contact.fingerprint}>{shortPeerId(contact.fingerprint)}</span>
          </div>
        </div>
        <div className="peer-badges">
          <span className={`status-pill ${contact.online ? 'online' : 'offline'}`}>{contact.online ? 'Online' : 'Offline'}</span>
          {unreadCount > 0 ? <span className="status-pill unread">{unreadCount} new</span> : null}
        </div>
      </div>
      <div className="peer-card-footer">
        <button className="chip" onClick={() => onMessage(contact.fingerprint)} type="button">Message</button>
        <FollowButton
          peerId={contact.fingerprint || contact.publicKey}
          contacts={[contact]}
          myPeerId={myPeerId}
          onToggleFollow={async (peerId) => { await onToggleFollow(peerId); }}
        />
        {onBlock ? (
          <BlockButton peerId={contact.fingerprint} contacts={[contact]} myPeerId={myPeerId} onBlock={onBlock} />
        ) : null}
      </div>
    </article>
  );
}
