import { useState } from 'react';
import type { Contact, StoredPost } from '../types';
import { ProfileHeader } from '../components/ProfileHeader';
import { PostCard } from '../components/PostCard';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface ProfilePageProps {
  contact: Contact;
  posts: StoredPost[];
  likedPosts: StoredPost[];
  onFollowToggle: () => void;
  onBlock: () => void;
  onMessage: () => void;
  onAuthorClick: (peerId: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
}

export function ProfilePage({ contact, posts, likedPosts, onFollowToggle, onBlock, onMessage, onAuthorClick, onLike, onDislike }: ProfilePageProps) {
  const [activeTab, setActiveTab] = useState<'posts' | 'liked'>('posts');

  const visiblePosts = activeTab === 'posts' ? posts : likedPosts;

  return (
    <section className="page-view profile-page">
      <div className="page-header">
        <h2>Profile</h2>
        <p className="note">{displayNameOrFallback(contact.displayName, contact.fingerprint)}</p>
      </div>

      <ProfileHeader
        contact={contact}
        onFollowToggle={onFollowToggle}
        onBlock={onBlock}
        onMessage={onMessage}
      />

      <div className="segment-control">
        <button className={activeTab === 'posts' ? 'active' : ''} type="button" onClick={() => setActiveTab('posts')}>Posts</button>
        <button className={activeTab === 'liked' ? 'active' : ''} type="button" onClick={() => setActiveTab('liked')}>Liked</button>
      </div>

      {visiblePosts.length === 0 ? (
        <div className="empty-state card"><p>No posts found for this profile.</p></div>
      ) : (
        <div className="feed-list">
          {visiblePosts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              authorName={displayNameOrFallback(contact.displayName, contact.fingerprint)}
              authorId={contact.fingerprint}
              onAuthorClick={onAuthorClick}
              onLike={() => onLike(post.id)}
              onDislike={() => onDislike(post.id)}
              onReply={() => {} }
            />
          ))}
        </div>
      )}
    </section>
  );
}
