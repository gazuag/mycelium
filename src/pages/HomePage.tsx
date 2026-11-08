import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Contact } from '../types';
import type { LocalPostView, PostMention } from '../object-layer';
import { PostCard } from '../components/PostCard';
import { MarkdownComposer } from '../components/MarkdownComposer';
import { AVATAR_SIZES, IdentityAvatar } from '../components/IdentityAvatar';
import { CompactUsername } from '../components/CompactUsername';
import { PeerName } from '../components/PeerName';
import { PeerRecipientPicker, filterPeersByHandlePrefix, relationshipContacts, peerMentionHandle } from '../components/PeerRecipientPicker';
import { displayNameOrFallback, resolvePeerDisplayName } from '../utils/fingerprintNames';
import { activeMentionAt, insertMention, mentionsPresentInText, type ActiveMention } from '../utils/postMentions';
import type { PopularPeerWithIdentityProfile } from '../services/peer-discovery';
import type { HomeFeedPost } from '../utils/homeFeed';
import type { IdentityProfilePicture } from '../utils/profile-picture';
import { MAX_POST_CONTENT_LENGTH } from '../object-layer/post-state';
import { resizeTextareaToRows } from '../utils/textarea';
import {
  advancePopularPeerSuggestionsState,
  dismissPopularPeerSuggestions,
  getInitialPopularPeerSuggestionsState,
  popularPeerSuggestionsStorageKey
} from '../utils/popularPeerSuggestions';

