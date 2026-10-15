import { fingerprintToHumanName } from '../utils/fingerprintNames';

interface PeerNameProps {
  peerId: string;
  displayName?: string;
}

export function PeerName({ peerId, displayName }: PeerNameProps) {
  const handle = fingerprintToHumanName(peerId);
  const name = displayName?.trim();
  const primaryName = name || handle;
  const hasGeneratedHandle = peerId.replace(/[^0-9a-f]/gi, '').length === 16;
  const showHandle = Boolean(name && hasGeneratedHandle && handle && name !== handle);

  return (
    <span className="peer-name">
      <span className="peer-name-primary">{primaryName}</span>
      {showHandle ? <span className="peer-name-handle">@{handle}</span> : null}
    </span>
  );
}
