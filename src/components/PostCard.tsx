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
  isLiked?: boolean;
  footerActions?: React.ReactNode;
  recommendationLabel?: string;
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
  isLiked: isLikedOverride,
  footerActions,
  recommendationLabel,
  replyComposer,
  showDislikeButton = true,
  isOwnPost = false
}: PostCardProps) {
  const fingerprintLike = /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/i.test(authorId);
  const keyLabel = fingerprintLike ? authorId : undefined;
  const isLiked = isLikedOverride ?? false;

  return (
    <article className={`post-card${recommendationLabel ? ' recommended' : ''}`}>
      <div className="post-card-header">
        <div className="post-author-line">
          <IdentityAvatar seed={authorId} size={36} alt={authorName} />
          <button className="ghost-link post-author-button" onClick={() => onAuthorClick(authorId)} type="button">
            <strong>{authorName}</strong>
            {keyLabel ? <span className="note">{keyLabel}</span> : null}
          </button>
        </div>
        <span className="note">{new Date(post.object.created_at).toLocaleString()}</span>
      </div>

      {recommendationLabel ? (
        <div className="recommendation-badge">{recommendationLabel}</div>
      ) : null}

      <p className="post-content">{postContent(post)}</p>

      {postTags(post).length > 0 ? (
        <div className="post-tags">{postTags(post).map((tag) => <span key={tag} className="tag">#{tag}</span>)}</div>
      ) : null}

      <div className="post-card-actions">
        <div className="post-actions">
          <LikeButton isLiked={isLiked} onToggle={onLike} disabled={isOwnPost} />
          {showDislikeButton && !isLiked ? (
            <HideButton postId={post.object.object_id} onHide={onHide ?? (() => onDislike())} />
          ) : null}
          <button className="chip" onClick={() => onReply()} type="button">Reply</button>
        </div>
        {footerActions ? <div className="post-footer-actions">{footerActions}</div> : null}
      </div>

      {replyComposer ? <div className="reply-composer-wrap">{replyComposer}</div> : null}
    </article>
  );
}
