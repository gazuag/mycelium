import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveFingerprint, exportPrivateKey, exportPublicKey, generateIdentityKeyPair, signString } from '../crypto/identity';
import type { PeerMetadata } from '../types';
import { buildPacket, canonicalize } from './protocol';
import {
  authenticateProfileMetadata,
  authenticateProfileMetadataWithDiagnostics,
  dispatchAuthenticatedProfileMetadata
} from './profile-auth';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const recipient = 'recipient';

async function createSignedProfileUpdate(
  overrides: Partial<PeerMetadata> = {},
  sender?: string,
  packetType: 'PROFILE_UPDATE' | 'PROFILE_RESPONSE' = 'PROFILE_UPDATE'
) {
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
    sequence: 1,
    ...overrides
  };
  const packet = await buildPacket(
    sender ?? peerId,
    recipient,
    packetType,
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

  it('accepts a valid positive sequence for profile responses', async () => {
    const { packet, peerId, metadata } = await createSignedProfileUpdate({}, undefined, 'PROFILE_RESPONSE');

    await expect(authenticateProfileMetadata(peerId, packet)).resolves.toEqual(metadata);
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['non-finite', Number.POSITIVE_INFINITY],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1]
  ])('rejects a %s sequence value', async (_label, sequence) => {
    const { packet, peerId } = await createSignedProfileUpdate({ sequence });

    await expect(authenticateProfileMetadata(peerId, packet)).resolves.toBeNull();
  });

  it('rejects a packet whose signed sequence is changed after signing', async () => {
    const { packet, peerId, metadata } = await createSignedProfileUpdate();
    const tampered = {
      ...packet,
      payload: { profile: { ...metadata, sequence: metadata.sequence + 1 } }
    };

    await expect(authenticateProfileMetadata(peerId, tampered)).resolves.toBeNull();
    await expect(authenticateProfileMetadataWithDiagnostics(peerId, tampered)).resolves.toMatchObject({
      metadata: null,
      failure: 'invalid-signature'
    });
  });

  it('rejects a profile update with an invalid packet signature', async () => {
    const { packet, peerId } = await createSignedProfileUpdate();
    const invalidSignature = btoa(String.fromCharCode(...new Uint8Array(64)));

    await expect(authenticateProfileMetadata(peerId, {
      ...packet,
      signature: invalidSignature
    })).resolves.toBeNull();
    await expect(authenticateProfileMetadataWithDiagnostics(peerId, {
      ...packet,
      signature: invalidSignature
    })).resolves.toMatchObject({ metadata: null, failure: 'invalid-signature' });
  });

  it('rejects a validly signed profile update when the public-key fingerprint differs from the peer ID', async () => {
    const remotePeerId = '00:00:00:00:00:00:00:00';
    const { packet, peerId } = await createSignedProfileUpdate({}, remotePeerId);

    await expect(authenticateProfileMetadata(remotePeerId, packet)).resolves.toBeNull();
    await expect(authenticateProfileMetadataWithDiagnostics(remotePeerId, packet)).resolves.toMatchObject({
      metadata: null,
      failure: 'public-key-fingerprint-mismatch'
    });
    expect(packet.sender).toBe(remotePeerId);
    expect(peerId).not.toBe(remotePeerId);
  });

  it('reports a missing sequence without accepting the profile', async () => {
    const { packet, peerId } = await createSignedProfileUpdate({ sequence: undefined });

    await expect(authenticateProfileMetadataWithDiagnostics(peerId, packet)).resolves.toMatchObject({
      metadata: null,
      failure: 'missing-or-invalid-sequence'
    });
  });

  it('reports malformed public keys separately from invalid signatures', async () => {
    const { packet, peerId, metadata } = await createSignedProfileUpdate();
    const malformedKeyPacket = {
      ...packet,
      payload: { profile: { ...metadata, publicKey: 'not-a-public-key' } }
    };

    await expect(authenticateProfileMetadataWithDiagnostics(peerId, malformedKeyPacket)).resolves.toMatchObject({
      metadata: null,
      failure: 'invalid-public-key'
    });
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

  it('reports a safe rejection reason to the caller', async () => {
    const { packet, peerId } = await createSignedProfileUpdate({ sequence: undefined });
    const onRejected = vi.fn();

    await expect(dispatchAuthenticatedProfileMetadata(peerId, packet, vi.fn(), onRejected)).resolves.toBe(false);
    expect(onRejected).toHaveBeenCalledWith('missing-or-invalid-sequence');
  });

  it('does not pass legacy unsequenced metadata to profile updates', async () => {
    const { packet, peerId, metadata } = await createSignedProfileUpdate({ sequence: undefined });
    const updatePeerProfile = vi.fn();

    await expect(authenticateProfileMetadata(peerId, packet)).resolves.toBeNull();
    await expect(dispatchAuthenticatedProfileMetadata(
      peerId,
      packet,
      updatePeerProfile
    )).resolves.toBe(false);
    expect(updatePeerProfile).not.toHaveBeenCalled();
    expect(metadata.sequence).toBeUndefined();
  });

  it('accepts a well-formed Web Push capability in an authenticated profile update', async () => {
    const capability = {
      endpoint: 'https://push.example.test/subscription/1',
      p256dh: 'public-key',
      auth: 'auth-secret'
    };
    const { metadata, packet, peerId } = await createSignedProfileUpdate({ webPush: capability });

    await expect(authenticateProfileMetadata(peerId, packet)).resolves.toEqual(metadata);
  });

  it('passes authenticated capability updates and omissions through for storage and clearing', async () => {
    const capability = {
      endpoint: 'https://push.example.test/subscription/1',
      p256dh: 'public-key',
      auth: 'auth-secret'
    };
    const receivedCapabilityUpdates: Array<PeerMetadata['webPush']> = [];
    const onAuthenticated = vi.fn((metadata: PeerMetadata) => {
      receivedCapabilityUpdates.push(metadata.webPush);
    });
    const withCapability = await createSignedProfileUpdate({ webPush: capability });
    const withoutCapability = await createSignedProfileUpdate();

    await expect(dispatchAuthenticatedProfileMetadata(
      withCapability.peerId,
      withCapability.packet,
      onAuthenticated
    )).resolves.toBe(true);
    await expect(dispatchAuthenticatedProfileMetadata(
      withoutCapability.peerId,
      withoutCapability.packet,
      onAuthenticated
    )).resolves.toBe(true);

    expect(receivedCapabilityUpdates).toEqual([capability, undefined]);
  });

  it('rejects malformed Web Push capability metadata before it reaches profile persistence', async () => {
    const { packet, peerId } = await createSignedProfileUpdate({
      webPush: {
        endpoint: 'http://push.example.test/subscription/1',
        p256dh: '',
        auth: 'auth-secret'
      }
    });
    const updatePeerProfile = vi.fn();

    await expect(dispatchAuthenticatedProfileMetadata(peerId, packet, updatePeerProfile)).resolves.toBe(false);
    expect(updatePeerProfile).not.toHaveBeenCalled();
  });

  it('does not let an authenticated profile response publish a Web Push capability', async () => {
    const { packet, peerId } = await createSignedProfileUpdate({
      webPush: {
        endpoint: 'https://push.example.test/subscription/1',
        p256dh: 'public-key',
        auth: 'auth-secret'
      }
    });
    const responsePacket = { ...packet, type: 'PROFILE_RESPONSE' as const };

    await expect(authenticateProfileMetadata(peerId, responsePacket)).resolves.toBeNull();
  });
});
