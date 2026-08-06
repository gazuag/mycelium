import { PostCard } from '../components/PostCard';
import type { StoredPost } from '../types';

interface DiscoverPageProps {
  posts: StoredPost[];
  onOpenProfile: (peerId: string) => void;
  onLike: (id: string) => void;
  onDislike: (id: string) => void;
  onHide: (id: string) => void;
  onFollow: (publicKey: string) => void;
  onAddContact: (publicKey: string) => void;
}

export function DiscoverPage({ posts, onOpenProfile, onLike, onDislike, onHide, onFollow, onAddContact }: DiscoverPageProps) {
  return (
    <main className="page-content">
      <section className="section-title">
        <h2>Discover</h2>
        <p className="note">Explore content from the wider Mycelium network.</p>
      </section>
      <div className="feed-list">
        {posts.length === 0 ? (
          <div className="empty-state card">
            <p>No discovery posts loaded yet. Refresh to load new cards.</p>
          </div>
        ) : (
          posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onOpenProfile={onOpenProfile}
              onLike={onLike}
              onDislike={onDislike}
              onToggleHide={onHide}
              onReply={() => undefined}
            />
          ))
        )}
      </div>
    </main>
  );
}
