import { deriveFingerprint, verifySignedString } from '../crypto/identity';
import type { PeerMetadata } from '../types';
import { isWebPushCapability } from '../services/web-push';
import { canonicalize, isMyceliumPacket, type MyceliumPacket } from './protocol';

export async function authenticateProfileMetadata(
  peerId: string,
  packet: MyceliumPacket | undefined
): Promise<PeerMetadata | null> {
  if (!packet
    || !isMyceliumPacket(packet)
    || (packet.type !== 'PROFILE_UPDATE' && packet.type !== 'PROFILE_RESPONSE')
    || packet.sender !== peerId) {
    return null;
  }

  const metadata = packet.payload.profile ?? packet.payload.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const publicKey = (metadata as Partial<PeerMetadata>).publicKey;
  if (typeof publicKey !== 'string' || !publicKey.trim()) return null;
  const candidate = metadata as Partial<PeerMetadata>;
  if (candidate.webPush !== undefined
    && (packet.type !== 'PROFILE_UPDATE' || !isWebPushCapability(candidate.webPush))) return null;

  const { signature, ...unsignedPacket } = packet;
  try {
    if (!(await verifySignedString(publicKey, canonicalize(unsignedPacket), signature))) return null;
    if (await deriveFingerprint(publicKey) !== peerId) return null;
  } catch {
    return null;
  }

  return metadata as PeerMetadata;
}

export async function dispatchAuthenticatedProfileMetadata(
  peerId: string,
  packet: MyceliumPacket | undefined,
  onAuthenticated: (metadata: PeerMetadata) => void | Promise<void>
): Promise<boolean> {
  const metadata = await authenticateProfileMetadata(peerId, packet);
  if (!metadata) return false;
  await onAuthenticated(metadata);
  return true;
}
