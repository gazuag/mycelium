import { useEffect, useState } from 'react';
import type { Contact } from '../types';
import { postReplyTo, type LocalPostView, type RecommendationSummary } from '../object-layer';
import { PostCard } from '../components/PostCard';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface ConversationPageProps {
  post: LocalPostView;
  posts: LocalPostView[];
  contacts: Contact[];
  myPeerId?: string;
  myPublicKey?: string;
  focusedPostId?: string | null;
  onLeave: () => void;
  onOpenPost: (postId: string) => void;
  onOpenParent: (parentPostId: string, currentPostId: string) => void;
  onAuthorClick: (peerId: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onHide: (objectId: string) => void;
  onReply: (objectId: string, content?: string, publishToDiscovery?: boolean) => void;
  getRecommendationSummary: (postId: string) => RecommendationSummary;
}

export function ConversationPage({
  post,
  posts,
  contacts,
  myPeerId,
  myPublicKey,
  focusedPostId,
  onLeave,
  onOpenPost,
  onOpenParent,
  onAuthorClick,
  onLike,
  onDislike,
  onHide,
  onReply,
  getRecommendationSummary
}: ConversationPageProps) {
  const [replyingToPostId, setReplyingToPostId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [publishToDiscovery, setPublishToDiscovery] = useState(true);

  useEffect(() => {
    if (!focusedPostId) return;
    const focusedPost = Array.from(document.querySelectorAll<HTMLElement>('[data-conversation-post-id]'))
      .find((element) => element.dataset.conversationPostId === focusedPostId);
    focusedPost?.focus({ preventScroll: true });
    focusedPost?.scrollIntoView({ block: 'center' });
  }, [focusedPostId, post.object.object_id]);

  const visibleReplies = posts
    .filter((candidate) => postReplyTo(candidate) === post.object.object_id)
    .sort((left, right) => new Date(left.object.created_at).getTime() - new Date(right.object.created_at).getTime());
  const parentId = postReplyTo(post);
  const parentPost = parentId ? posts.find((candidate) => candidate.object.object_id === parentId) : undefined;
  const parentContact = parentPost
    ? contacts.find((contact) => contact.fingerprint === parentPost.authorFingerprint || contact.publicKey === parentPost.object.author)
    : undefined;
  const parentName = parentPost
    ? displayNameOrFallback(parentContact?.displayName ?? parentPost.authorDisplayName, parentContact?.fingerprint ?? parentPost.authorFingerprint)
    : undefined;

  const renderPost = (currentPost: LocalPostView, isRoot = false, isFocused = false) => {
    const objectId = currentPost.object.object_id;
    const matchingContact = contacts.find((contact) =>
      contact.fingerprint === currentPost.authorFingerprint || contact.publicKey === currentPost.object.author
    );
    const authorName = displayNameOrFallback(
      matchingContact?.displayName ?? currentPost.authorDisplayName,
      matchingContact?.fingerprint ?? currentPost.authorFingerprint
    );
    const replyText = replyDrafts[objectId] ?? '';
    const isReplying = replyingToPostId === objectId;

    return (
      <div
        className={`${isRoot ? 'conversation-root' : 'conversation-reply'}${isFocused ? ' conversation-focused-reply' : ''}`}
        data-conversation-post-id={objectId}
        tabIndex={isFocused ? -1 : undefined}
        aria-current={isFocused ? 'location' : undefined}
        key={objectId}
      >
        <PostCard
          post={currentPost}
          authorName={authorName}
          authorId={matchingContact?.fingerprint ?? currentPost.authorFingerprint}
          onAuthorClick={() => onAuthorClick(matchingContact?.fingerprint ?? currentPost.authorFingerprint)}
          onOpenPost={isRoot ? undefined : () => onOpenPost(objectId)}
          onLike={() => onLike(objectId)}
          onDislike={() => onDislike(objectId)}
          onHide={onHide}
          onReply={() => {
            setReplyingToPostId((previous) => previous === objectId ? null : objectId);
            if (replyingToPostId !== objectId) {
              setReplyDrafts((drafts) => ({ ...drafts, [objectId]: drafts[objectId] ?? '' }));
            }
          }}
          isLiked={getRecommendationSummary(objectId).recommended_by_me}
          isOwnPost={currentPost.authorFingerprint === myPeerId || currentPost.object.author === myPublicKey}
          replyComposer={isReplying ? (
            <>
              <textarea
                value={replyText}
                onChange={(event) => setReplyDrafts((drafts) => ({ ...drafts, [objectId]: event.target.value }))}
                placeholder={`Reply to ${authorName}...`}
                aria-label={`Reply to ${authorName}`}
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
                  onClick={() => {
                    const text = replyText.trim();
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
      </div>
    );
  };

  return (
    <section className="page-view conversation-page">
      <header className="conversation-header">
        {parentId ? (
          parentPost ? (
            <button className="btn secondary conversation-back" type="button" onClick={() => onOpenParent(parentId, post.object.object_id)} aria-label="View parent post">
              <span aria-hidden="true">←</span>
              <span>Parent</span>
            </button>
          ) : (
            <button className="btn secondary conversation-back" type="button" disabled aria-label="Parent post unavailable">
              <span aria-hidden="true">←</span>
              <span>Parent unavailable</span>
            </button>
          )
        ) : (
          <button className="btn secondary conversation-back" type="button" onClick={onLeave} aria-label="Return to previous view">
            <span aria-hidden="true">←</span>
            <span>Return</span>
          </button>
        )}
        <h2>Post</h2>
      </header>

      {parentId ? (
        <div className="conversation-parent">
          {parentPost ? (
            <button className="conversation-parent-link" type="button" onClick={() => onOpenParent(parentId, post.object.object_id)}>
              Replying to {parentName}
            </button>
          ) : (
            <span className="note">Replying to a post that is not loaded on this device</span>
          )}
        </div>
      ) : null}

      <div className={`conversation-posts${visibleReplies.length === 1 ? ' has-single-reply' : ''}`}>
        {renderPost(post, true)}
        {visibleReplies.length > 0 ? (
          visibleReplies.map((reply) => renderPost(reply, false, reply.object.object_id === focusedPostId))
        ) : (
          <p className="conversation-empty note">No direct replies are available in the posts currently loaded on this device.</p>
        )}
      </div>
    </section>
  );
}
