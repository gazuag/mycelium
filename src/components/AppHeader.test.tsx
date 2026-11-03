import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Contact } from '../types';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { AppHeader } from './AppHeader';

const peerId = 'aa:bb:cc:dd:ee:ff:00:11';

function renderHeader(contacts: Contact[]) {
  return renderToStaticMarkup(
    <AppHeader
      collapsed={false}
      onToggleCollapse={() => {}}
      connectionStatus="connected"
      signallingStatus="connected"
      connectedPeers={1}
      connectedPeerIds={[peerId]}
      contacts={contacts}
      syncStatus="synced"
      onPeerProfileClick={() => {}}
      onHomeClick={() => {}}
    />
  );
}

describe('AppHeader connected peer names', () => {
  it('uses authenticated metadata when the signed identity profile is missing', () => {
    const contact: Contact = {
      publicKey: peerId,
      fingerprint: peerId,
      authenticatedDisplayName: 'Metadata name',
      addedAt: new Date(0).toISOString(),
      followed: false
    };

    expect(renderHeader([contact])).toContain('Metadata name');
  });

  it('falls back to the generated handle when no display name is available', () => {
    const markup = renderHeader([]);
    expect(markup).toContain(`class="peer-name-primary">${fingerprintToHumanName(peerId)}</span>`);
  });
});
