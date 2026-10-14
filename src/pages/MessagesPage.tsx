import { useMemo, useState } from 'react';
import type { ConversationSummary } from '../object-layer/conversations';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { useDmUnread } from '../hooks/useDmUnread';
import type { Contact } from '../types';
import { displayNameOrFallback, shortPeerId } from '../utils/fingerprintNames';

interface MessagesPageProps {
  contacts: Contact[];
  myPublicKey: string;
  myPeerId: string;
  conversations: ConversationSummary[];
  previews: Record<string, string>;
  loading: boolean;
  error: string | null;
  previewError: string | null;
  onOpenChat: (peerId: string) => void;
}

export function relationshipContacts(
  contacts: Contact[],
  myPublicKey: string,
  myPeerId: string
): Contact[] {
  const selfIds = new Set([myPublicKey, myPeerId]);
  const unique = new Map<string, Contact>();
  for (const contact of contacts) {
    if (selfIds.has(contact.publicKey) || selfIds.has(contact.fingerprint)) continue;
    if (!contact.followed && !contact.follower) continue;
    if (!unique.has(contact.publicKey)) unique.set(contact.publicKey, contact);
  }
  return [...unique.values()];
}

export function conversationMatchesSearch(
  conversation: ConversationSummary,
  contact: Contact | undefined,
  query: string,
  preview?: string
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [
    contact?.displayName,
    contact?.fingerprint,
    contact?.publicKey,
    conversation.counterparty,
    preview
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function MessagesPage({
  contacts,
  myPublicKey,
  myPeerId,
  conversations,
  previews,
  loading,
  error,
  previewError,
  onOpenChat
}: MessagesPageProps) {
  const { byContact } = useDmUnread();
  const [selectingPeer, setSelectingPeer] = useState(false);
  const [search, setSearch] = useState('');
  const searchablePeers = useMemo(
    () => relationshipContacts(contacts, myPublicKey, myPeerId),
    [contacts, myPeerId, myPublicKey]
  );

  const contactFor = (counterparty: string) => contacts.find((contact) => (
    contact.publicKey === counterparty || contact.fingerprint === counterparty
  ));
  const visibleConversations = conversations.filter((conversation) => (
    conversationMatchesSearch(
      conversation,
      contactFor(conversation.counterparty),
      search,
      previews[conversation.counterparty]
    )
  ));
  const visiblePeers = searchablePeers.filter((contact) => conversationMatchesSearch({
    counterparty: contact.publicKey,
    lastAt: '',
    lastObjectId: '',
    lastDirection: 'in',
    count: 0
  }, contact, search));

  const switchToPeerSelection = () => {
    setSearch('');
    setSelectingPeer(true);
  };

  const switchToConversations = () => {
    setSearch('');
    setSelectingPeer(false);
  };

  return (
    <section className="page-view messages-page">
      <div className="messages-page-header">
        {selectingPeer ? (
          <>
            <button className="messages-back" type="button" onClick={switchToConversations}>
              <span aria-hidden="true">←</span> Messages
            </button>
            <h2>New message</h2>
          </>
        ) : (
          <>
            <h2>Messages</h2>
            <button className="btn messages-new-button" type="button" onClick={switchToPeerSelection}>
              New message
            </button>
          </>
        )}
      </div>

      <label className="messages-search">
        <span className="visually-hidden">
          {selectingPeer ? 'Search people to message' : 'Search conversations or messages'}
        </span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={selectingPeer ? 'Search people' : 'Search conversations or messages'}
        />
        {search ? (
          <button
            type="button"
            className="messages-search-clear"
            onClick={() => setSearch('')}
            aria-label="Clear search"
          >
            Clear
          </button>
        ) : null}
      </label>

      {selectingPeer ? (
        visiblePeers.length > 0 ? (
          <div className="messages-list" aria-label="People to message">
            {visiblePeers.map((contact) => {
              const name = displayNameOrFallback(contact.displayName, contact.fingerprint);
              return (
                <button
                  className="message-list-row"
                  type="button"
                  key={contact.publicKey}
                  onClick={() => onOpenChat(contact.fingerprint || contact.publicKey)}
                  aria-label={`Start conversation with ${name}`}
                >
                  <IdentityAvatar seed={contact.fingerprint} size={42} alt={name} online={contact.online === true} />
                  <span className="message-row-content">
                    <strong>{name}</strong>
                    <span className="message-row-identifier" title={contact.fingerprint}>{shortPeerId(contact.fingerprint)}</span>
                  </span>
                  <span className="message-row-action" aria-hidden="true">›</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="note messages-empty">
            {search ? 'No people match your search.' : 'No followed or follower contacts are available to message.'}
          </p>
        )
      ) : (
        <>
          {error ? <p className="messages-error" role="alert">Could not load conversations: {error}</p> : null}
          {previewError ? <p className="messages-error" role="status">{previewError}</p> : null}
          {visibleConversations.length > 0 ? (
            <div className="messages-list" aria-label="Conversations">
              {visibleConversations.map((conversation) => {
                const contact = contactFor(conversation.counterparty);
                const name = displayNameOrFallback(contact?.displayName, contact?.fingerprint ?? conversation.counterparty);
                const unread = (byContact[conversation.counterparty] ?? 0) > 0;
                const preview = previews[conversation.counterparty];
                const activity = preview
                  ?? (conversation.lastDirection === 'out' ? 'You sent a message' : 'Received a message');
                const time = formatActivityTime(conversation.lastAt);
                return (
                  <button
                    className={`message-list-row${unread ? ' unread' : ''}`}
                    type="button"
                    key={conversation.counterparty}
                    onClick={() => onOpenChat(contact?.fingerprint ?? conversation.counterparty)}
                    aria-label={`Open conversation with ${name}${unread ? ', unread messages' : ''}`}
                  >
                    <IdentityAvatar
                      seed={contact?.fingerprint ?? conversation.counterparty}
                      size={42}
                      alt={name}
                      online={contact?.online === true}
                    />
                    <span className="message-row-content">
                      <strong>{name}</strong>
                      <span className="message-row-identifier" title={contact?.fingerprint ?? conversation.counterparty}>
                        {shortPeerId(contact?.fingerprint ?? conversation.counterparty)}
                      </span>
                      <span className="message-row-activity">{activity}</span>
                    </span>
                    <span className="message-row-trailing">
                      {time ? <time dateTime={conversation.lastAt}>{time}</time> : null}
                      {unread ? <span className="message-unread-dot" aria-hidden="true" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : loading ? (
            <p className="note messages-empty" role="status">Loading conversations…</p>
          ) : error ? (
            <p className="note messages-empty">The conversation list is unavailable until it can be loaded.</p>
          ) : (
            <p className="note messages-empty">
              {search ? 'No conversations match your search.' : 'Your conversations will appear here.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
