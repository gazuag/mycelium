import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveFingerprint, exportPrivateKey, exportPublicKey, generateIdentityKeyPair, signString } from '../crypto/identity';
import type { PeerMetadata } from '../types';
import { buildPacket, canonicalize } from './protocol';
import { authenticateProfileMetadata, dispatchAuthenticatedProfileMetadata } from './profile-auth';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const recipient = 'recipient';

async function createSignedProfileUpdate(overrides: Partial<PeerMetadata> = {}, sender?: string) {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  const peerId = await deriveFingerprint(publicKey);
  const metadata: PeerMetadata = {
    author: peerId,
    publicKey,
    displayName: 'Peer',
    following: false,
    timestamp: new Date(0).toISOString(),
    ...overrides
  };
  const packet = await buildPacket(
    sender ?? peerId,
    recipient,
    'PROFILE_UPDATE',
    { profile: metadata },
    (unsigned) => signString(privateKey, canonicalize(unsigned))
  );
  return { metadata, packet, peerId };
}

describe('profile metadata authentication', () => {
  it('accepts a valid signed profile update whose public-key fingerprint matches its peer ID', async () => {
    const { metadata, packet, peerId } = await createSignedProfileUpdate();

    await expect(authenticateProfileMetadata(peerId, packet)).resolves.toEqual(metadata);
  });

  it('rejects a profile update with an invalid packet signature', async () => {
    const { packet, peerId } = await createSignedProfileUpdate();

    await expect(authenticateProfileMetadata(peerId, {
      ...packet,
      signature: 'invalid-signature'
    })).resolves.toBeNull();
  });

  it('rejects a validly signed profile update when the public-key fingerprint differs from the peer ID', async () => {
    const remotePeerId = '00:00:00:00:00:00:00:00';
    const { packet, peerId } = await createSignedProfileUpdate({}, remotePeerId);

    await expect(authenticateProfileMetadata(remotePeerId, packet)).resolves.toBeNull();
    expect(packet.sender).toBe(remotePeerId);
    expect(peerId).not.toBe(remotePeerId);
  });

  it('does not pass rejected metadata to the profile update handler', async () => {
    const remotePeerId = '00:00:00:00:00:00:00:00';
    const { packet } = await createSignedProfileUpdate({}, remotePeerId);
    const updatePeerProfile = vi.fn();

    await expect(dispatchAuthenticatedProfileMetadata(
      remotePeerId,
      packet,
      updatePeerProfile
    )).resolves.toBe(false);

    expect(updatePeerProfile).not.toHaveBeenCalled();
  });
});
