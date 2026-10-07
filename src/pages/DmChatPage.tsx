import { useEffect, useRef, useState } from 'react';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import type { Contact } from '../types';
import type { DmEvents } from '../object-layer/dm-events';
import type { DmObjectIdentity } from '../object-layer/dm-object';
import type { DmConversationOutbox, DmConversationService } from '../hooks/useDmConversation';
import { useDmConversation } from '../hooks/useDmConversation';
import type { SenderEncryptionKeyResolver } from '../object-layer/dm-inbox';
import type { ObjectStore } from '../object-layer/types';

const MAX_MESSAGE_LENGTH = 4000;

export interface DmChatPageProps {
  contact: Contact;
  counterparty: string;
  getIdentity: () => DmObjectIdentity | null;
  store: ObjectStore;
  outbox: DmConversationOutbox;
  resolveSenderEncryptionKey: SenderEncryptionKeyResolver;
  dmService: DmConversationService | null;
  events: DmEvents;
  isContactKnown?: (publicKey: string) => boolean;
  connectionText: string;
}

export function shouldSendOnEnter(key: string, shiftKey: boolean): boolean {
  return key === 'Enter' && !shiftKey;
}

export function isDmDraftSendable(text: string, canSend: boolean): boolean {
  return canSend && text.trim().length > 0 && text.length <= MAX_MESSAGE_LENGTH;
}

export function queuedDeliveryNote(result: { status: string; queued: boolean }): string {
  return result.status === 'sent' && result.queued
    ? 'Will be delivered when they come online.'
    : '';
}

export function DmChatPage({
  contact,
  counterparty,
  getIdentity,
  store,
  outbox,
  resolveSenderEncryptionKey,
  dmService,
  events,
  isContactKnown,
  connectionText
}: DmChatPageProps) {
  const { messages, loading, send, sending, canSend, noKey } = useDmConversation({
    counterparty,
    getIdentity,
    store,
    outbox,
    resolveSenderEncryptionKey,
    dmService,
    events,
    isContactKnown
  });
  const [draft, setDraft] = useState('');
  const [offlineNote, setOfflineNote] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  useEffect(() => {
    setDraft('');
    setOfflineNote('');
  }, [counterparty]);

  const submit = async () => {
    if (!isDmDraftSendable(draft, canSend) || sending) return;
    const result = await send(draft);
    setDraft('');
    setOfflineNote(queuedDeliveryNote(result));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSendOnEnter(event.key, event.shiftKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="chat-page dm-chat-page">
      <div className="chat-header">
        <span className="chat-header-title">Chat with {displayName}</span>
        <span className="chat-header-status">{connectionText}</span>
      </div>

      <div className="chat-message-list" ref={listRef} aria-live="polite">
        {loading && <p className="chat-empty">Loading messages…</p>}
        {!loading && messages.length === 0 && <p className="chat-empty">No messages yet.</p>}
        {messages.map((message) => (
          <div
            className={`chat-bubble ${message.direction === 'out' ? 'mine' : 'theirs'}`}
            key={message.objectId}
          >
            {message.status === 'ok' && message.text !== null
              ? <p>{message.text}</p>
              : <p className={`dm-message-placeholder ${message.status}`}>
                  {message.status === 'unverified'
                    ? "Can't verify the sender yet. Connect with them once to exchange encryption keys."
                    : message.status === 'key_changed'
                      ? "This contact's encryption key changed. Verify with them before trusting new messages."
                      : 'This message could not be opened.'}
                </p>}
            <span className="chat-timestamp">
              {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {message.direction === 'out' && message.delivery && (
                <> · {message.delivery === 'pending' ? 'Waiting to send' : 'Sent'}</>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="chat-input-row dm-compose">
        <div className="dm-compose-main">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setOfflineNote('');
            }}
            onKeyDown={handleKeyDown}
            placeholder={noKey ? 'Connect to exchange encryption keys' : 'Message…'}
            autoComplete="off"
            disabled={!canSend}
            aria-label="Message"
          />
          <span className={draft.length > MAX_MESSAGE_LENGTH ? 'dm-character-count over-limit' : 'dm-character-count'}>
            {draft.length}/{MAX_MESSAGE_LENGTH}
          </span>
        </div>
        <button
          className="btn"
          onClick={() => void submit()}
          type="button"
          disabled={!isDmDraftSendable(draft, canSend) || sending}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {noKey && (
        <p className="dm-compose-note">
          Connect with this peer once to exchange encryption keys before messaging.
        </p>
      )}
      {offlineNote && <p className="dm-compose-note">{offlineNote}</p>}
    </section>
  );
}
