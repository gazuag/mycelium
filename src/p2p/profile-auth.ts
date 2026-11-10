import { deriveFingerprint, importPublicKey, verifySignedString } from '../crypto/identity';
import type { PeerMetadata } from '../types';
import { isWebPushCapability } from '../services/web-push';
import { canonicalize, isMyceliumPacket, type MyceliumPacket } from './protocol';

export type ProfileMetadataAuthenticationResult =
  | { metadata: PeerMetadata; failure?: never }
  | { metadata: null; failure: string };

export async function authenticateProfileMetadataWithDiagnostics(
  peerId: string,
  packet: MyceliumPacket | undefined
): Promise<ProfileMetadataAuthenticationResult> {
  if (!packet || !isMyceliumPacket(packet)) {
    return { metadata: null, failure: 'malformed-packet' };
  }
  if (packet.type !== 'PROFILE_UPDATE' && packet.type !== 'PROFILE_RESPONSE') {
    return { metadata: null, failure: 'unsupported-packet-type' };
  }
  if (packet.sender !== peerId) return { metadata: null, failure: 'sender-mismatch' };

  const metadata = packet.payload.profile ?? packet.payload.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { metadata: null, failure: 'missing-profile-metadata' };
  }
  const publicKey = (metadata as Partial<PeerMetadata>).publicKey;
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    return { metadata: null, failure: 'missing-public-key' };
  }
  const candidate = metadata as Partial<PeerMetadata>;
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence ?? 0) < 1) {
    return { metadata: null, failure: 'missing-or-invalid-sequence' };
  }
  if (candidate.webPush !== undefined
    && (packet.type !== 'PROFILE_UPDATE' || !isWebPushCapability(candidate.webPush))) {
    return { metadata: null, failure: 'invalid-web-push-capability' };
  }

  try {
    await importPublicKey(publicKey);
  } catch {
    return { metadata: null, failure: 'invalid-public-key' };
  }

  let signatureBytes: string;
  try {
    signatureBytes = atob(packet.signature);
  } catch {
    return { metadata: null, failure: 'malformed-signature' };
  }
  if (signatureBytes.length !== 64) return { metadata: null, failure: 'malformed-signature' };

  const { signature: packetSignature, ...unsignedPacket } = packet;
  let signatureValid: boolean;
  try {
    signatureValid = await verifySignedString(publicKey, canonicalize(unsignedPacket), packetSignature);
  } catch {
    return { metadata: null, failure: 'signature-verification-error' };
  }
  if (!signatureValid) return { metadata: null, failure: 'invalid-signature' };

  let fingerprint: string;
  try {
    fingerprint = await deriveFingerprint(publicKey);
  } catch {
    return { metadata: null, failure: 'invalid-public-key' };
  }
  if (fingerprint !== peerId) return { metadata: null, failure: 'public-key-fingerprint-mismatch' };

  return { metadata: metadata as PeerMetadata };
}

export async function authenticateProfileMetadata(
  peerId: string,
  packet: MyceliumPacket | undefined
): Promise<PeerMetadata | null> {
  const result = await authenticateProfileMetadataWithDiagnostics(peerId, packet);
  return result.metadata;
}

export async function dispatchAuthenticatedProfileMetadata(
  peerId: string,
  packet: MyceliumPacket | undefined,
  onAuthenticated: (metadata: PeerMetadata) => void | Promise<void>,
  onRejected?: (failure: string) => void
): Promise<boolean> {
  const result = await authenticateProfileMetadataWithDiagnostics(peerId, packet);
  if (!result.metadata) {
    onRejected?.(result.failure);
    return false;
  }
  await onAuthenticated(result.metadata);
  return true;
}
