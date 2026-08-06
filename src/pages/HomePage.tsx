import { useState } from 'react';
import type { Contact, StoredPost } from '../types';
import { PostCard } from '../components/PostCard';

interface HomePageProps {
  posts: StoredPost[];
  contacts: Contact[];
  onAuthorClick: (peerId: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
  onReply: (postId: string) => void;
  onHide: (postId: string) => void;
}

export function HomePage({ posts, contacts, onAuthorClick, onLike, onDislike, onReply, onHide }: HomePageProps) {
  const [visibleCount, setVisibleCount] = useState(8);

  const visiblePosts = posts.slice(0, visibleCount);

  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Home</h2>
        <p className="note">New posts from people you follow.</p>
      </div>

      {visiblePosts.length === 0 ? (
        <div className="empty-state card">
          <p>No posts yet. Follow peers to build your feed.</p>
        </div>
      ) : (
        <div className="feed-list">
          {visiblePosts.map((post) => {
            const author = post.author === 'local' || post.author === contacts.find((c) => c.fingerprint === post.author)?.fingerprint ?
              (contacts.find((c) => c.fingerprint === post.author)?.displayName ?? post.author.slice(0, 16)) :
              post.author.slice(0, 16);

            return (
              <PostCard
                key={post.id}
                post={post}
                authorName={post.author === (contacts.find((c) => c.fingerprint === post.author)?.fingerprint) ?
                  contacts.find((c) => c.fingerprint === post.author)?.displayName ?? 'Unknown' :
                  post.author === post.author ? author : author}
                authorId={post.author}
                onAuthorClick={onAuthorClick}
                onLike={() => onLike(post.id)}
                onDislike={() => { onDislike(post.id); onHide(post.id); }}
                onReply={() => onReply(post.id)}
              />
            );
          })}
        </div>
      )}

      {visibleCount < posts.length ? (
        <div className="load-more-wrap">
          <button className="btn secondary" type="button" onClick={() => setVisibleCount((prev) => prev + 8)}>
            Load more
          </button>
        </div>
      ) : null}
    </section>
  );
}
