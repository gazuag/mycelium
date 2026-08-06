import type { StoredPost } from '../types';
import { PostCard } from '../components/PostCard';

interface DiscoverPageProps {
  discoveryPosts: StoredPost[];
  onAuthorClick: (peerId: string) => void;
  onAddContact: (publicKey: string) => void;
  onFollow: (publicKey: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
  onHide: (postId: string) => void;
  onSave: (post: StoredPost) => void;
}

export function DiscoverPage({ discoveryPosts, onAuthorClick, onAddContact, onFollow, onLike, onDislike, onHide, onSave }: DiscoverPageProps) {
  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Discover</h2>
        <p className="note">Explore public posts from the wider network.</p>
      </div>

      {discoveryPosts.length === 0 ? (
        <div className="empty-state card">
          <p>No discovery posts available yet. Pull to refresh or publish a post.</p>
        </div>
      ) : (
        <div className="feed-list">
          {discoveryPosts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              authorName={post.author.slice(0, 16)}
              authorId={post.author}
              onAuthorClick={onAuthorClick}
              onLike={() => onLike(post.id)}
              onDislike={() => onDislike(post.id)}
              onReply={() => {} }
              footerActions={
                <div className="discover-actions">
                  <button className="chip" type="button" onClick={() => onAddContact(post.author)}>Add contact</button>
                  <button className="chip" type="button" onClick={() => onFollow(post.author)}>Follow</button>
                  <button className="chip" type="button" onClick={() => onSave(post)}>Save</button>
                  <button className="chip secondary" type="button" onClick={() => onHide(post.id)}>Hide</button>
                </div>
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
