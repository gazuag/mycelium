import { useMemo, useState } from 'react';
import type { ConversationSummary } from '../object-layer/conversations';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { CompactUsername } from '../components/CompactUsername';
import { useDmUnread } from '../hooks/useDmUnread';
import type { ReplyNotification } from '../hooks/useReplyUnread';
import type { Contact } from '../types';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import { PeerRecipientPicker, relationshipContacts } from '../components/PeerRecipientPicker';

export { relationshipContacts } from '../components/PeerRecipientPicker';

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
  onViewProfile: (peerId: string) => void;
  replies?: readonly ReplyNotification[];
  onOpenReply?: (parentPostId: string, replyPostId?: string) => void;
  onMarkReplyRead?: (replyId: string) => void;
  onMarkAllRepliesRead?: () => void;
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
  onOpenChat,
  onViewProfile,
  replies = [],
  onOpenReply,
  onMarkReplyRead,
  onMarkAllRepliesRead
}: MessagesPageProps) {
  const { byContact, markRead } = useDmUnread();
  const [selectingPeer, setSelectingPeer] = useState(false);
  const [activeTab, setActiveTab] = useState<'messages' | 'replies'>('messages');
  const [search, setSearch] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
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
  const visibleReplies = replies.filter((reply) => {
    const contact = contacts.find((candidate) => (
      candidate.publicKey === reply.authorPublicKey || candidate.fingerprint === reply.authorFingerprint
    ));
    const normalizedSearch = search.trim().toLocaleLowerCase();
    if (!normalizedSearch) return true;
    return [
      contact?.displayName,
      reply.authorFingerprint,
      reply.parentContent,
      'replied to your post'
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
  });
  const dmUnreadCount = Object.values(byContact).reduce((total, count) => total + count, 0);

  const markAllMessagesRead = async () => {
    setReadError(null);
    try {
      await Promise.all(
        Object.entries(byContact)
          .filter(([, count]) => count > 0)
          .map(([counterparty]) => markRead(counterparty))
      );
    } catch (error) {
      setReadError(`Could not mark messages as read: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const switchToPeerSelection = () => {
    setSearch('');
    setSelectingPeer(true);
  };

  const switchToConversations = () => {
    setSearch('');
    setSelectingPeer(false);
    setActiveTab('messages');
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

      {!selectingPeer ? (
        <div className="messages-section-tabs" role="tablist" aria-label="Message types">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'messages'}
            className={activeTab === 'messages' ? 'active' : ''}
            onClick={() => setActiveTab('messages')}
          >
            Messages{dmUnreadCount > 0 ? <span className="messages-tab-count">{dmUnreadCount}</span> : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'replies'}
            className={activeTab === 'replies' ? 'active' : ''}
            onClick={() => setActiveTab('replies')}
          >
            Replies{replies.length > 0 && replies.some((reply) => !reply.read)
              ? <span className="messages-tab-count">{replies.filter((reply) => !reply.read).length}</span>
              : null}
          </button>
        </div>
      ) : null}

      <label className="messages-search">
        <span className="visually-hidden">
          {selectingPeer ? 'Search people to message' : activeTab === 'replies' ? 'Search replies' : 'Search conversations or messages'}
        </span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={selectingPeer ? 'Search people' : activeTab === 'replies' ? 'Search replies' : 'Search conversations or messages'}
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
          <PeerRecipientPicker
            contacts={visiblePeers}
            mode="message"
            ariaLabel="People to message"
            onSelect={(contact) => onOpenChat(contact.fingerprint || contact.publicKey)}
            onViewProfile={onViewProfile}
          />
        ) : (
          <p className="note messages-empty">
            {search ? 'No people match your search.' : 'No followed or follower contacts are available to message.'}
          </p>
        )
      ) : (
        <>
          {readError ? <p className="messages-error" role="alert">{readError}</p> : null}
          {activeTab === 'messages' && dmUnreadCount > 0 ? (
            <div className="messages-list-toolbar">
              <button className="btn secondary" type="button" onClick={() => void markAllMessagesRead()}>
                Mark all as read
              </button>
            </div>
          ) : null}
          {activeTab === 'replies' && replies.some((reply) => !reply.read) ? (
            <div className="messages-list-toolbar">
              <button className="btn secondary" type="button" onClick={onMarkAllRepliesRead}>
                Mark all as read
              </button>
            </div>
          ) : null}
          {activeTab === 'replies' ? (
            visibleReplies.length > 0 ? (
              <div className="messages-list" aria-label="Replies">
                {visibleReplies.map((reply) => {
                  const isMention = reply.kind === 'mention';
                  const contact = contacts.find((candidate) => (
                    candidate.publicKey === reply.authorPublicKey || candidate.fingerprint === reply.authorFingerprint
                  ));
                  const name = displayNameOrFallback(contact?.displayName, reply.authorFingerprint);
                  const time = formatActivityTime(reply.createdAt);
                  return (
                    <div className={`message-list-row reply-list-row${reply.read ? '' : ' unread'}${isMention ? ' mention-list-row' : ''}`} key={reply.id}>
                      <button
                        className="message-list-row-open"
                        type="button"
                        onClick={() => {
                          onMarkReplyRead?.(reply.id);
                          onOpenReply?.(reply.parentPostId, isMention ? undefined : reply.replyPostId);
                        }}
                        aria-label={isMention
                          ? `Open post mentioning you from ${name}${reply.read ? '' : ', unread'}`
                          : `Open reply from ${name} to your post${reply.read ? '' : ', unread'}`}
                      />
                      <IdentityAvatar seed={reply.authorFingerprint} size={42} alt={name} online={contact?.online === true} />
                      <span className="message-row-content">
                        <strong className="reply-row-author">{name}</strong>
                        <span className="reply-row-body">
                          {isMention
                            ? `Mentioned you${reply.mentionedHandle ? ` as @${reply.mentionedHandle}` : ''} in a post`
                            : reply.replyContent || 'Replied to your post'}
                        </span>
                        {reply.parentContent ? (
                          <span className="reply-parent-context">{isMention ? 'Post: ' : 'Your post: '}{reply.parentContent}</span>
                        ) : null}
                      </span>
                      <span className="message-row-trailing">
                        {time ? <time dateTime={reply.createdAt}>{time}</time> : null}
                        {!reply.read ? <span className="message-unread-dot" aria-label="Unread reply" /> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="note messages-empty">
                {search ? 'No replies match your search.' : 'Replies to your posts will appear here.'}
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
                  <div
                    className={`message-list-row${unread ? ' unread' : ''}`}
                    key={conversation.counterparty}
                  >
                    <button
                      className="message-list-row-open"
                      type="button"
                      onClick={() => onOpenChat(contact?.fingerprint ?? conversation.counterparty)}
                      aria-label={`Open conversation with ${name}${unread ? ', unread messages' : ''}`}
                    />
                    <IdentityAvatar
                      seed={contact?.fingerprint ?? conversation.counterparty}
                      size={42}
                      alt={name}
                      online={contact?.online === true}
                    />
                    <span className="message-row-content">
                      <strong>
                        <CompactUsername
                          peerId={contact?.fingerprint ?? conversation.counterparty}
                          displayName={name}
                          onProfileClick={onViewProfile}
                        />
                      </strong>
                      <span className="message-row-activity">{activity}</span>
                    </span>
                    <span className="message-row-trailing">
                      {time ? <time dateTime={conversation.lastAt}>{time}</time> : null}
                      {unread ? <span className="message-unread-dot" aria-hidden="true" /> : null}
                    </span>
                  </div>
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
        </>
      )}
    </section>
  );
}
