import { useState } from 'react';
import type { Contact } from '../types';
import type { LocalPostView } from '../object-layer';
import { PostCard } from '../components/PostCard';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface HomePageProps {
  posts: LocalPostView[];
  contacts: Contact[];
  postText: string;
  onPostTextChange: (value: string) => void;
  onSubmitPost: (publish: boolean) => void;
  onRefreshPosts: () => Promise<void> | void;
  canCreatePost: boolean;
  onAuthorClick: (peerId: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onReply: (objectId: string, content?: string, publishToDiscovery?: boolean) => void;
  onHide: (objectId: string) => void;
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
            const authorFingerprint = post.authorFingerprint;
            const matchingContact = contacts.find((contact) =>
              contact.fingerprint === authorFingerprint || contact.publicKey === post.object.author
            );
            const authorName = matchingContact
              ? displayNameOrFallback(matchingContact.displayName, matchingContact.fingerprint || matchingContact.publicKey || post.object.author)
              : displayNameOrFallback(post.authorDisplayName, authorFingerprint);
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
                onLike={() => onLike(objectId)}
                onDislike={() => { onDislike(objectId); onHide(objectId); }}
                onHide={onHide}
                onReply={() => {
                  setReplyingToPostId((prev) => (prev === objectId ? null : objectId));
                  if (replyingToPostId !== objectId) {
                    setReplyDrafts((drafts) => ({ ...drafts, [objectId]: drafts[objectId] ?? '' }));
                  }
                }}
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
