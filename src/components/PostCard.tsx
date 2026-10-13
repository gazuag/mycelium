import type { LocalPostView } from '../object-layer';
import { postContent, postTags } from '../object-layer';
import { IdentityAvatar } from './IdentityAvatar';
import { LikeButton } from './LikeButton';
import { HideButton } from './HideButton';

interface PostCardProps {
  post: LocalPostView;
  authorName: string;
  authorId: string;
  onAuthorClick: (peerId: string) => void;
  onLike: () => void;
  onDislike: () => void;
  onHide?: (objectId: string) => void;
  onReply: (content?: string, publishToDiscovery?: boolean) => void;
  onOpenPost?: () => void;
  replyCount?: number;
  isLiked?: boolean;
  footerActions?: React.ReactNode;
  recommendationLabel?: string;
  discoveryLabel?: string;
  feedSource?: 'followed' | 'recommendation' | 'discovery';
  replyComposer?: React.ReactNode;
  showDislikeButton?: boolean;
  isOwnPost?: boolean;
}

export function PostCard({
  post,
  authorName,
  authorId,
  onAuthorClick,
  onLike,
  onDislike,
  onHide,
  onReply,
  onOpenPost,
  replyCount = 0,
  isLiked: isLikedOverride,
  footerActions,
  recommendationLabel,
  discoveryLabel,
  feedSource,
  replyComposer,
  showDislikeButton = true,
  isOwnPost = false
}: PostCardProps) {
  const fingerprintLike = /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/i.test(authorId);
  const keyLabel = fingerprintLike ? authorId : undefined;
  const isLiked = isLikedOverride ?? false;
  const content = postContent(post);

  return (
    <article
      className={`post-card${feedSource === 'recommendation' || recommendationLabel ? ' recommended' : ''}${feedSource === 'discovery' ? ' discovery-injected' : ''}${onOpenPost ? ' has-post-navigation' : ''}`}
      onClick={onOpenPost ? (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('button, a, input, textarea, select, [role="button"]')) return;
        onOpenPost();
      } : undefined}
    >
      <div className="post-card-header">
        <div className="post-author-line">
          <button className="ghost-link post-avatar-button" onClick={() => onAuthorClick(authorId)} type="button" aria-label={`View ${authorName}'s profile`}>
            <IdentityAvatar seed={authorId} size={36} alt="" />
          </button>
          <button className="ghost-link post-author-button" onClick={() => onAuthorClick(authorId)} type="button">
            <strong>{authorName}</strong>
            {keyLabel ? <span className="note">{keyLabel}</span> : null}
          </button>
        </div>
        <span className="note">{new Date(post.object.created_at).toLocaleString()}</span>
      </div>

      <div
        className={`post-open-target${onOpenPost ? ' is-navigable' : ''}`}
        {...(onOpenPost ? {
          role: 'button',
          tabIndex: 0,
          'aria-label': `Open conversation for post by ${authorName}: ${content}`,
          onClick: (event: React.MouseEvent<HTMLDivElement>) => {
            const target = event.target;
            const interactiveTarget = target instanceof Element
              ? target.closest('button, a, input, textarea, select, [role="button"]')
              : null;
            if (interactiveTarget && interactiveTarget !== event.currentTarget) return;
            onOpenPost();
          },
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              const target = event.target;
              if (target instanceof Element && target !== event.currentTarget && target.closest('button, a, input, textarea, select, [role="button"]')) return;
              event.preventDefault();
              onOpenPost();
            }
          }
        } : {})}
      >
        {recommendationLabel || discoveryLabel ? (
          <div className={`feed-attribution${feedSource === 'recommendation' ? ' recommendation-badge' : ''}${feedSource === 'discovery' ? ' discovery-badge' : ''}`}>
            {recommendationLabel ?? discoveryLabel}
          </div>
        ) : null}

        <p className="post-content">{content}</p>

        {postTags(post).length > 0 ? (
          <div className="post-tags">{postTags(post).map((tag) => <span key={tag} className="tag">#{tag}</span>)}</div>
        ) : null}
        {import.meta.env.DEV ? (
          <small className="feed-debug-line">
            [DEBUG: injectedAt={post.injectedAt === undefined ? 'undefined' : new Date(post.injectedAt).toISOString().slice(0, 19)},
            {' '}created={post.object.created_at.slice(0, 19)}, source={feedSource ?? 'unknown'}]
          </small>
        ) : null}
      </div>

      <div className="post-card-actions">
        <div className="post-actions">
          <button className="chip" onClick={() => onReply()} type="button">Reply</button>
          {replyCount > 0 ? (
            onOpenPost ? (
              <button
                className="post-reply-count"
                onClick={onOpenPost}
                type="button"
                aria-label={`${replyCount} locally known direct ${replyCount === 1 ? 'reply' : 'replies'}. Open conversation.`}
                title={`${replyCount} locally known direct ${replyCount === 1 ? 'reply' : 'replies'}; there may be more.`}
              >
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            ) : (
              <span
                className="post-reply-count"
                aria-label={`${replyCount} locally known direct ${replyCount === 1 ? 'reply' : 'replies'}`}
                title={`${replyCount} locally known direct ${replyCount === 1 ? 'reply' : 'replies'}; there may be more.`}
              >
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </span>
            )
          ) : null}
          <LikeButton isLiked={isLiked} onToggle={onLike} disabled={isOwnPost} />
          {showDislikeButton && !isLiked ? (
            <HideButton postId={post.object.object_id} onHide={onHide ?? (() => onDislike())} />
          ) : null}
        </div>
        {footerActions ? <div className="post-footer-actions">{footerActions}</div> : null}
      </div>

      {replyComposer ? <div className="reply-composer-wrap">{replyComposer}</div> : null}
    </article>
  );
}
