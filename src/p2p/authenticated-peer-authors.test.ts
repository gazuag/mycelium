import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveFingerprint, exportPrivateKey, exportPublicKey, generateIdentityKeyPair, signString } from '../crypto/identity';
import { findObjectsFromCandidatesByFindQueryPage } from '../object-layer/transport';
import type { DistributedObject } from '../object-layer/types';
import { buildPacket, canonicalize } from './protocol';
import { dispatchAuthenticatedProfileMetadata } from './profile-auth';
import {
  type AuthenticatedPeerAuthorEntry,
  getAuthenticatedConnectedAuthors,
  recordAuthenticatedPeerAuthor,
  removeAuthenticatedPeerAuthor
} from './authenticated-peer-authors';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('authenticated peer authors', () => {
  it('makes an authenticated author available to FIND before contact refs update', async () => {
    const keys = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(keys.publicKey);
    const privateKey = await exportPrivateKey(keys.privateKey);
    const peerId = await deriveFingerprint(publicKey);
    const metadata = {
      author: peerId,
      publicKey,
      displayName: 'Peer',
      following: false,
      timestamp: new Date(0).toISOString(),
      sequence: 1
    };
    const packet = await buildPacket(
      peerId,
      'local-peer',
      'PROFILE_UPDATE',
      { profile: metadata },
      (unsigned) => signString(privateKey, canonicalize(unsigned))
    );
    const manager = { isDataChannelOpen: () => true };
    const peerManagers = { [peerId]: manager };
    const authenticatedManagers = new WeakSet<typeof manager>();
    const authors = new Map<string, AuthenticatedPeerAuthorEntry<typeof manager>>();
    const contactsRef = { current: [] as Array<{ fingerprint: string; publicKey: string }> };

    await expect(dispatchAuthenticatedProfileMetadata(peerId, packet, (authenticatedMetadata) => {
      if (!authenticatedMetadata.publicKey) throw new Error('Authenticated metadata must include its signing key');
      authenticatedManagers.add(manager);
      recordAuthenticatedPeerAuthor(authors, peerId, manager, authenticatedMetadata.publicKey);
    })).resolves.toBe(true);

    expect(contactsRef.current).toEqual([]);
    const connectedAuthors = getAuthenticatedConnectedAuthors(authors, peerManagers, authenticatedManagers);
    const post: DistributedObject = {
      object_id: 'connected-peer-post',
      object_type: 'mycelium.post',
      author: publicKey,
      created_at: new Date().toISOString(),
      payload: {},
      signature: 'test-signature',
      replication_policy: {}
    };

    expect(findObjectsFromCandidatesByFindQueryPage(
      [post],
      { object_type: 'mycelium.post', author_connected: true },
      connectedAuthors
    ).objects).toEqual([post]);
    expect(findObjectsFromCandidatesByFindQueryPage(
      [post],
      { object_type: 'mycelium.post', author_connected: false },
      connectedAuthors
    ).objects).toEqual([]);
    expect(findObjectsFromCandidatesByFindQueryPage(
      [post],
      { object_type: 'mycelium.post' },
      new Set()
    ).objects).toEqual([post]);
  });

  it('ignores disconnected or replaced managers and preserves replacement authentication on stale cleanup', () => {
    const peerId = 'peer-id';
    const publicKey = 'peer-signing-key';
    const oldManager = { isDataChannelOpen: () => true };
    let currentManagerOpen = true;
    const currentManager = { isDataChannelOpen: () => currentManagerOpen };
    const peerManagers = { [peerId]: oldManager };
    const authenticatedManagers = new WeakSet([oldManager, currentManager]);
    const authors = new Map<string, AuthenticatedPeerAuthorEntry<typeof oldManager>>();

    recordAuthenticatedPeerAuthor(authors, peerId, oldManager, publicKey);
    peerManagers[peerId] = currentManager;
    recordAuthenticatedPeerAuthor(authors, peerId, currentManager, publicKey);
    expect(removeAuthenticatedPeerAuthor(authors, peerId, oldManager)).toBe(false);
    expect(getAuthenticatedConnectedAuthors(authors, peerManagers, authenticatedManagers)).toEqual(new Set([publicKey]));

    expect(removeAuthenticatedPeerAuthor(authors, peerId, currentManager)).toBe(true);
    expect(getAuthenticatedConnectedAuthors(authors, peerManagers, authenticatedManagers)).toEqual(new Set());

    recordAuthenticatedPeerAuthor(authors, peerId, currentManager, publicKey);
    currentManagerOpen = false;
    expect(getAuthenticatedConnectedAuthors(authors, peerManagers, authenticatedManagers)).toEqual(new Set());
  });
});
