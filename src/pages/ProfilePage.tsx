import { useState } from 'react';
import { ProfileHeader } from '../components/ProfileHeader';
import { PostCard } from '../components/PostCard';
import type { Contact, StoredPost } from '../types';

interface ProfilePageProps {
  contact: Contact;
  posts: StoredPost[];
  likedPosts: StoredPost[];
  onFollowToggle: (publicKey: string) => void;
  onMessage: (peerId: string) => void;
  onBlock: (peerId: string) => void;
  onOpenPostAuthor: (peerId: string) => void;
}

export function ProfilePage({ contact, posts, likedPosts, onFollowToggle, onMessage, onBlock, onOpenPostAuthor }: ProfilePageProps) {
  const [activeTab, setActiveTab] = useState<'posts' | 'liked'>('posts');

  return (
    <main className="page-content">
      <ProfileHeader contact={contact} onFollowToggle={onFollowToggle} onMessage={onMessage} onBlock={onBlock} />
      <div className="segment-control">
        <button className={activeTab === 'posts' ? 'active' : ''} onClick={() => setActiveTab('posts')}>Posts</button>
        <button className={activeTab === 'liked' ? 'active' : ''} onClick={() => setActiveTab('liked')}>Liked</button>
      </div>
      <div className="feed-list">
        {(activeTab === 'posts' ? posts : likedPosts).map((post) => (
          <PostCard
            key={post.id}
            post={post}
            onOpenProfile={onOpenPostAuthor}
            onLike={() => undefined}
            onDislike={() => undefined}
            onToggleHide={() => undefined}
            onReply={() => undefined}
          />
        ))}
      </div>
    </main>
  );
}
