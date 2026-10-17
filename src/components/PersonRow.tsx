import type { Contact } from '../types';
import { displayNameOrFallback, shortPeerId } from '../utils/fingerprintNames';
import { IdentityAvatar } from './IdentityAvatar';
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
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint || contact.publicKey);
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
          <IdentityAvatar seed={contact.fingerprint || contact.publicKey} size={40} alt="" online={contact.online === true} />
        </button>
        <span className="person-row-details">
          <strong>
            <CompactUsername
              peerId={contact.fingerprint || contact.publicKey}
              displayName={displayName}
              onProfileClick={onViewProfile}
            />
          </strong>
          <span className="note person-row-identifier" title={contact.fingerprint || contact.publicKey}>
            {shortPeerId(contact.fingerprint || contact.publicKey)}
          </span>
          {contact.profile?.bio ? <span className="person-row-bio">{contact.profile.bio}</span> : null}
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
