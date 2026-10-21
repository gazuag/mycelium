import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Contact } from '../types';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { filterPeersByHandlePrefix, PeerRecipientPicker, peerMentionHandle, relationshipContacts } from './PeerRecipientPicker';

function contact(publicKey: string, fingerprint: string): Contact {
  return { publicKey, fingerprint, addedAt: '', followed: true };
}

describe('peer mention recipient selection', () => {
  it('uses deterministic handles and filters by a case-insensitive prefix, including partial handles', () => {
    const first = contact('first-key', '00:00:00:00:00:00:00:01');
    const second = contact('second-key', '00:00:00:00:00:00:00:02');
    const firstHandle = peerMentionHandle(first)!;
    expect(firstHandle).toBe(fingerprintToHumanName(first.fingerprint));
    expect(filterPeersByHandlePrefix([first, second], firstHandle)).toEqual([first]);
    expect(filterPeersByHandlePrefix([first, second], firstHandle.slice(0, 2))).toContain(first);
    expect(filterPeersByHandlePrefix([first], firstHandle.slice(0, 2).toLowerCase())).toEqual([first]);
  });

  it('reuses the message-recipient relationship selection and excludes self and unconnected contacts', () => {
    const followed = contact('followed-key', '00:00:00:00:00:00:00:03');
    const follower = { ...contact('follower-key', '00:00:00:00:00:00:00:04'), followed: false, follower: true };
    const unrelated = { ...contact('unrelated-key', '00:00:00:00:00:00:00:05'), followed: false, follower: false };
    const self = contact('my-key', 'my-peer-id');
    expect(relationshipContacts([followed, follower, unrelated, self], 'my-key', 'my-peer-id'))
      .toEqual([followed, follower]);
  });

  it('renders mention choices as selectable deterministic @handles', () => {
    const peer = contact('peer-key', '00:00:00:00:00:00:00:06');
    const markup = renderToStaticMarkup(
      <PeerRecipientPicker
        contacts={[peer]}
        mode="mention"
        ariaLabel="Mention a peer"
        onSelect={() => {}}
      />
    );
    expect(markup).toContain('role="listbox" aria-label="Mention a peer"');
    expect(markup).toContain(`@${peerMentionHandle(peer)}`);
    expect(markup).toContain('role="option"');
  });
});
