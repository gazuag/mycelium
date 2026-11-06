import { useState } from 'react';
import type { Contact } from '../types';
import { displayNameOrFallback, displayProfileBio } from '../utils/fingerprintNames';
import { createPeerAddUrl } from '../utils/peerAddUrl';
import { FollowButton } from './FollowButton';
import { IdentityAvatar } from './IdentityAvatar';
import { CompactUsername } from './CompactUsername';
import { BlockButton } from './BlockButton';
import { PeerProfileQr } from './PeerProfileQr';

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
  const [shareStatus, setShareStatus] = useState('');
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);
  const peerId = contact.fingerprint || contact.publicKey;

  const copyProfileUrl = async (url: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  };

  const handleShare = async () => {
    const url = createPeerAddUrl(peerId, window.location.origin);
    if (!url) {
      setManualCopyUrl(null);
      setShareStatus('Could not create a profile link for this peer.');
      return;
    }

    setShareStatus('');
    setManualCopyUrl(null);

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: displayName,
          text: PROFILE_SHARE_TEXT,
          url
        });
        return;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
          return;
        }
      }
    }

    if (await copyProfileUrl(url)) {
      setShareStatus('Profile link copied.');
      return;
    }

    setManualCopyUrl(url);
    setShareStatus('Select and copy the profile link below.');
  };

  return (
    <section className="profile-header card">
      <div className="profile-title">
        <div className="profile-title-main">
          <span className="profile-avatar-tools">
            {onAvatarClick ? (
              <button className="profile-avatar-link" type="button" onClick={onAvatarClick} aria-label={`View ${displayName}'s profile`}>
                <IdentityAvatar seed={contact.fingerprint} size={42} alt="" online={showOnlineIndicator && contact.online === true} />
              </button>
            ) : (
              <IdentityAvatar seed={contact.fingerprint} size={42} alt={displayName} online={showOnlineIndicator && contact.online === true} />
            )}
            <PeerProfileQr peerId={peerId} displayName={displayName} />
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
        <button
          className="btn secondary profile-share-button"
          type="button"
          aria-label={`Share ${displayName}'s profile`}
          onClick={() => { void handleShare(); }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="m8.7 10.7 6.6-4.4M8.7 13.3l6.6 4.4" />
          </svg>
          <span>Share profile</span>
        </button>
      </div>
      {shareStatus ? <p className="profile-share-status note" role="status">{shareStatus}</p> : null}
      {manualCopyUrl ? (
        <label className="profile-share-fallback">
          Profile link
          <input
            className="profile-share-url"
            type="url"
            readOnly
            value={manualCopyUrl}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
    </section>
  );
}
