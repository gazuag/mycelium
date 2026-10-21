import type { Contact } from '../types';
import { CompactUsername } from './CompactUsername';
import { IdentityAvatar } from './IdentityAvatar';
import { displayNameOrFallback, fingerprintToHumanName } from '../utils/fingerprintNames';
import { parsePeerId } from '../utils/peerId';

interface PeerRecipientPickerProps {
  contacts: readonly Contact[];
  onSelect: (contact: Contact) => void;
  onViewProfile?: (peerId: string) => void;
  mode: 'message' | 'mention';
  ariaLabel: string;
  emptyMessage?: string;
}

export function relationshipContacts(
  contacts: readonly Contact[],
  myPublicKey: string,
  myPeerId: string
): Contact[] {
  const selfIds = new Set([myPublicKey, myPeerId]);
  const unique = new Map<string, Contact>();
  for (const contact of contacts) {
    if (selfIds.has(contact.publicKey) || selfIds.has(contact.fingerprint)) continue;
    if (!contact.followed && !contact.follower) continue;
    if (!unique.has(contact.publicKey)) unique.set(contact.publicKey, contact);
  }
  return [...unique.values()].sort((left, right) => Number(right.online === true) - Number(left.online === true));
}

export function peerMentionHandle(contact: Contact): string | null {
  const peerId = parsePeerId(contact.fingerprint);
  return peerId ? fingerprintToHumanName(peerId) : null;
}

export function filterPeersByHandlePrefix(contacts: readonly Contact[], prefix: string): Contact[] {
  const normalizedPrefix = prefix.toLocaleLowerCase();
  return contacts.filter((contact) => peerMentionHandle(contact)?.toLocaleLowerCase().startsWith(normalizedPrefix));
}

export function PeerRecipientPicker({
  contacts,
  onSelect,
  onViewProfile,
  mode,
  ariaLabel,
  emptyMessage = 'No people are available.'
}: PeerRecipientPickerProps) {
  if (contacts.length === 0) return <p className="note messages-empty">{emptyMessage}</p>;

  return (
    <div className={`messages-list peer-recipient-picker${mode === 'mention' ? ' mention-suggestions' : ''}`} role="listbox" aria-label={ariaLabel}>
      {contacts.map((contact) => {
        const peerId = contact.fingerprint || contact.publicKey;
        const name = displayNameOrFallback(contact.displayName, peerId);
        const handle = peerMentionHandle(contact);
        const label = mode === 'mention' ? `@${handle ?? name}` : name;
        const identity = (
          <>
            <IdentityAvatar seed={peerId} size={mode === 'mention' ? 32 : 42} alt={name} online={contact.online === true} />
            <span className="message-row-content">
              {mode === 'mention' ? (
                <strong>{label}</strong>
              ) : (
                <strong>
                  <CompactUsername peerId={peerId} displayName={name} onProfileClick={onViewProfile} />
                </strong>
              )}
            </span>
          </>
        );
        const select = () => onSelect(contact);

        return mode === 'mention' ? (
          <button
            className="peer-recipient-option"
            key={contact.publicKey}
            type="button"
            role="option"
            aria-label={`Mention ${handle ?? name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={select}
          >
            {identity}
          </button>
        ) : (
          <div className="message-list-row" key={contact.publicKey}>
            <button
              className="message-list-row-open"
              type="button"
              role="option"
              aria-label={`Start conversation with ${name}`}
              onClick={select}
            />
            {identity}
            <span className="message-row-action" aria-hidden="true">›</span>
          </div>
        );
      })}
    </div>
  );
}
