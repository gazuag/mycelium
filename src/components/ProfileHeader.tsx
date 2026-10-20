import type { Contact } from '../types';
import { displayNameOrFallback, displayProfileBio } from '../utils/fingerprintNames';
import { FollowButton } from './FollowButton';
import { IdentityAvatar } from './IdentityAvatar';
import { CompactUsername } from './CompactUsername';
import { BlockButton } from './BlockButton';

interface ProfileHeaderProps {
  contact: Contact;
  onFollowToggle?: () => void;
  onBlock?: () => void;
  onMessage?: () => void;
  showOnlineIndicator?: boolean;
  showActions?: boolean;
  myPeerId?: string;
  onAvatarClick?: () => void;
}

export function ProfileHeader({
  contact,
  onFollowToggle,
  onBlock,
  onMessage,
  showOnlineIndicator = true,
  showActions = true,
  myPeerId,
  onAvatarClick
}: ProfileHeaderProps) {
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);

  return (
    <section className="profile-header card">
      <div className="profile-title">
        <div className="profile-title-main">
          {onAvatarClick ? (
            <button className="profile-avatar-link" type="button" onClick={onAvatarClick} aria-label={`View ${displayName}'s profile`}>
              <IdentityAvatar seed={contact.fingerprint} size={42} alt="" online={showOnlineIndicator && contact.online === true} />
            </button>
          ) : (
            <IdentityAvatar seed={contact.fingerprint} size={42} alt={displayName} online={showOnlineIndicator && contact.online === true} />
          )}
          <div className="profile-title-name">
            <strong>
              <CompactUsername
                peerId={contact.fingerprint || contact.publicKey}
                displayName={displayName}
                onProfileClick={onAvatarClick ? () => onAvatarClick() : undefined}
              />
            </strong>
          </div>
        </div>
        {showOnlineIndicator ? (
          <span className={`status-pill ${contact.online ? 'online' : 'offline'}`}>{contact.online ? 'Online' : 'Offline'}</span>
        ) : null}
      </div>
      <p className="note">{displayProfileBio(contact.profile?.bio, contact.fingerprint) ?? 'No bio yet.'}</p>
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
