// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplyNotification } from '../hooks/useReplyUnread';
import type { Contact } from '../types';
import { MessagesPage } from './MessagesPage';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const contact: Contact = {
  publicKey: 'peer-key',
  fingerprint: 'peer-fingerprint',
  displayName: 'Peer',
  addedAt: '',
  followed: true
};

const reply: ReplyNotification = {
  id: 'reply-id',
  parentPostId: 'parent-id',
  replyPostId: 'reply-post-id',
  authorPublicKey: contact.publicKey,
  authorFingerprint: contact.fingerprint,
  createdAt: '2026-10-21T12:00:00.000Z',
  replyContent: '**Reply bold** [link](https://example.com)',
  parentContent: '*Parent italic*',
  read: false
};

describe('MessagesPage Markdown previews', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('renders Markdown in reply and parent post previews', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <MessagesPage
        contacts={[contact]}
        myPublicKey="my-key"
        myPeerId="my-id"
        conversations={[]}
        previews={{}}
        loading={false}
        error={null}
        previewError={null}
        onOpenChat={vi.fn()}
        onViewProfile={vi.fn()}
        replies={[reply]}
      />
    ));

    const repliesTab = container.querySelector<HTMLButtonElement>('[role="tab"]:nth-child(2)');
    await act(async () => repliesTab?.click());

    expect(container.querySelector('.reply-row-body strong')?.textContent).toBe('Reply bold');
    expect(container.querySelector('.reply-row-body .markdown-external-link')?.textContent).toBe('link');
    expect(container.querySelector('.reply-parent-context em')?.textContent).toBe('Parent italic');
  });
});
