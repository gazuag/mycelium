import { useEffect, useState } from 'react';
import type { Contact } from '../types';
import { displayNameOrFallback, displayProfileBio } from '../utils/fingerprintNames';
import { createPeerAddUrl } from '../utils/peerAddUrl';
import { profilePictureDataUrl } from '../utils/profile-picture';
import { FollowButton } from './FollowButton';
import { IdentityAvatar } from './IdentityAvatar';
import { CompactUsername } from './CompactUsername';
import { BlockButton } from './BlockButton';
import { PeerProfileQr } from './PeerProfileQr';
import { SharePopover } from './SharePopover';

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

const PROFILE_SHARE_TEXT = 'Check out this profile on Mycelium';

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
  const [qrOpen, setQrOpen] = useState(false);
  const [profilePictureOpen, setProfilePictureOpen] = useState(false);
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);
  const peerId = contact.fingerprint || contact.publicKey;
  const profilePicture = contact.profilePicture ?? contact.identityObject?.payload.profile_picture;
  const profilePictureUrl = profilePictureDataUrl(profilePicture);
  const profileUrl = typeof window !== 'undefined'
    ? createPeerAddUrl(peerId, window.location.origin)
    : null;

  useEffect(() => {
    if (!profilePictureOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfilePictureOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [profilePictureOpen]);

  return (
    <section className="profile-header card">
      <div className="profile-title">
        <div className="profile-title-main">
          <span className="profile-avatar-tools">
            {onAvatarClick ? (
              <button
                className={`profile-avatar-link${profilePictureUrl ? ' has-profile-picture' : ''}`}
                type="button"
                onClick={() => profilePictureUrl ? setProfilePictureOpen(true) : onAvatarClick()}
                aria-label={profilePictureUrl ? `View ${displayName}'s profile picture` : `View ${displayName}'s profile`}
              >
                <IdentityAvatar seed={contact.fingerprint} size={42} alt="" online={showOnlineIndicator && contact.online === true} profilePicture={profilePicture} />
              </button>
            ) : (
              <IdentityAvatar seed={contact.fingerprint} size={42} alt={displayName} online={showOnlineIndicator && contact.online === true} profilePicture={profilePicture} />
            )}
            <PeerProfileQr peerId={peerId} displayName={displayName} open={qrOpen} onOpenChange={setQrOpen} />
          </span>
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
      <p className="note">{displayProfileBio(
        contact.identityObject?.payload.bio ?? contact.profile?.bio,
        peerId
      ) ?? 'No bio yet.'}</p>
      <div className="profile-actions">
        {showActions && onFollowToggle && onMessage && onBlock ? (
          <>
            <FollowButton
              peerId={peerId}
              contacts={[contact]}
              onToggleFollow={async () => { await onFollowToggle(); }}
              myPeerId={myPeerId}
            />
            <button className="btn secondary" onClick={onMessage}>Message</button>
            <BlockButton peerId={contact.fingerprint} contacts={[contact]} myPeerId={myPeerId} onBlock={() => onBlock()} />
          </>
        ) : null}
        {profileUrl ? (
          <SharePopover
            title={displayName}
            description={PROFILE_SHARE_TEXT}
            url={profileUrl}
            ariaLabel={`Share ${displayName}'s profile`}
            avatar={<IdentityAvatar seed={peerId} size={38} alt="" profilePicture={contact.profilePicture ?? contact.identityObject?.payload.profile_picture} />}
            onOpenQr={() => setQrOpen(true)}
          />
        ) : (
          <button className="btn secondary share-popover-trigger" type="button" disabled>
            Share
          </button>
        )}
      </div>
      {profilePictureOpen && profilePictureUrl ? (
        <div className="profile-picture-backdrop" onClick={() => setProfilePictureOpen(false)}>
          <section
            className="profile-picture-dialog card"
            role="dialog"
            aria-modal="true"
            aria-label={`${displayName}'s profile picture`}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="profile-picture-close btn secondary"
              type="button"
              aria-label="Close profile picture"
              onClick={() => setProfilePictureOpen(false)}
            >
              ×
            </button>
            <img className="profile-picture-full" src={profilePictureUrl} alt={`${displayName}'s profile picture`} width={256} height={256} />
          </section>
        </div>
      ) : null}
    </section>
  );
}
