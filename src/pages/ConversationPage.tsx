import { useEffect, useRef, useState } from 'react';
import type { Contact } from '../types';
import { postReplyTo, type DeletionTombstone, type LocalPostView, type PostAncestryResult, type RecommendationSummary } from '../object-layer';
import { PostCard } from '../components/PostCard';
import { MarkdownHelp } from '../components/MarkdownHelp';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface ConversationPageProps {
  post: LocalPostView;
  posts: LocalPostView[];
  replyCounts?: ReadonlyMap<string, number>;
  contacts: Contact[];
  myPeerId?: string;
  myPublicKey?: string;
  focusedPostId?: string | null;
  deletionTombstones?: readonly DeletionTombstone[];
  ancestry?: {
    loading: boolean;
    result?: PostAncestryResult;
    error?: boolean;
  };
  onLeave: () => void;
  onOpenPost: (postId: string) => void;
  onOpenParent: (parentPostId: string, currentPostId: string) => void;
  onAuthorClick: (peerId: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onHide: (objectId: string) => void;
  onDelete?: (objectId: string) => void;
  onReply: (objectId: string, content?: string, publishToDiscovery?: boolean) => void;
  getRecommendationSummary: (postId: string) => RecommendationSummary;
}

export function ConversationPage({
  post,
  posts,
  replyCounts,
  contacts,
  myPeerId,
  myPublicKey,
  focusedPostId,
  deletionTombstones = [],
  ancestry,
  onLeave,
  onOpenPost,
  onOpenParent,
  onAuthorClick,
  onLike,
  onDislike,
  onHide,
  onDelete,
  onReply,
  getRecommendationSummary
}: ConversationPageProps) {
  const [replyingToPostId, setReplyingToPostId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [publishToDiscovery, setPublishToDiscovery] = useState(true);
  const selectedReplyTextareaRef = useRef<HTMLTextAreaElement>(null);

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
  const ancestors = ancestry?.result?.ancestors ?? [];
  const threadAncestors = collectThreadAncestors(post, ancestors, posts, deletionTombstones);
  const postTombstones = new Map(deletionTombstones
    .filter((item) => item.target_object_type === 'mycelium.post')
    .map((item) => [item.target_object_id, item]));
  const parentPost = parentId
    ? ancestors.find((candidate) => candidate.object.object_id === parentId)
      ?? posts.find((candidate) => candidate.object.object_id === parentId)
    : undefined;
  const parentTombstone = parentId ? postTombstones.get(parentId) : undefined;
  const selectedContact = contacts.find((contact) =>
    contact.fingerprint === post.authorFingerprint || contact.publicKey === post.object.author
  );
  const selectedAuthorName = postTombstones.has(post.object.object_id)
    ? 'deleted post'
    : displayNameOrFallback(
      selectedContact?.displayName,
      selectedContact?.fingerprint ?? post.authorFingerprint
    );

  useEffect(() => {
    if (replyingToPostId !== post.object.object_id) return;
    selectedReplyTextareaRef.current?.focus();
  }, [replyingToPostId, post.object.object_id]);

  const toggleReplyComposer = (objectId: string) => {
    setReplyingToPostId((previous) => previous === objectId ? null : objectId);
    if (replyingToPostId !== objectId) {
      setReplyDrafts((drafts) => ({ ...drafts, [objectId]: drafts[objectId] ?? '' }));
    }
  };

  const getAuthorName = (currentPost: LocalPostView) => {
    const matchingContact = contacts.find((contact) =>
      contact.fingerprint === currentPost.authorFingerprint || contact.publicKey === currentPost.object.author
    );
    return displayNameOrFallback(
      matchingContact?.displayName,
      matchingContact?.fingerprint ?? currentPost.authorFingerprint
    );
  };

  const activateSelectedReplyComposer = () => {
    setReplyingToPostId(post.object.object_id);
    setReplyDrafts((drafts) => ({
      ...drafts,
      [post.object.object_id]: drafts[post.object.object_id] ?? ''
    }));
  };

  const submitReply = (objectId: string, replyText: string) => {
    const text = replyText.trim();
    if (!text) return;
    onReply(objectId, text, publishToDiscovery);
    setReplyDrafts((drafts) => ({ ...drafts, [objectId]: '' }));
    setReplyingToPostId(null);
  };

  const cancelReply = (objectId: string) => {
    setReplyingToPostId(null);
    setReplyDrafts((drafts) => ({ ...drafts, [objectId]: '' }));
  };

  const renderReplyComposer = (currentPost: LocalPostView, authorName: string, inline = false) => {
    const objectId = currentPost.object.object_id;
    const replyText = replyDrafts[objectId] ?? '';
    const composerControls = (
      <>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={publishToDiscovery}
            onChange={(event) => setPublishToDiscovery(event.target.checked)}
          />
          <span>Publish to discovery</span>
        </label>
        <div className="row">
          {!inline ? (
            <button
              className="btn"
              type="button"
              onClick={() => submitReply(objectId, replyText)}
              disabled={!replyText.trim()}
            >
              Send reply
            </button>
          ) : null}
          <button
            className="btn secondary"
            type="button"
            onClick={() => cancelReply(objectId)}
          >
            Cancel
          </button>
        </div>
      </>
    );
    const textarea = (
      <div className="markdown-compose-field">
        <textarea
          ref={objectId === post.object.object_id ? selectedReplyTextareaRef : undefined}
          value={replyText}
          onChange={(event) => setReplyDrafts((drafts) => ({ ...drafts, [objectId]: event.target.value }))}
          placeholder={`Reply to ${authorName}...`}
          aria-label={`Reply to ${authorName}`}
        />
        <MarkdownHelp />
      </div>
    );

    if (inline) {
      return (
        <div className="conversation-inline-composer">
          <IdentityAvatar seed={myPeerId ?? myPublicKey ?? ''} size={36} alt="" />
          <div className="conversation-inline-fields">
            <div className="conversation-inline-input-row">
              {textarea}
              <button
                className="btn"
                type="button"
                onClick={() => submitReply(objectId, replyText)}
                disabled={!replyText.trim()}
              >
                Send
              </button>
            </div>
            <div className="conversation-inline-options">{composerControls}</div>
          </div>
        </div>
      );
    }

    return (
      <>
        {textarea}
        {composerControls}
      </>
    );
  };

  const renderPost = (currentPost: LocalPostView, isRoot = false, isFocused = false, isAncestor = false) => {
    const objectId = currentPost.object.object_id;
    if (postTombstones.has(objectId)) {
      return (
        <div
          className={`${isRoot ? 'conversation-current' : isAncestor ? 'conversation-ancestor' : 'conversation-reply'} conversation-deleted-post`}
          data-conversation-post-id={objectId}
          key={objectId}
          role="status"
          aria-label="Deleted post"
        >
          <span>[Deleted post]</span>
        </div>
      );
    }
    const recommendationSummary = getRecommendationSummary(objectId);
    const matchingContact = contacts.find((contact) =>
      contact.fingerprint === currentPost.authorFingerprint || contact.publicKey === currentPost.object.author
    );
    const authorName = getAuthorName(currentPost);
    const isReplying = replyingToPostId === objectId;

    return (
      <div
        className={`${isRoot ? 'conversation-current' : isAncestor ? 'conversation-ancestor' : 'conversation-reply'}${isFocused ? ' conversation-focused-reply' : ''}`}
        data-conversation-post-id={objectId}
        tabIndex={isFocused ? -1 : undefined}
        aria-current={isFocused ? 'location' : undefined}
        key={objectId}
      >
        <PostCard
          post={currentPost}
          replyCount={replyCounts?.get(objectId) ?? 0}
          likeCount={recommendationSummary.active_recommender_count}
          authorName={authorName}
          authorDisplayName={matchingContact?.displayName}
          authorId={matchingContact?.fingerprint ?? currentPost.authorFingerprint}
          authorOnline={
            currentPost.object.author !== myPublicKey
            && matchingContact?.online === true
          }
          onAuthorClick={() => onAuthorClick(matchingContact?.fingerprint ?? currentPost.authorFingerprint)}
          onOpenPost={isRoot ? undefined : () => onOpenPost(objectId)}
          onLike={() => onLike(objectId)}
          onDislike={() => onDislike(objectId)}
          onHide={onHide}
          onDelete={onDelete}
          onReply={() => toggleReplyComposer(objectId)}
          isLiked={recommendationSummary.recommended_by_me}
          isOwnPost={currentPost.authorFingerprint === myPeerId || currentPost.object.author === myPublicKey}
          replyComposer={!isRoot && isReplying ? renderReplyComposer(currentPost, authorName) : null}
        />
      </div>
    );
  };

  return (
    <section className="page-view conversation-page">
      <header className="conversation-header">
        {parentId ? (
          parentTombstone ? (
            <button className="btn secondary conversation-back" type="button" disabled aria-label="Parent post deleted">
              <span aria-hidden="true">←</span>
              <span>Parent [Deleted post]</span>
            </button>
          ) : parentPost ? (
            <button className="btn secondary conversation-back" type="button" onClick={() => onOpenParent(parentId, post.object.object_id)} aria-label="View parent post">
              <span aria-hidden="true">←</span>
              <span>Parent</span>
            </button>
          ) : ancestry?.loading ? (
            <button className="btn secondary conversation-back" type="button" disabled aria-label="Loading parent post">
              <span aria-hidden="true">←</span>
              <span>Loading parent</span>
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

      <div className="conversation-posts">
        <div className="conversation-ancestry">
          {ancestry?.loading ? <p className="conversation-ancestry-note note">Loading earlier context…</p> : null}
          {ancestry?.error ? (
            <div className="conversation-unavailable-ancestor" role="status">
              <span className="conversation-context-avatar" aria-hidden="true">?</span>
              <span className="note">Earlier context could not be loaded.</span>
            </div>
          ) : null}
          {ancestry?.result?.stopReason === 'missing'
            && !threadAncestors.some((item) => 'target_object_id' in item) ? (
            <div className="conversation-unavailable-ancestor" role="status">
              <span className="conversation-context-avatar" aria-hidden="true">?</span>
              <span className="note">Earlier post is unavailable on this device.</span>
            </div>
          ) : null}
          {ancestry?.result?.stopReason === 'depth-limit' ? (
            <p className="conversation-ancestry-note note">Earlier context is incomplete; the ancestry depth limit was reached.</p>
          ) : null}
          {threadAncestors.map((ancestor) => 'target_object_id' in ancestor ? (
            <div
              className="conversation-ancestor conversation-deleted-post"
              data-conversation-post-id={ancestor.target_object_id}
              key={ancestor.target_object_id}
              role="status"
              aria-label="Deleted post"
            >
              <span>[Deleted post]</span>
            </div>
          ) : renderPost(ancestor, false, false, true))}
          {renderPost(post, true)}
        </div>
        <div className="conversation-reply-boundary">
          {replyingToPostId === post.object.object_id ? (
            <div className="conversation-selected-composer">
              {renderReplyComposer(post, selectedAuthorName, true)}
            </div>
          ) : (
            <button
              className="conversation-reply-placeholder"
              type="button"
              aria-label={`Reply to ${selectedAuthorName}`}
              onClick={activateSelectedReplyComposer}
              onFocus={activateSelectedReplyComposer}
            >
              <IdentityAvatar seed={myPeerId ?? myPublicKey ?? ''} size={36} alt="" />
              <span>Post your reply...</span>
            </button>
          )}
        </div>
        <div className="conversation-replies">
        {visibleReplies.length > 0 ? (
          visibleReplies.map((reply) => renderPost(reply, false, reply.object.object_id === focusedPostId))
        ) : (
          <p className="conversation-empty note">No direct replies are available in the posts currently loaded on this device.</p>
        )}
        </div>
      </div>
    </section>
  );
}

function collectThreadAncestors(
  post: LocalPostView,
  resolvedAncestors: readonly LocalPostView[],
  posts: readonly LocalPostView[],
  tombstones: readonly DeletionTombstone[]
): Array<LocalPostView | DeletionTombstone> {
  const descendantIds = new Set([post.object.object_id]);
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    for (const candidate of posts) {
      const candidateId = candidate.object.object_id;
      const parentId = postReplyTo(candidate);
      if (parentId && descendantIds.has(parentId) && !descendantIds.has(candidateId)) {
        descendantIds.add(candidateId);
        foundDescendant = true;
      }
    }
  }
  const objectsById = new Map(
    [...resolvedAncestors, ...posts]
      .filter((candidate) => !descendantIds.has(candidate.object.object_id))
      .map((candidate) => [candidate.object.object_id, candidate])
  );
  const tombstonesById = new Map(tombstones
    .filter((item) => item.target_object_type === 'mycelium.post')
    .map((item) => [item.target_object_id, item]));
  const visited = new Set([post.object.object_id]);
  const newestFirst: Array<LocalPostView | DeletionTombstone> = [];
  let current = post;

  while (newestFirst.length < 32) {
    const parentId = postReplyTo(current);
    if (!parentId || visited.has(parentId)) break;
    visited.add(parentId);
    const tombstone = tombstonesById.get(parentId);
    if (tombstone) {
      newestFirst.push(tombstone);
      break;
    }
    const parent = objectsById.get(parentId);
    if (parent) {
      newestFirst.push(parent);
      current = parent;
      continue;
    }
    break;
  }

  return newestFirst.reverse();
}
