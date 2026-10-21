import { describe, expect, it } from 'vitest';
import { fingerprintToHumanName } from './fingerprintNames';
import { createPeerAddUrl } from './peerAddUrl';

describe('createPeerAddUrl', () => {
  it('creates a profile add-link for a valid peer fingerprint', () => {
    const peerId = '2d:8f:e4:f0:12:34:56:78';
    const handle = fingerprintToHumanName(peerId);

    expect(createPeerAddUrl(peerId, 'https://unfilter.ing')).toBe(`https://unfilter.ing/add/${handle}`);
  });

  it('returns null for a peer ID that cannot be represented as a handle', () => {
    expect(createPeerAddUrl('not-a-peer-id', 'https://unfilter.ing')).toBeNull();
  });
});
