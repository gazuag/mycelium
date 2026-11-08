import type { Contact } from '../types';
import { displayNameOrFallback, displayProfileBio, resolvePeerDisplayName } from '../utils/fingerprintNames';
import { AVATAR_SIZES, IdentityAvatar } from './IdentityAvatar';
import { CompactUsername } from './CompactUsername';

interface PersonRowProps {
  contact: Contact;
  onViewProfile: (peerId: string) => void;
  actionLabel?: string;
  onAction?: () => void;
  mutualLabel?: string;
  metric?: string;
}

export function PersonRow({ contact, onViewProfile, actionLabel, onAction, mutualLabel, metric }: PersonRowProps) {
  const displayName = displayNameOrFallback(
    resolvePeerDisplayName(
      contact.identityObject?.payload.display_name,
      contact.authenticatedDisplayName
    ) ?? contact.displayName,
    contact.fingerprint || contact.publicKey
  );
  const bio = displayProfileBio(
    contact.identityObject?.payload.bio ?? contact.profile?.bio,
    contact.fingerprint || contact.publicKey
  );
  const lastSeen = contact.lastSeen && Number.isFinite(Date.parse(contact.lastSeen))
    ? new Date(contact.lastSeen).toLocaleString()
    : undefined;

  return (
    <article className="person-row">
      <div className="person-row-profile">
        <button
          className="person-row-avatar-button"
          type="button"
          onClick={() => onViewProfile(contact.fingerprint || contact.publicKey)}
          aria-label={`View ${displayName}'s profile`}
        >
          <IdentityAvatar seed={contact.fingerprint || contact.publicKey} size={AVATAR_SIZES.person} alt="" online={contact.online === true} profilePicture={contact.profilePicture ?? contact.identityObject?.payload.profile_picture} />
        </button>
        <span className="person-row-details">
          <strong>
            <CompactUsername
              peerId={contact.fingerprint || contact.publicKey}
              displayName={displayName}
              onProfileClick={onViewProfile}
            />
          </strong>
          {bio ? <span className="person-row-bio">{bio}</span> : null}
          {mutualLabel ? <span className="person-row-mutual">{mutualLabel}</span> : null}
          {metric ? <span className="person-row-metric">{metric}</span> : null}
          {contact.online === true ? <span className="person-row-status online">Online</span> : null}
          {contact.online === false && lastSeen ? <span className="person-row-status">Last seen {lastSeen}</span> : null}
        </span>
      </div>
      {actionLabel && onAction ? (
        <button className="person-row-action" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </article>
  );
}
