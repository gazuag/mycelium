import { useMemo } from 'react';
import type { Contact } from '../types';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface FollowButtonProps {
  peerId: string;
  contacts: Contact[];
  onToggleFollow: (peerId: string) => Promise<void> | void;
  className?: string;
  myPeerId?: string;
}

export function FollowButton({ peerId, contacts, onToggleFollow, className = 'chip', myPeerId }: FollowButtonProps) {
  const match = useMemo(
    () => contacts.find((contact) => contact.publicKey === peerId || contact.fingerprint === peerId),
    [contacts, peerId]
  );
  const isFollowing = Boolean(match?.followed);
  const displayName = useMemo(() => {
    if (!match) {
      return displayNameOrFallback(undefined, peerId);
    }
    return displayNameOrFallback(match.displayName, match.fingerprint || match.publicKey || peerId);
  }, [match, peerId]);

  const handleClick = async () => {
    await onToggleFollow(peerId);
  };

  const isOwnPeer = Boolean(
    myPeerId && (
      peerId === myPeerId
      || peerId === myPeerId.toLowerCase()
      || match?.publicKey === myPeerId
      || match?.fingerprint === myPeerId
    )
  );

  if (isOwnPeer) {
    return null;
  }

  return (
    <div className="follow-button-wrap">
      <button
        className={className}
        type="button"
        onClick={() => { void handleClick(); }}
      >
        {isFollowing ? 'Unfollow' : 'Follow'}
      </button>
    </div>
  );
}
