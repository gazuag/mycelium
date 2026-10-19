import { useEffect, useMemo, useRef, useState } from 'react';
import type { Contact } from '../types';
import type { LocalPostView } from '../object-layer';
import { PostCard } from '../components/PostCard';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { CompactUsername } from '../components/CompactUsername';
import { PeerName } from '../components/PeerName';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import type { PopularPeer } from '../services/peer-discovery';
import type { HomeFeedPost } from '../utils/homeFeed';
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
  contactsLoaded?: boolean;
  postText: string;
  onPostTextChange: (value: string) => void;
  onSubmitPost: (publish: boolean) => void;
  canCreatePost: boolean;
  onAuthorClick: (peerId: string) => void;
  myPeerId?: string;
  onOpenPost?: (postId: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onReply: (objectId: string, content?: string, publishToDiscovery?: boolean) => void;
  onHide: (objectId: string) => void;
  onDelete?: (objectId: string) => void;
  popularPeers?: PopularPeer[];
  onFollowPeer?: (peerId: string) => void;
}

export function HomePage({
  posts,
  onDiagnosticLog,
  replyCounts,
  contacts,
  contactsLoaded = true,
  postText,
  onPostTextChange,
  onSubmitPost,
  canCreatePost,
  onAuthorClick,
  myPeerId,
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
  const [publishToDiscovery, setPublishToDiscovery] = useState(true);
  const [replyingToPostId, setReplyingToPostId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyPublishToDiscovery, setReplyPublishToDiscovery] = useState(true);
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
            <IdentityAvatar seed={myPeerId ?? ''} size={40} alt="" />
          </button>
          <textarea
            value={postText}
            onChange={(event) => onPostTextChange(event.target.value)}
            placeholder="Share what is happening..."
          />
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={publishToDiscovery}
            onChange={(event) => setPublishToDiscovery(event.target.checked)}
          />
          <span>Publish to discovery</span>
        </label>
        <div className="row">
          <button
            className="btn"
            type="button"
            onClick={() => onSubmitPost(publishToDiscovery)}
            disabled={!canCreatePost || !postText.trim()}
          >
            Send
          </button>
        </div>
      </div>

      {popularPeerSuggestionsState === 'active' && !allSuggestedPeersFollowed ? (
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
              {popularPeers.map(({ peer_id: peerId }) => (
                <div className="popular-poster-item" key={peerId}>
                  <span>
                    <CompactUsername
                      peerId={peerId}
                      displayName={displayNameOrFallback(
                        contacts.find((contact) => contact.fingerprint === peerId || contact.publicKey === peerId)?.displayName,
                        peerId
                      )}
                      onProfileClick={onAuthorClick}
                    /> <span className="note">Reply activity</span>
                  </span>
                  {onFollowPeer ? (
                    <button className="chip secondary" type="button" onClick={() => onFollowPeer(peerId)}>
                      {contacts.some((contact) => contact.followed && (contact.fingerprint === peerId || contact.publicKey === peerId)) ? 'Unfollow' : 'Follow'}
                    </button>
                  ) : null}
                </div>
              ))}
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
            const authorName = matchingContact
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
                authorId={matchingContact?.fingerprint ?? authorFingerprint}
                authorOnline={matchingContact?.online === true}
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
                isOwnPost={post.authorFingerprint === myPeerId}
                replyComposer={isReplying ? (
                  <>
                    <textarea
                      value={replyText}
                      onChange={(event) => setReplyDrafts((drafts) => ({ ...drafts, [objectId]: event.target.value }))}
                      placeholder="Write a reply..."
                    />
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={replyPublishToDiscovery}
                        onChange={(event) => setReplyPublishToDiscovery(event.target.checked)}
                      />
                      <span>Publish to discovery</span>
                    </label>
                    <div className="row">
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          const text = (replyDrafts[objectId] ?? '').trim();
                          if (!text) return;
                          onReply(objectId, text, replyPublishToDiscovery);
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
