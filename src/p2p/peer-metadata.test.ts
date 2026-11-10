import { describe, expect, it, vi } from 'vitest';
import type { Contact, PeerMetadata } from '../types';
import type { AcceptPeerMetadataResult } from '../storage/idb';
import {
  createSequencedPeerMetadata,
  describePeerMetadataPreparationFailure,
  mergeAcceptedPeerMetadataContact,
  recordAcceptedPeerMetadataSequence
} from './peer-metadata';

const metadata: Omit<PeerMetadata, 'sequence'> = {
  author: 'peer-fingerprint',
  publicKey: 'peer-public-key',
  displayName: 'Peer',
  following: false,
  timestamp: '2026-11-09T12:00:00.000Z'
};

function accepted(sequence: number, authenticatedDisplayName: string): Extract<AcceptPeerMetadataResult, { status: 'accepted' }> {
  return {
    status: 'accepted',
    highestSequence: sequence,
    encryptionKeyChanged: false,
    contact: {
      publicKey: 'peer-public-key',
      fingerprint: 'peer-fingerprint',
      addedAt: '2026-11-09T12:00:00.000Z',
      followed: true,
      follower: true,
      authenticatedDisplayName,
      online: true,
      connected: true
    }
  };
}

describe('sequenced peer metadata', () => {
  it('allocates and includes one positive sequence in a metadata snapshot', async () => {
    const allocateSequence = vi.fn(async () => 7);

    await expect(createSequencedPeerMetadata(metadata, allocateSequence)).resolves.toEqual({
      ...metadata,
      sequence: 7
    });
    expect(allocateSequence).toHaveBeenCalledOnce();
  });

  it('fails closed when sequence allocation fails or returns an invalid value', async () => {
    await expect(createSequencedPeerMetadata(metadata, async () => {
      throw new Error('counter unavailable');
    })).rejects.toThrow('counter unavailable');

    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      await expect(createSequencedPeerMetadata(metadata, async () => sequence)).rejects.toThrow(
        'Invalid local profile metadata sequence.'
      );
    }
  });

  it('formats preparation failures with a cause while redacting key material', () => {
    expect(describePeerMetadataPreparationFailure(
      new Error('Local identity is unavailable.')
    )).toBe('Error: Local identity is unavailable.');
    expect(describePeerMetadataPreparationFailure(
      new Error('Local metadata sequence counter is missing or invalid.')
    )).toBe('Error: Local metadata sequence counter is missing or invalid.');
    expect(describePeerMetadataPreparationFailure(
      new Error(`privateKey: ${'A'.repeat(100)}`)
    )).toBe('Error: [redacted key]');
    expect(describePeerMetadataPreparationFailure({ privateKey: 'not an Error' }))
      .toBe('Non-Error rejection (object).');
  });

  it('allows one sequenced snapshot to be reused for multiple recipients', async () => {
    const allocateSequence = vi.fn(async () => 9);
    const snapshot = await createSequencedPeerMetadata(metadata, allocateSequence);
    const send = vi.fn();

    send('recipient-a', snapshot);
    send('recipient-b', snapshot);

    expect(allocateSequence).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toBe(snapshot);
    expect(send.mock.calls[1][1]).toBe(snapshot);
    expect(send.mock.calls[0][1].sequence).toBe(9);
  });

  it('does not apply an accepted result after a newer sequence was recorded', () => {
    const sequenceByKey = new Map<string, number>();
    const contacts: Contact[] = [{
      publicKey: 'peer-public-key',
      fingerprint: 'peer-fingerprint',
      addedAt: '2026-11-09T12:00:00.000Z',
      followed: true,
      displayName: 'Locally chosen name'
    }];

    expect(recordAcceptedPeerMetadataSequence(sequenceByKey, 'peer-public-key', 4)).toBe(true);
    expect(recordAcceptedPeerMetadataSequence(sequenceByKey, 'peer-public-key', 8)).toBe(true);
    expect(recordAcceptedPeerMetadataSequence(sequenceByKey, 'peer-public-key', 4)).toBe(false);

    const delayedOlderResult = mergeAcceptedPeerMetadataContact(
      contacts,
      accepted(4, 'Older remote name'),
      sequenceByKey
    );
    expect(delayedOlderResult).toEqual(contacts);

    const latestResult = mergeAcceptedPeerMetadataContact(
      contacts,
      accepted(8, 'Latest remote name'),
      sequenceByKey
    );
    expect(latestResult).toEqual([{
      ...contacts[0],
      authenticatedDisplayName: 'Latest remote name',
      follower: true,
      webPush: undefined,
      online: true,
      connected: true,
      encryptionPublicKey: undefined,
      encryptionKeyChanged: undefined
    }]);
  });

  it('creates a new contact from an accepted result and preserves identity matching', () => {
    const sequences = new Map([['peer-public-key', 2]]);
    const result = accepted(2, 'Accepted peer');
    expect(mergeAcceptedPeerMetadataContact([], result, sequences)).toEqual([result.contact]);

    expect(mergeAcceptedPeerMetadataContact([
      {
        ...result.contact,
        publicKey: 'different-public-key'
      }
    ], result, sequences)).toHaveLength(1);
  });
});
