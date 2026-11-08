import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Contact } from '../types';
import { displayNameOrFallback, displayProfileBio, fingerprintToHumanName } from '../utils/fingerprintNames';
import { createPeerAddUrl } from '../utils/peerAddUrl';
import { copyTextToClipboard } from '../utils/clipboard';
import { profilePictureDataUrl } from '../utils/profile-picture';
import { FollowButton } from './FollowButton';
import { AVATAR_SIZES, IdentityAvatar } from './IdentityAvatar';
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
  isOwnProfile?: boolean;
  profileSettings?: ReactNode;
  followingCount?: number;
  followerCount?: number;
  onOpenRelationships?: (tab: 'following' | 'followers') => void;
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
  onAvatarClick,
  isOwnProfile = false,
  profileSettings,
  followingCount,
  followerCount,
  onOpenRelationships
}: ProfileHeaderProps) {
  const [qrOpen, setQrOpen] = useState(false);
  const [profilePictureOpen, setProfilePictureOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const moreRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const shareActionRef = useRef<(() => void) | null>(null);
  const registerShareAction = useCallback((trigger: (() => void) | null) => {
    shareActionRef.current = trigger;
  }, []);

  const peerId = contact.fingerprint || contact.publicKey;
  const name = contact.displayName?.trim();
  const handle = fingerprintToHumanName(peerId);
  const hasDisplayName = Boolean(name && name !== handle);
  const displayName = displayNameOrFallback(name, peerId);
  const profilePicture = contact.profilePicture ?? contact.identityObject?.payload.profile_picture;
  const profilePictureUrl = profilePictureDataUrl(profilePicture);
  const profileUrl = typeof window !== 'undefined'
    ? createPeerAddUrl(peerId, window.location.origin)
    : null;
  const bio = displayProfileBio(
    contact.identityObject?.payload.bio ?? contact.profile?.bio,
    peerId
  );
  const visibleBio = bio?.startsWith('Peer id: ') ? undefined : bio;

  useEffect(() => {
    if (!moreOpen) return;
    const dismissIfOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) {
        setMoreOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.target instanceof Element && event.target.closest('.share-popover')) return;
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismissIfOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissIfOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!settingsOpen && !profilePictureOpen) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSettingsOpen(false);
      setProfilePictureOpen(false);
      settingsTriggerRef.current?.focus();
    };
    window.addEventListener('keydown', dismissOnEscape);
    return () => window.removeEventListener('keydown', dismissOnEscape);
  }, [profilePictureOpen, settingsOpen]);

  useEffect(() => {
    if (!copyStatus) return;
    const timeout = window.setTimeout(() => setCopyStatus(''), 2500);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  const copyValue = async (value: string, successMessage: string) => {
    setMoreOpen(false);
    try {
      await copyTextToClipboard(value);
      setCopyStatus(successMessage);
    } catch {
      setCopyStatus('Clipboard access is unavailable.');
    }
  };

  const renderAvatar = () => {
    const avatar = (
      <IdentityAvatar
        seed={peerId}
        size={AVATAR_SIZES.profile}
        className="profile-main-avatar"
        alt={name ? '' : displayName}
        online={showOnlineIndicator && !isOwnProfile && contact.online === true}
        profilePicture={profilePicture}
      />
    );
    if (!onAvatarClick) return avatar;
    return (
      <button
        className={`profile-avatar-link${profilePictureUrl ? ' has-profile-picture' : ''}`}
        type="button"
        onClick={() => profilePictureUrl ? setProfilePictureOpen(true) : onAvatarClick()}
        aria-label={profilePictureUrl ? `View ${displayName}'s profile picture` : `View ${displayName}'s profile`}
      >
        {avatar}
      </button>
    );
  };

  return (
    <section className={`profile-header card${isOwnProfile ? ' is-own-profile' : ''}`}>
      <div className="profile-cover" aria-hidden="true" />
      <div className="profile-avatar-actions">
        {renderAvatar()}
        <div className="profile-action-buttons">
          {isOwnProfile ? (
            <>
              <PeerProfileQr peerId={peerId} displayName={displayName} open={qrOpen} onOpenChange={setQrOpen} />
              <button
                ref={settingsTriggerRef}
                className="btn secondary profile-settings-trigger"
                type="button"
                onClick={() => setSettingsOpen(true)}
              >
                Profile
              </button>
              <div className="profile-more" ref={moreRef}>
                <button
                  ref={moreTriggerRef}
                  className="profile-icon-button"
                  type="button"
                  aria-label="More profile actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((open) => !open)}
                >
                  <span aria-hidden="true">···</span>
                </button>
                {moreOpen ? (
                  <ProfileMoreMenu
                    peerId={peerId}
                    displayName={displayName}
                    profileUrl={profileUrl}
                    onCopyPeerId={() => void copyValue(peerId, 'Peer ID copied.')}
                    onCopyProfileLink={() => void copyValue(profileUrl ?? '', 'Profile link copied.')}
                    onShare={() => {
                      setMoreOpen(false);
                      shareActionRef.current?.();
                    }}
                  />
                ) : null}
              </div>
            </>
          ) : showActions ? (
            <>
              <button className="profile-icon-button" type="button" aria-label={`Message ${displayName}`} onClick={onMessage}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.5-.8L4 20l1.8-4.1A7.5 7.5 0 1 1 20 11.5Z" />
                </svg>
              </button>
              <PeerProfileQr peerId={peerId} displayName={displayName} open={qrOpen} onOpenChange={setQrOpen} />
              <FollowButton
                peerId={peerId}
                contacts={[contact]}
                onToggleFollow={async () => { await onFollowToggle?.(); }}
                myPeerId={myPeerId}
                className="btn profile-follow-button"
              />
              <div className="profile-more" ref={moreRef}>
                <button
                  ref={moreTriggerRef}
                  className="profile-icon-button"
                  type="button"
                  aria-label="More profile actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((open) => !open)}
                >
                  <span aria-hidden="true">···</span>
                </button>
                {moreOpen ? (
                  <ProfileMoreMenu
                    peerId={peerId}
                    displayName={displayName}
                    profileUrl={profileUrl}
                    onCopyPeerId={() => void copyValue(peerId, 'Peer ID copied.')}
                    onCopyProfileLink={() => void copyValue(profileUrl ?? '', 'Profile link copied.')}
                    onBlock={onBlock ? () => {
                      setMoreOpen(false);
                      onBlock();
                    } : undefined}
                    onShare={() => {
                      setMoreOpen(false);
                      shareActionRef.current?.();
                    }}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <PeerProfileQr peerId={peerId} displayName={displayName} open={qrOpen} onOpenChange={setQrOpen} />
          )}
          {profileUrl ? (
            <SharePopover
              title={displayName}
              description={PROFILE_SHARE_TEXT}
              url={profileUrl}
              ariaLabel={`Share ${displayName}'s profile`}
              avatar={<IdentityAvatar seed={peerId} size={AVATAR_SIZES.sharePreview} alt="" profilePicture={profilePicture} />}
              showTrigger={false}
              containerClassName="profile-share-controller"
              returnFocusRef={moreTriggerRef}
              onTriggerReady={registerShareAction}
              onShareComplete={() => {
                setMoreOpen(false);
                moreTriggerRef.current?.focus();
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="profile-header-details">
        <div className="profile-title-name">
          <strong>{hasDisplayName ? name : `@${handle}`}</strong>
          {hasDisplayName ? <span className="profile-handle">@{handle}</span> : null}
        </div>
        {visibleBio ? <p className="profile-bio">{visibleBio}</p> : null}
        {onOpenRelationships ? (
          <div className="profile-relationship-links" aria-label="Profile relationships">
            <button type="button" onClick={() => onOpenRelationships('following')}>
              <strong>{followingCount ?? '—'}</strong> Following
            </button>
            <button type="button" onClick={() => onOpenRelationships('followers')}>
              <strong>{followerCount ?? '—'}</strong> Followers
            </button>
          </div>
        ) : null}
        {copyStatus ? <p className="profile-copy-status note" role="status">{copyStatus}</p> : null}
      </div>

      {settingsOpen ? (
        <div className="profile-settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <section
            className="profile-settings-dialog card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="profile-settings-close btn secondary"
              type="button"
              aria-label="Close profile settings"
              onClick={() => setSettingsOpen(false)}
            >
              ×
            </button>
            <h2 id="profile-settings-title">Profile settings</h2>
            {profileSettings}
          </section>
        </div>
      ) : null}

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

interface ProfileMoreMenuProps {
  peerId: string;
  displayName: string;
  profileUrl: string | null;
  onCopyPeerId: () => void;
  onCopyProfileLink: () => void;
  onBlock?: () => void;
  onShare: () => void;
}

function ProfileMoreMenu({
  peerId,
  displayName,
  profileUrl,
  onCopyPeerId,
  onCopyProfileLink,
  onBlock,
  onShare
}: ProfileMoreMenuProps) {
  return (
    <div className="profile-more-menu card" role="menu" aria-label="More profile actions">
      <button className="profile-menu-peer-id" type="button" role="menuitem" onClick={onCopyPeerId} aria-label="Copy peer ID">
        <span>Peer ID</span>
        <code>{peerId}</code>
      </button>
      {profileUrl ? (
        <button className="profile-menu-item" type="button" role="menuitem" aria-label={`Share ${displayName}'s profile`} onClick={onShare}>
          Share
        </button>
      ) : null}
      <button className="profile-menu-item" type="button" role="menuitem" aria-label="Copy link to profile" onClick={onCopyProfileLink}>
        Copy link to profile
      </button>
      {onBlock ? (
        <button className="profile-menu-item destructive" type="button" role="menuitem" onClick={onBlock}>
          Block
        </button>
      ) : null}
    </div>
  );
}
