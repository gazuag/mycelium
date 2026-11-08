import { AVATAR_SIZES, IdentityAvatar } from './IdentityAvatar';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { CompactUsername } from './CompactUsername';
import type { Contact } from '../types';

interface BlockedPeerListProps {
  peerIds: string[];
  contacts?: readonly Contact[];
  onUnblock: (peerId: string) => void;
  onViewProfile?: (peerId: string) => void;
}

export function BlockedPeerList({ peerIds, contacts = [], onUnblock, onViewProfile }: BlockedPeerListProps) {
  if (peerIds.length === 0) {
    return <p className="note">No blocked peers yet.</p>;
  }

  return (
    <div className="blocked-peer-list">
      {peerIds.map((peerId) => {
        const contact = contacts.find((candidate) =>
          candidate.fingerprint === peerId || candidate.publicKey === peerId
        );
        return (
          <div key={peerId} className="blocked-peer-item">
            <div className="peer-card-main">
              <IdentityAvatar
                seed={peerId}
                size={AVATAR_SIZES.person}
                alt={fingerprintToHumanName(peerId)}
                profilePicture={contact?.profilePicture ?? contact?.identityObject?.payload.profile_picture}
              />
              <div className="peer-label-block">
                <strong>
                  <CompactUsername
                    peerId={peerId}
                    onProfileClick={onViewProfile}
                  />
                </strong>
              </div>
            </div>
            <button className="chip secondary" type="button" onClick={() => onUnblock(peerId)}>Unblock</button>
          </div>
        );
      })}
    </div>
  );
}
