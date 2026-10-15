import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../object-layer/conversations';
import type { Contact } from '../types';

const unreadState = vi.hoisted(() => ({ byContact: {} as Record<string, number> }));
vi.mock('../hooks/useDmUnread', () => ({
  useDmUnread: () => ({ total: 0, byContact: unreadState.byContact, markRead: async () => {} })
}));

import {
  conversationMatchesSearch,
  MessagesPage,
  relationshipContacts
} from './MessagesPage';

const alice: Contact = {
  publicKey: 'alice-public-key',
  fingerprint: 'alice-fingerprint',
  displayName: 'Alice',
  addedAt: '',
  followed: true,
  follower: true,
  online: true
};

const bob: Contact = {
  publicKey: 'bob-public-key',
  fingerprint: 'bob-fingerprint',
  displayName: 'Bob',
  addedAt: '',
  followed: false,
  follower: true
};

function summary(counterparty: string, lastAt: string, lastDirection: 'in' | 'out' = 'in'): ConversationSummary {
  return {
    counterparty,
    lastAt,
    lastObjectId: `${counterparty}-latest`,
    lastDirection,
    count: 1
  };
}

describe('MessagesPage', () => {
  it('combines followed and follower contacts, deduplicates peers, and excludes the current user', () => {
    const duplicateAlice = { ...alice, followed: false, follower: true };
    const self: Contact = {
      publicKey: 'my-public-key',
      fingerprint: 'my-peer-id',
      addedAt: '',
      followed: true
    };

    const result = relationshipContacts([bob, duplicateAlice, alice, self], 'my-public-key', 'my-peer-id');
    expect(result.map((contact) => contact.publicKey)).toEqual([alice.publicKey, bob.publicKey]);
    expect(result[0].online).toBe(true);
  });

  it('filters conversations by participant identity or a locally decrypted latest-message preview', () => {
    const conversation = summary(alice.publicKey, '2026-10-14T12:00:00.000Z');
    expect(conversationMatchesSearch(conversation, alice, 'ali')).toBe(true);
    expect(conversationMatchesSearch(conversation, alice, 'alice-finger')).toBe(true);
    expect(conversationMatchesSearch(conversation, alice, 'alice-public')).toBe(true);
    expect(conversationMatchesSearch(conversation, alice, 'latest private note', 'A latest private note')).toBe(true);
    expect(conversationMatchesSearch(conversation, alice, 'latest private note')).toBe(false);
  });

  it('renders conversations in recent-first order with per-chat unread indicators', () => {
    unreadState.byContact = { [alice.publicKey]: 1 };
    const markup = renderToStaticMarkup(
      <MessagesPage
        contacts={[alice, bob]}
        myPublicKey="my-public-key"
        myPeerId="my-peer-id"
        conversations={[
          summary(alice.publicKey, '2026-10-14T12:00:00.000Z'),
          summary(bob.publicKey, '2026-10-13T12:00:00.000Z', 'out')
        ]}
        previews={{ [bob.publicKey]: 'Latest message preview' }}
        loading={false}
        error={null}
        previewError={null}
        onOpenChat={() => {}}
      />
    );

    expect(markup.indexOf('Alice')).toBeLessThan(markup.indexOf('Bob'));
    expect(markup.match(/class="message-unread-dot"/g)).toHaveLength(1);
    expect(markup.match(/class="identity-avatar-online"/g)).toHaveLength(1);
    expect(markup).toContain('Received a message');
    expect(markup).toContain('Latest message preview');
    expect(markup).toContain('New message');
  });

  it('shows a local search empty state and does not render plaintext search results', () => {
    const markup = renderToStaticMarkup(
      <MessagesPage
        contacts={[alice]}
        myPublicKey="my-public-key"
        myPeerId="my-peer-id"
        conversations={[]}
        previews={{}}
        loading={false}
        error={null}
        previewError={null}
        onOpenChat={() => {}}
      />
    );
    expect(markup).toContain('Search conversations or messages');
    expect(markup).toContain('Your conversations will appear here.');
  });
});
