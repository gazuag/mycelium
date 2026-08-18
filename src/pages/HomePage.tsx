import { useState } from 'react';
import type { Contact, StoredPost } from '../types';
import { PostCard } from '../components/PostCard';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface HomePageProps {
  posts: StoredPost[];
  contacts: Contact[];
  postText: string;
  onPostTextChange: (value: string) => void;
  onSubmitPost: (publish: boolean) => void;
  onRefreshPosts: () => Promise<void> | void;
  canCreatePost: boolean;
  onAuthorClick: (peerId: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
  onReply: (postId: string, content?: string, publishToDiscovery?: boolean) => void;
  onHide: (postId: string) => void;
  isRefreshing?: boolean;
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
  onLike,
  onDislike,
  onReply,
  onHide,
  isRefreshing = false
}: HomePageProps) {
  const [visibleCount, setVisibleCount] = useState(8);
  const [publishToDiscovery, setPublishToDiscovery] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [replyingToPostId, setReplyingToPostId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyPublishToDiscovery, setReplyPublishToDiscovery] = useState(true);

  const visiblePosts = posts.slice(0, visibleCount);

  return (
    <section className="page-view">
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
            const matchingContact = contacts.find((contact) =>
              contact.fingerprint === post.author || contact.publicKey === post.author
            );
            const authorName = matchingContact
              ? displayNameOrFallback(matchingContact.displayName, matchingContact.fingerprint || matchingContact.publicKey || post.author)
              : post.authorDisplayName?.trim() || 'Unknown peer';
            const recommendationLabel = post.isRecommendation && post.recommendedBy
              ? `Recommended by ${displayNameOrFallback(
                  contacts.find((contact) =>
                    contact.fingerprint === post.recommendedBy || contact.publicKey === post.recommendedBy
                  )?.displayName,
                  post.recommendedBy
                )}`
              : post.isRecommendation
                ? 'Recommended'
                : undefined;

            const isReplying = replyingToPostId === post.id;
            const replyText = replyDrafts[post.id] ?? '';

            return (
              <PostCard
                key={post.id}
                post={post}
                authorName={authorName}
                authorId={post.author}
                onAuthorClick={onAuthorClick}
                onLike={() => onLike(post.id)}
                onDislike={() => { onDislike(post.id); onHide(post.id); }}
                onHide={onHide}
                onReply={() => {
                  setReplyingToPostId((prev) => (prev === post.id ? null : post.id));
                  if (replyingToPostId !== post.id) {
                    setReplyDrafts((drafts) => ({ ...drafts, [post.id]: drafts[post.id] ?? '' }));
                  }
                }}
                recommendationLabel={recommendationLabel}
                replyComposer={isReplying ? (
                  <>
                    <textarea
                      value={replyText}
                      onChange={(event) => setReplyDrafts((drafts) => ({ ...drafts, [post.id]: event.target.value }))}
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
                          const text = (replyDrafts[post.id] ?? '').trim();
                          if (!text) return;
                          onReply(post.id, text, replyPublishToDiscovery);
                          setReplyDrafts((drafts) => ({ ...drafts, [post.id]: '' }));
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
                          setReplyDrafts((drafts) => ({ ...drafts, [post.id]: '' }));
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
