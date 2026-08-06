import type { ReactNode } from 'react';
import type { StoredPost } from '../types';

interface PostCardProps {
  post: StoredPost;
  onToggleHide?: (id: string) => void;
  onLike?: (id: string) => void;
  onDislike?: (id: string) => void;
  onReply?: (id: string) => void;
  onOpenProfile?: (author: string) => void;
  extraActions?: ReactNode;
}

export function PostCard({ post, onToggleHide, onLike, onDislike, onReply, onOpenProfile, extraActions }: PostCardProps) {
  return (
    <article className="post-card">
      <div className="post-meta">
        <button className="post-author" onClick={() => onOpenProfile?.(post.author)}>
          <strong>{post.authorDisplayName ?? post.author.slice(0, 12)}</strong>
          <span>{post.author.slice(0, 16)}</span>
        </button>
        <span className="post-time">{new Date(post.timestamp).toLocaleString()}</span>
      </div>
      <p className="post-content">{post.content}</p>
      <div className="post-tags">{post.tags.map((tag) => <span key={tag} className="tag">#{tag}</span>)}</div>
      <div className="post-actions">
        <button className="btn secondary" onClick={() => onLike?.(post.id)}>Like</button>
        <button className="btn secondary" onClick={() => onDislike?.(post.id)}>Dislike</button>
        <button className="btn secondary" onClick={() => onReply?.(post.id)}>Reply</button>
        <button className="btn secondary" onClick={() => onToggleHide?.(post.id)}>Hide</button>
      </div>
      {extraActions && <div className="post-extra-actions">{extraActions}</div>}
    </article>
  );
}
