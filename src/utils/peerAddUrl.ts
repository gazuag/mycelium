import { fingerprintToHumanName } from './fingerprintNames';
import { parsePeerId } from './peerId';

export function createPeerAddUrl(peerId: string, origin: string): string | null {
  const normalizedPeerId = parsePeerId(peerId);
  if (!normalizedPeerId) return null;

  const handle = fingerprintToHumanName(normalizedPeerId);
  if (parsePeerId(handle) !== normalizedPeerId) return null;

  return new URL(`/add/${encodeURIComponent(handle)}`, origin).toString();
}
