import type { StoredPost } from '../types';

interface PostCardProps {
  post: StoredPost;
  authorName: string;
  authorId: string;
  onAuthorClick: (peerId: string) => void;
  onLike: () => void;
  onDislike: () => void;
  onReply: () => void;
  footerActions?: React.ReactNode;
  recommendationLabel?: string;
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
  recommendationLabel
}: PostCardProps) {
  return (
    <article className={`post-card ${post.isRecommendation ? 'recommended' : ''}`}>
      <div className="post-card-header">
        <button className="ghost-link" onClick={() => onAuthorClick(authorId)} type="button">
          <strong>{authorName}</strong>
          <span className="note">{authorId.slice(0, 16)}</span>
        </button>
        <span className="note">{new Date(post.timestamp).toLocaleString()}</span>
      </div>

      {recommendationLabel ? (
        <div className="recommendation-badge">{recommendationLabel}</div>
      ) : null}

      <p className="post-content">{post.content}</p>

      {post.tags.length > 0 ? (
        <div className="post-tags">{post.tags.map((tag) => <span key={tag} className="tag">#{tag}</span>)}</div>
      ) : null}

      <div className="post-actions">
        <button className="chip" onClick={onLike} type="button">Like</button>
        <button className="chip" onClick={onDislike} type="button">Dislike</button>
        <button className="chip" onClick={onReply} type="button">Reply</button>
      </div>

      {footerActions ? <div className="post-footer-actions">{footerActions}</div> : null}
    </article>
  );
}
