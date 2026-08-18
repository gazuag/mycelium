import type { StoredPost } from '../types';
import { IdentityAvatar } from './IdentityAvatar';
import { LikeButton } from './LikeButton';

interface PostCardProps {
  post: StoredPost;
  authorName: string;
  authorId: string;
  onAuthorClick: (peerId: string) => void;
  onLike: () => void;
  onDislike: () => void;
  onReply: (content?: string, publishToDiscovery?: boolean) => void;
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
  onReply,
  footerActions,
  recommendationLabel,
  replyComposer,
  showDislikeButton = true,
  isOwnPost = false
}: PostCardProps) {
  const fingerprintLike = /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/i.test(authorId);
  const keyLabel = fingerprintLike ? authorId : undefined;

  return (
    <article className={`post-card ${post.isRecommendation ? 'recommended' : ''}`}>
      <div className="post-card-header">
        <div className="post-author-line">
          <IdentityAvatar seed={authorId} size={36} alt={authorName} />
          <button className="ghost-link post-author-button" onClick={() => onAuthorClick(authorId)} type="button">
            <strong>{authorName}</strong>
            {keyLabel ? <span className="note">{keyLabel}</span> : null}
          </button>
        </div>
        <span className="note">{new Date(post.timestamp).toLocaleString()}</span>
      </div>

      {recommendationLabel ? (
        <div className="recommendation-badge">{recommendationLabel}</div>
      ) : null}

      <p className="post-content">{post.content}</p>

      {post.tags.length > 0 ? (
        <div className="post-tags">{post.tags.map((tag) => <span key={tag} className="tag">#{tag}</span>)}</div>
      ) : null}

      <div className="post-card-actions">
        <div className="post-actions">
          <LikeButton isLiked={post.reaction === 'like'} onToggle={onLike} disabled={isOwnPost} />
          {showDislikeButton && post.reaction !== 'like' ? (
            <button className="chip" onClick={onDislike} type="button">Hide</button>
          ) : null}
          <button className="chip" onClick={() => onReply()} type="button">Reply</button>
        </div>
        {footerActions ? <div className="post-footer-actions">{footerActions}</div> : null}
      </div>

      {replyComposer ? <div className="reply-composer-wrap">{replyComposer}</div> : null}
    </article>
  );
}
