import { describe, expect, it } from 'vitest';
import { fingerprintToHumanName } from './fingerprintNames';
import { parseAddPeerInvitePath } from './addPeerInvite';

describe('parseAddPeerInvitePath', () => {
  it('resolves a handle from the add-peer path', () => {
    const handle = fingerprintToHumanName('00:00:00:00:00:00:00:00');

    expect(parseAddPeerInvitePath(`/add/${handle}`)).toEqual({
      handle,
      peerId: '00:00:00:00:00:00:00:00'
    });
  });

  it('accepts encoded handles and optional leading @ signs', () => {
    const handle = fingerprintToHumanName('00:00:00:00:00:00:00:00');

    expect(parseAddPeerInvitePath(`/add/%40${handle}`)).toEqual({
      handle,
      peerId: '00:00:00:00:00:00:00:00'
    });
  });

  it('returns an invalid target for malformed handles and null for other paths', () => {
    expect(parseAddPeerInvitePath('/add/not-a-valid-handle')).toEqual({
      handle: 'not-a-valid-handle',
      peerId: null
    });
    expect(parseAddPeerInvitePath('/')).toBeNull();
    expect(parseAddPeerInvitePath('/profile/PeerHandle')).toBeNull();
  });
});
