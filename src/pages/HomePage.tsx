import { useState } from 'react';
import type { Contact } from '../types';
import type { LocalPostView, RecommendationSummary } from '../object-layer';
import { PostCard } from '../components/PostCard';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import type { PopularPeer } from '../services/peer-discovery';

interface HomePageProps {
  posts: HomeFeedPost[];
  contacts: Contact[];
  postText: string;
  onPostTextChange: (value: string) => void;
  onSubmitPost: (publish: boolean) => void;
  onRefreshPosts: () => Promise<void> | void;
  canCreatePost: boolean;
  onAuthorClick: (peerId: string) => void;
  onOpenPost?: (postId: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onReply: (objectId: string, content?: string, publishToDiscovery?: boolean) => void;
  onHide: (objectId: string) => void;
  popularPeers?: PopularPeer[];
  onFollowPeer?: (peerId: string) => void;
  isRefreshing?: boolean;
}

export interface HomeFeedPost extends LocalPostView {
  homeFeedSource?: 'followed' | 'recommendation';
  recommendationSummary?: RecommendationSummary;
}

export function HomePage({
  posts,
  contacts,
  postText,
  onPostTextChange,
  onSubmitPost,
  onRefreshPosts,
  canCreatePost,
  onAuthorClick,
  onOpenPost,
  onLike,
  onDislike,
  onReply,
  onHide,
  popularPeers = [],
  onFollowPeer,
  isRefreshing = false
}: HomePageProps) {
  const [visibleCount, setVisibleCount] = useState(8);
  const [publishToDiscovery, setPublishToDiscovery] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [replyingToPostId, setReplyingToPostId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyPublishToDiscovery, setReplyPublishToDiscovery] = useState(true);
  const [popularPeersDismissed, setPopularPeersDismissed] = useState(false);

  const visiblePosts = [...posts]
    .sort((left, right) => new Date(right.object.created_at).getTime() - new Date(left.object.created_at).getTime())
    .slice(0, visibleCount);

  return (
    <section className="page-view">
      {!popularPeersDismissed ? (
        <div className="popular-posters-banner">
          <div className="popular-posters-heading">
            <strong>Popular posters right now.</strong>
            <button
              aria-label="Dismiss popular peer suggestions"
              className="popular-posters-close"
              onClick={() => setPopularPeersDismissed(true)}
              title="Dismiss suggestions"
              type="button"
            >
              X
            </button>
          </div>
          {popularPeers.length === 0 ? <p className="note">No popular posters found yet.</p> : (
            <div className="popular-posters-list">
              {popularPeers.map(({ peer_id: peerId, reply_count: replyCount }) => (
                <div className="popular-poster-item" key={peerId}>
                  <span>{displayNameOrFallback(undefined, peerId)} <span className="note">{replyCount} {replyCount === 1 ? 'reply' : 'replies'}</span></span>
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
      <div className="page-header">
        <h2>Home</h2>
        <p className="note">New posts from people you follow.</p>
        <div className="page-header-actions">
          <button className="btn secondary" type="button" onClick={() => void onRefreshPosts()} disabled={isRefreshing}>
            {isRefreshing ? 'Refreshing…' : 'Refresh posts'}
          </button>
        </div>
      </div>

      <div className="card home-composer">
        <div className="row between">
          <h3>Create Post</h3>
          <button className="chip secondary" type="button" onClick={() => setComposerOpen((prev) => !prev)}>
            {composerOpen ? 'Hide' : 'Write'}
          </button>
        </div>

        {composerOpen ? (
          <>
            <textarea
              value={postText}
              onChange={(event) => onPostTextChange(event.target.value)}
              placeholder="Share what is happening..."
            />
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
          </>
        ) : null}
      </div>

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
              : displayNameOrFallback(post.authorDisplayName, authorFingerprint);
            const recommendationSummary = post.recommendationSummary;
            const recommenders = recommendationSummary?.followed_recommenders ?? [];
            const firstRecommender = recommenders[0];
            const firstRecommenderName = firstRecommender
              ? displayNameOrFallback(
                  contacts.find((contact) => contact.fingerprint === firstRecommender || contact.publicKey === firstRecommender)?.displayName,
                  firstRecommender
                )
              : undefined;
            const recommendationLabel = post.homeFeedSource === 'recommendation' && firstRecommenderName
              ? recommenders.length === 1
                ? `${firstRecommenderName} recommends this`
                : `${firstRecommenderName} and ${recommenders.length - 1} others recommend this`
              : undefined;

            const objectId = post.object.object_id;
            const isReplying = replyingToPostId === objectId;
            const replyText = replyDrafts[objectId] ?? '';

            return (
              <PostCard
                key={objectId}
                post={post}
                authorName={authorName}
                authorId={matchingContact?.fingerprint ?? authorFingerprint}
                onAuthorClick={onAuthorClick}
                onOpenPost={onOpenPost ? () => onOpenPost(objectId) : undefined}
                onLike={() => onLike(objectId)}
                onDislike={() => { onDislike(objectId); onHide(objectId); }}
                onHide={onHide}
                onReply={() => {
                  setReplyingToPostId((prev) => (prev === objectId ? null : objectId));
                  if (replyingToPostId !== objectId) {
                    setReplyDrafts((drafts) => ({ ...drafts, [objectId]: drafts[objectId] ?? '' }));
                  }
                }}
                isLiked={recommendationSummary?.recommended_by_me ?? false}
                recommendationLabel={recommendationLabel}
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

      {visibleCount < posts.length ? (
        <div className="load-more-wrap">
          <button className="btn secondary" type="button" onClick={() => setVisibleCount((prev) => prev + 8)}>
            Load more
          </button>
        </div>
      ) : null}
    </section>
  );
}
