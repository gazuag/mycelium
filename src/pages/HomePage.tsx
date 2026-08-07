import { useState } from 'react';
import type { Contact, StoredPost } from '../types';
import { PostCard } from '../components/PostCard';

interface HomePageProps {
  posts: StoredPost[];
  contacts: Contact[];
  postText: string;
  onPostTextChange: (value: string) => void;
  onSubmitPost: (publish: boolean) => void;
  onRefreshPosts: () => void;
  canCreatePost: boolean;
  onAuthorClick: (peerId: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
  onReply: (postId: string) => void;
  onHide: (postId: string) => void;
}

export function HomePage({
  posts,
  contacts,
  postText,
  onPostTextChange,
  onSubmitPost,
  onRefreshPosts,
  canCreatePost,
  onAuthorClick,
  onLike,
  onDislike,
  onReply,
  onHide
}: HomePageProps) {
  const [visibleCount, setVisibleCount] = useState(8);
  const [publishToDiscovery, setPublishToDiscovery] = useState(true);

  const visiblePosts = posts.slice(0, visibleCount);

  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Home</h2>
        <p className="note">New posts from people you follow.</p>
        <div className="page-header-actions">
          <button className="btn secondary" type="button" onClick={onRefreshPosts}>Refresh posts</button>
        </div>
      </div>

      <div className="card home-composer">
        <h3>Create Post</h3>
        <textarea
          value={postText}
          onChange={(event) => onPostTextChange(event.target.value)}
          placeholder="Share what is happening..."
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={publishToDiscovery}
            onChange={(event) => setPublishToDiscovery(event.target.checked)}
          />
          <span>Publish to discovery</span>
        </label>
        <div className="row">
          <button
            className="btn"
            type="button"
            onClick={() => onSubmitPost(publishToDiscovery)}
            disabled={!canCreatePost || !postText.trim()}
          >
            Send
          </button>
        </div>
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
