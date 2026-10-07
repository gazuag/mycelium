import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PeerCard } from './PeerCard';

describe('PeerCard DM unread badge', () => {
  it('uses the shared unread context instead of a contact message counter', () => {
    const markup = renderToStaticMarkup(
      <PeerCard
        contact={{
          publicKey: 'alice-key',
          fingerprint: 'alice-peer',
          addedAt: '2026-10-01T00:00:00.000Z',
          followed: false
        }}
        myPeerId="me"
        onViewProfile={() => {}}
        onMessage={() => {}}
        onToggleFollow={() => {}}
      />
    );

    expect(markup).not.toContain('new');
  });
});