interface HomePageProps {
  posts: HomeFeedPost[];
  onDiagnosticLog?: (entry: string) => void;
  replyCounts?: ReadonlyMap<string, number>;
  contacts: Contact[];
  mentionContacts?: Contact[];
  myPublicKey?: string;
  contactsLoaded?: boolean;
  postText: string;
  onPostTextChange: (value: string) => void;
  publishToDiscovery?: boolean;
  onSubmitPost: (publish: boolean, mentions: PostMention[]) => void;
  canCreatePost: boolean;
  onAuthorClick: (peerId: string) => void;
  myPeerId?: string;
  myProfilePicture?: IdentityProfilePicture | null;
  myDisplayName?: string;
  onOpenPost?: (postId: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onReply: (objectId: string, content?: string, publishToDiscovery?: boolean) => void;
  onHide: (objectId: string) => void;
  onDelete?: (objectId: string) => void;
  popularPeers?: PopularPeerWithIdentityProfile[];
  onFollowPeer?: (peerId: string) => void;
}

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function HomePage({
  posts,
  onDiagnosticLog,
  replyCounts,
  contacts,
  mentionContacts = contacts,
  myPublicKey = '',
  contactsLoaded = true,
  postText,
  onPostTextChange,
  publishToDiscovery = true,
  onSubmitPost,
  canCreatePost,
  onAuthorClick,
  myPeerId,
  myProfilePicture,
  myDisplayName = '',
  onOpenPost,
  onLike,
  onDislike,
  onReply,
  onHide,
  onDelete,
  popularPeers = [],
  onFollowPeer
}: HomePageProps) {
  const [visibleCount, setVisibleCount] = useState(8);
  const [replyingToPostId, setReplyingToPostId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<PostMention[]>([]);
  const followedCount = contacts.filter((contact) => contact.followed).length;
  const allSuggestedPeersFollowed = popularPeers.length > 0 && popularPeers.every(({ peer_id: peerId }) =>
    contacts.some((contact) =>
      contact.followed && (contact.fingerprint === peerId || contact.publicKey === peerId)
    )
  );
  const [popularPeerSuggestionsState, setPopularPeerSuggestionsState] = useState(() =>
    getInitialPopularPeerSuggestionsState(
      typeof window === 'undefined'
        ? null
        : window.localStorage.getItem(popularPeerSuggestionsStorageKey)
          ?? (window.localStorage.getItem('popularPeerSuggestionsDismissed') === 'true' ? 'true' : null),
      contactsLoaded,
      followedCount
    )
  );
  const [autoLoadAvailable, setAutoLoadAvailable] = useState(false);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const [composerElement, setComposerElement] = useState<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const mentionPeers = useMemo(
    () => relationshipContacts(mentionContacts, myPublicKey, myPeerId ?? ''),
    [mentionContacts, myPeerId, myPublicKey]
  );
  const matchingMentionPeers = activeMention
    ? filterPeersByHandlePrefix(mentionPeers, activeMention.query)
    : [];

  useBrowserLayoutEffect(() => {
    if (pendingCaret.current === null || !composerElement) return;
    composerElement.focus();
    composerElement.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [composerElement, postText]);

  useBrowserLayoutEffect(() => {
    if (!composerElement) return;
    resizeTextareaToRows(composerElement, 10);
  }, [composerElement, postText]);

  useEffect(() => {
    if (!composerElement) return;
    const resize = () => resizeTextareaToRows(composerElement, 10);
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(composerElement);
    return () => observer.disconnect();
  }, [composerElement]);

  useEffect(() => {
    if (!postText) setSelectedMentions([]);
  }, [postText]);

  const updateActiveMention = (text: string, caret: number) => {
    setActiveMention(activeMentionAt(text, caret));
  };

  const selectMention = (contact: Contact) => {
    if (!activeMention) return;
    const handle = peerMentionHandle(contact);
    if (!handle) return;
    const composer = composerElement;
    const caret = composer?.selectionStart ?? postText.length;
    const insertion = insertMention(postText, caret, activeMention, handle);
    const mention: PostMention = {
      handle,
      peerId: contact.fingerprint,
      publicKey: contact.publicKey
    };
    setSelectedMentions((current) => current.some((item) => item.publicKey === mention.publicKey)
      ? current
      : [...current, mention]);
    pendingCaret.current = insertion.caret;
    onPostTextChange(insertion.text);
    setActiveMention(activeMentionAt(insertion.text, insertion.caret));
  };

  const visiblePosts = useMemo(
    () => [...posts]
      .sort((left, right) =>
        (right.injectedAt ?? Date.parse(right.object.created_at))
        - (left.injectedAt ?? Date.parse(left.object.created_at))
      )
      .slice(0, visibleCount),
    [posts, visibleCount]
  );
  useEffect(() => {
    setPopularPeerSuggestionsState((current) => advancePopularPeerSuggestionsState(
      current,
      contactsLoaded,
      followedCount,
      allSuggestedPeersFollowed
    ));
  }, [allSuggestedPeersFollowed, contactsLoaded, followedCount]);
  useEffect(() => {
    window.localStorage.setItem(popularPeerSuggestionsStorageKey, popularPeerSuggestionsState);
  }, [popularPeerSuggestionsState]);
  useEffect(() => {
    const firstPost = visiblePosts[0];
    if (!firstPost) return;
    onDiagnosticLog?.(`HomePage render: posts=${posts.length} first-injectedAt=${firstPost.injectedAt} first-created=${firstPost.object.created_at.slice(0, 19)}`);
  }, [visiblePosts, posts.length, onDiagnosticLog]);
  useEffect(() => {
    const sentinel = feedEndRef.current;
    if (!sentinel || visibleCount >= posts.length) {
      setAutoLoadAvailable(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setAutoLoadAvailable(false);
      return;
    }

    let requested = false;
    let observer: IntersectionObserver | undefined;
    try {
      observer = new IntersectionObserver((entries) => {
        if (requested || !entries.some((entry) => entry.isIntersecting)) return;
        requested = true;
        setVisibleCount((count) => Math.min(count + 8, posts.length));
      }, {
        root: document.getElementById('page-content'),
        rootMargin: '0px 0px 480px 0px'
      });
      observer.observe(sentinel);
      setAutoLoadAvailable(true);
    } catch (error: unknown) {
      setAutoLoadAvailable(false);
      onDiagnosticLog?.(`Home feed automatic loading unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    return () => observer?.disconnect();
  }, [onDiagnosticLog, posts.length, visibleCount]);

  const loadMorePosts = () => setVisibleCount((count) => Math.min(count + 8, posts.length));

  return (
    <section className="page-view">
      <div className="card home-composer">
        <div className="home-composer-entry">
          <button
            className="home-composer-avatar"
            type="button"
            onClick={() => myPeerId && onAuthorClick(myPeerId)}
            aria-label="View your profile"
            disabled={!myPeerId}
          >
            <IdentityAvatar seed={myPeerId ?? ''} size={AVATAR_SIZES.composer} alt="" profilePicture={myProfilePicture} />
          </button>
          <div className="markdown-compose-field">
            <MarkdownComposer
              textareaRef={setComposerElement}
              value={postText}
              onChange={(value, caretPosition) => {
                onPostTextChange(value);
                updateActiveMention(value, caretPosition ?? composerElement?.selectionStart ?? value.length);
              }}
              onClick={(event) => updateActiveMention(event.currentTarget.value, event.currentTarget.selectionStart)}
              onKeyUp={(event) => {
                if (event.key === 'Escape') {
                  setActiveMention(null);
                  return;
                }
                updateActiveMention(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              placeholder="Share what is happening..."
              rows={2}
              maxLength={MAX_POST_CONTENT_LENGTH}
              action={
                <button
                  className="btn"
                  type="button"
                  onClick={() => onSubmitPost(publishToDiscovery, mentionsPresentInText(postText, selectedMentions))}
                  disabled={!canCreatePost || !postText.trim()}
                >
                  Send
                </button>
              }
            />
          </div>
        </div>
        {activeMention ? (
          <PeerRecipientPicker
            contacts={matchingMentionPeers}
            mode="mention"
            ariaLabel="Mention a peer"
            emptyMessage="No peers match that handle prefix."
            onSelect={selectMention}
          />
        ) : null}
      </div>

      {popularPeerSuggestionsState === 'active' && !allSuggestedPeersFollowed && popularPeers.length > 0 ? (
        <div className="popular-posters-banner">
          <div className="popular-posters-heading">
            <strong>Popular posters right now.</strong>
            <button
              aria-label="Dismiss popular peer suggestions"
              className="popular-posters-close"
              onClick={() => {
                const nextState = dismissPopularPeerSuggestions(followedCount);
                window.localStorage.setItem(popularPeerSuggestionsStorageKey, nextState);
                setPopularPeerSuggestionsState(nextState);
              }}
              title="Dismiss suggestions"
              type="button"
            >
              X
            </button>
          </div>
          {popularPeers.length === 0 ? <p className="note">No popular posters found yet.</p> : (
            <div className="popular-posters-list">
              {popularPeers.map((popularPeer) => {
                const peerId = popularPeer.peer_id;
                const contact = contacts.find((candidate) =>
                  candidate.fingerprint === peerId || candidate.publicKey === peerId
                );
                const identityName = popularPeer.identity_profile?.payload.display_name
                  ?? contact?.identityObject?.payload.display_name;
                const displayName = displayNameOrFallback(
                  resolvePeerDisplayName(identityName, contact?.authenticatedDisplayName) ?? contact?.displayName,
                  peerId
                );
                return (
                  <div className="popular-poster-item" key={peerId}>
                    <span>
                      <CompactUsername
                        peerId={peerId}
                        displayName={displayName}
                        onProfileClick={onAuthorClick}
                      /> <span className="note">Reply activity</span>
                    </span>
                    {onFollowPeer ? (
                      <button className="chip secondary" type="button" onClick={() => onFollowPeer(peerId)}>
                        {contacts.some((contact) => contact.followed && (contact.fingerprint === peerId || contact.publicKey === peerId)) ? 'Unfollow' : 'Follow'}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {visiblePosts.length === 0 ? (
        <div className="empty-state card">
          <p>No posts yet. Follow peers to build your feed.</p>
        </div>
      ) : (
        <div className="feed-list">
          {visiblePosts.map((post) => {
            const authorFingerprint = post.authorFingerprint;
            const matchingContact = contacts.find((contact) =>
              contact.fingerprint === authorFingerprint || contact.publicKey === post.object.author
            );
            const isOwnPost = authorFingerprint === myPeerId || post.object.author === myPublicKey;
            const authorDisplayName = isOwnPost ? myDisplayName : matchingContact?.displayName;
            const authorName = isOwnPost
              ? displayNameOrFallback(myDisplayName, authorFingerprint)
              : matchingContact
                ? displayNameOrFallback(matchingContact.displayName, matchingContact.fingerprint || matchingContact.publicKey || post.object.author)
                : displayNameOrFallback(undefined, authorFingerprint);
            const recommendationSummary = post.recommendationSummary;
            const recommenders = recommendationSummary?.followed_recommenders ?? [];
            const recommenderNames = recommenders.slice(0, 2).map((recommender) =>
              displayNameOrFallback(
                contacts.find((contact) => contact.fingerprint === recommender || contact.publicKey === recommender)?.displayName,
                recommender
              )
            );
            const remainingRecommenders = recommenders.length - recommenderNames.length;
            const recommenderAttribution = recommenderNames.length === 2
              ? remainingRecommenders > 0
                ? `${recommenderNames[0]}, ${recommenderNames[1]} and ${remainingRecommenders} more`
                : `${recommenderNames[0]} and ${recommenderNames[1]}`
              : `${recommenderNames[0]}${remainingRecommenders > 0 ? ` and ${remainingRecommenders} more` : ''}`;
            const recommendationLabel = post.homeFeedSource === 'recommendation'
              ? recommenderNames.length === 0
                ? 'Recommended by people you follow'
                : `${recommenderAttribution} ${recommenders.length === 1 ? 'recommends' : 'recommend'} this`
              : undefined;

            const objectId = post.object.object_id;
            const isReplying = replyingToPostId === objectId;
            const replyText = replyDrafts[objectId] ?? '';

            return (
              <PostCard
                key={objectId}
                post={post}
                replyCount={replyCounts?.get(objectId) ?? 0}
                likeCount={recommendationSummary?.active_recommender_count ?? 0}
                authorName={authorName}
                authorDisplayName={authorDisplayName}
                authorId={matchingContact?.fingerprint ?? authorFingerprint}
                authorOnline={matchingContact?.online === true}
                authorProfilePicture={isOwnPost
                  ? myProfilePicture ?? undefined
                  : matchingContact?.profilePicture ?? matchingContact?.identityObject?.payload.profile_picture}
                onAuthorClick={onAuthorClick}
                onOpenPost={onOpenPost ? () => onOpenPost(objectId) : undefined}
                onLike={() => onLike(objectId)}
                onDislike={() => { onDislike(objectId); onHide(objectId); }}
                onHide={onHide}
                onDelete={onDelete}
                onReply={() => {
                  setReplyingToPostId((prev) => (prev === objectId ? null : objectId));
                  if (replyingToPostId !== objectId) {
                    setReplyDrafts((drafts) => ({ ...drafts, [objectId]: drafts[objectId] ?? '' }));
                  }
                }}
                isLiked={recommendationSummary?.recommended_by_me ?? false}
                recommendationLabel={recommendationLabel}
                discoveryLabel={post.homeFeedSource === 'discovery' ? 'You might like this' : undefined}
                feedSource={post.homeFeedSource}
                isOwnPost={isOwnPost}
                replyComposer={isReplying ? (
                  <>
                    <div className="markdown-compose-field">
                      <MarkdownComposer
                        value={replyText}
                        onChange={(value) => setReplyDrafts((drafts) => ({ ...drafts, [objectId]: value }))}
                        placeholder="Write a reply..."
                        maxLength={MAX_POST_CONTENT_LENGTH}
                      />
                    </div>
                    <div className="row">
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          const text = (replyDrafts[objectId] ?? '').trim();
                          if (!text) return;
                          onReply(objectId, text, publishToDiscovery);
                          setReplyDrafts((drafts) => ({ ...drafts, [objectId]: '' }));
                          setReplyingToPostId(null);
                        }}
                        disabled={!replyText.trim()}
                      >
                        Send reply
                      </button>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => {
                          setReplyingToPostId(null);
                          setReplyDrafts((drafts) => ({ ...drafts, [objectId]: '' }));
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : null}
              />
            );
          })}
        </div>
      )}

      {visibleCount < posts.length ? <div ref={feedEndRef} className="home-feed-end" aria-hidden="true" /> : null}

      {visibleCount < posts.length && !autoLoadAvailable ? (
        <div className="load-more-wrap">
          <button className="btn secondary" type="button" onClick={loadMorePosts}>
            Load more
          </button>
        </div>
      ) : null}
    </section>
  );
}
