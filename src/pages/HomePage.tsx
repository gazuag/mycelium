import { PostCard } from '../components/PostCard';
import type { StoredPost } from '../types';

interface HomePageProps {
  posts: StoredPost[];
  onOpenProfile: (peerId: string) => void;
  onLike: (id: string) => void;
  onDislike: (id: string) => void;
  onHide: (id: string) => void;
}

export function HomePage({ posts, onOpenProfile, onLike, onDislike, onHide }: HomePageProps) {
  return (
    <main className="page-content">
      <section className="section-title">
        <h2>Following feed</h2>
        <p className="note">Newest posts from people you follow.</p>
      </section>
      <div className="feed-list">
        {posts.length === 0 ? (
          <div className="empty-state card">
            <p>No posts yet. Follow peers to fill your feed.</p>
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
