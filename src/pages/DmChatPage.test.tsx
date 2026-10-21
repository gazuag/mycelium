import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '../object-layer/conversations';
import type { Contact } from '../types';
import type { DmEvents } from '../object-layer/dm-events';
import type { DmObjectIdentity } from '../object-layer/dm-object';
import type { ObjectStore } from '../object-layer/types';

const hookState = vi.hoisted(() => ({
  result: {
    messages: [] as ConversationMessage[],
    loading: false,
    send: vi.fn(async () => ({ status: 'sent', queued: false, keyChanged: false })),
    sending: false,
    canSend: true,
    noKey: false
  }
}));

vi.mock('../hooks/useDmConversation', () => ({
  useDmConversation: () => hookState.result
}));

import {
  DmChatPage,
  isDmDraftSendable,
  queuedDeliveryNote,
  shouldSendOnEnter
} from './DmChatPage';

const contact: Contact = {
  publicKey: 'peer-key',
  fingerprint: 'peer-fingerprint',
  displayName: 'Peer',
  addedAt: '2026-10-01T00:00:00.000Z',
  followed: false,
  online: true,
  encryptionPublicKey: 'trusted-encryption-key'
};

const identity: DmObjectIdentity = {
  id: 'me-id',
  publicKey: 'me-key',
  privateKey: 'private-key',
  encryptionPublicKey: 'my-encryption-key',
  encryptionPrivateKey: 'private-encryption-key'
};

const store: ObjectStore = {
  put: async () => true,
  get: async () => null,
  delete: async () => {},
  query: async () => []
};
const outbox = { get: async () => null };
const events: DmEvents = { onDmArrived: () => () => {}, emitDmArrived: () => {} };

function message(
  objectId: string,
  status: ConversationMessage['status'],
  options: Partial<ConversationMessage> = {}
): ConversationMessage {
  return {
    objectId,
    direction: 'in',
    createdAt: '2026-10-05T12:00:00.000Z',
    status,
    text: status === 'ok' ? 'message text' : null,
    ...options
  };
}

function renderPage(): string {
  return renderToStaticMarkup(
    <DmChatPage
      contact={contact}
      counterparty={contact.publicKey}
      getIdentity={() => identity}
      store={store}
      outbox={outbox}
      resolveSenderEncryptionKey={() => contact.encryptionPublicKey!}
      dmService={{ sendMessage: async () => ({ status: 'invalid', attemptedTo: [], queued: false, keyChanged: false }) }}
      events={events}
      connectionText="Connected"
      myPeerId="me-id"
      onViewProfile={vi.fn()}
      onBackToMessages={vi.fn()}
    />
  );
}

