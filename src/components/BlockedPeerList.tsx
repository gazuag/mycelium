import { IdentityAvatar } from './IdentityAvatar';
import { fingerprintToHumanName } from '../utils/fingerprintNames';

interface BlockedPeerListProps {
  peerIds: string[];
  onUnblock: (peerId: string) => void;
}

export function BlockedPeerList({ peerIds, onUnblock }: BlockedPeerListProps) {
  if (peerIds.length === 0) {
    return <p className="note">No blocked peers yet.</p>;
  }

  return (
    <div className="blocked-peer-list">
      {peerIds.map((peerId) => (
        <div key={peerId} className="blocked-peer-item">
          <div className="peer-card-main">
            <IdentityAvatar seed={peerId} size={32} alt={fingerprintToHumanName(peerId)} />
            <div className="peer-label-block">
              <strong>{fingerprintToHumanName(peerId)}</strong>
              <span className="note monospace">{peerId}</span>
            </div>
          </div>
          <button className="chip secondary" type="button" onClick={() => onUnblock(peerId)}>Unblock</button>
        </div>
      ))}
    </div>
  );
}
