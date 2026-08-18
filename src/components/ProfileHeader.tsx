import type { Contact } from '../types';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import { FollowButton } from './FollowButton';
import { IdentityAvatar } from './IdentityAvatar';
import { BlockButton } from './BlockButton';

interface ProfileHeaderProps {
  contact: Contact;
  onFollowToggle?: () => void;
  onBlock?: () => void;
  onMessage?: () => void;
  showOnlineIndicator?: boolean;
  showActions?: boolean;
  myPeerId?: string;
}

export function ProfileHeader({
  contact,
  onFollowToggle,
  onBlock,
  onMessage,
  showOnlineIndicator = true,
  showActions = true,
  myPeerId
}: ProfileHeaderProps) {
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
        {showOnlineIndicator ? (
          <span className={`status-pill ${contact.online ? 'online' : 'offline'}`}>{contact.online ? 'Online' : 'Offline'}</span>
        ) : null}
      </div>
      <p className="note">{contact.profile?.bio ?? 'No bio yet.'}</p>
      {showActions && onFollowToggle && onMessage && onBlock ? (
        <div className="profile-actions">
          <FollowButton
            peerId={contact.fingerprint || contact.publicKey}
            contacts={[contact]}
            onToggleFollow={async () => { await onFollowToggle(); }}
            myPeerId={myPeerId}
          />
          <button className="btn secondary" onClick={onMessage}>Message</button>
          <BlockButton peerId={contact.fingerprint} contacts={[contact]} myPeerId={myPeerId} onBlock={() => onBlock()} />
        </div>
      ) : null}
    </section>
  );
}