afterEach(() => {
  hookState.result = {
    messages: [],
    loading: false,
  send: vi.fn(async () => ({ status: 'invalid', queued: false, keyChanged: false })),
    sending: false,
    canSend: true,
    noKey: false
  };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DmChatPage', () => {
  it('renders the unverified placeholder instead of message text', () => {
    hookState.result.messages = [message('unverified', 'unverified', { text: null })];
    const markup = renderPage();

    expect(markup.replace(/&#x27;/g, "'")).toContain("Can't verify the sender yet. Connect with them once to exchange encryption keys.");
    expect(markup).not.toContain('ciphertext');
    expect(markup).not.toContain('null');
  });

  it('renders the key-changed warning and keeps message text hidden', () => {
    hookState.result.messages = [message('changed', 'key_changed', { text: null })];
    const markup = renderPage();

    expect(markup.replace(/&#x27;/g, "'")).toContain("This contact's encryption key changed. Verify with them before trusting new messages.");
    expect(markup).not.toContain('ciphertext');
  });

  it('renders the invalid placeholder rather than ciphertext or null text', () => {
    hookState.result.messages = [message('invalid', 'invalid', { text: null })];
    const markup = renderPage();

    expect(markup).toContain('This message could not be opened.');
    expect(markup).not.toContain('ciphertext');
    expect(markup).not.toContain('null');
  });

  it('provides a back-to-inbox control in the conversation header', () => {
    expect(renderPage()).toContain('aria-label="Back to Messages"');
  });

  it('preserves literal @ text in message content', () => {
    hookState.result.messages = [message('literal-at', 'ok', { text: 'Hello @alice' })];
    expect(renderPage()).toContain('Hello @alice');
  });

  it('renders outgoing delivery as Waiting to send or Attempted', () => {
    hookState.result.messages = [
      message('pending', 'ok', { direction: 'out', delivery: 'pending' }),
      message('attempted', 'ok', { direction: 'out', delivery: 'attempted' })
    ];
    const markup = renderPage();

    expect(markup).toContain('Waiting to send');
    expect(markup).toContain('Attempted');
  });

  it('keeps a deleted message in chronological context without revealing its content or sender identity', () => {
    hookState.result.messages = [
      message('before', 'ok', { createdAt: '2026-10-05T11:00:00.000Z', text: 'before message' }),
      message('deleted', 'ok', {
        createdAt: '2026-10-05T12:00:00.000Z',
        direction: 'in',
        deleted: true,
        text: null
      }),
      message('after', 'ok', { createdAt: '2026-10-05T13:00:00.000Z', text: 'after message' })
    ];
    const markup = renderPage();
    const deletedRow = markup.match(/<div class="chat-message-row deleted".*?<\/div><\/div>/)?.[0];

    expect(markup.indexOf('before message')).toBeLessThan(markup.indexOf('[Deleted message]'));
    expect(markup.indexOf('[Deleted message]')).toBeLessThan(markup.indexOf('after message'));
    expect(deletedRow).toContain('[Deleted message]');
    expect(deletedRow).not.toContain('View Peer');
    expect(deletedRow).not.toContain('identity-avatar');
    expect(markup).not.toContain('message text');
  });

  it('renders small profile links for both incoming and outgoing messages', () => {
    hookState.result.messages = [
      message('incoming', 'ok'),
      message('outgoing', 'ok', { direction: 'out', delivery: 'attempted' })
    ];
    const markup = renderPage();

    expect(markup).toContain('aria-label="View Peer&#x27;s profile"');
    expect(markup).toContain('aria-label="View your profile"');
    expect(markup).toContain('width="21" height="21"');
    expect(markup.match(/class="identity-avatar-online"/g)).toHaveLength(1);
    expect(markup).toContain('message text');
  });

  it('disables the compose controls with the missing-key explanation', () => {
    hookState.result.noKey = true;
    hookState.result.canSend = false;
    const markup = renderPage();

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Connect with this peer once to exchange encryption keys before messaging.');
  });

  it('blocks empty and over-limit drafts and displays the 4000-character counter', () => {
    expect(isDmDraftSendable('', true)).toBe(false);
    expect(isDmDraftSendable('x'.repeat(4000), true)).toBe(true);
    expect(isDmDraftSendable('x'.repeat(4001), true)).toBe(false);
    expect(renderPage()).toContain('0/4000');
  });

  it('shows the Markdown formatting guide beside the message composer', () => {
    expect(renderPage()).toContain('class="markdown-help-link"');
  });

  it('sends on Enter but preserves Shift+Enter for a newline', () => {
    expect(shouldSendOnEnter('Enter', false)).toBe(true);
    expect(shouldSendOnEnter('Enter', true)).toBe(false);
    expect(shouldSendOnEnter('a', false)).toBe(false);
  });

  it('does not claim delivery for a queued message', () => {
    expect(queuedDeliveryNote({ status: 'sent', queued: true }))
      .toBe('Queued for retry; delivery is unconfirmed.');
    expect(queuedDeliveryNote({ status: 'sent', queued: false })).toBe('');
    expect(queuedDeliveryNote({ status: 'invalid', queued: true })).toBe('');
  });

  it('does not log or write plaintext, keys, or ciphertext to browser storage', () => {
    const plaintext = 'dm-chat-hygiene-plaintext';
    const encryptionKey = 'dm-chat-hygiene-encryption-key';
    const ciphertext = 'dm-chat-hygiene-ciphertext';
    hookState.result.messages = [message('hygiene', 'ok', { text: plaintext })];
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const indexedDbOpen = vi.spyOn(indexedDB, 'open');
    const storageWrites = vi.fn();
    const storage = {
      length: 0,
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: storageWrites
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);

    const markup = renderPage();

    expect(markup).toContain(plaintext);
    expect(markup).not.toContain(encryptionKey);
    expect(markup).not.toContain(ciphertext);
    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(storageWrites).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
