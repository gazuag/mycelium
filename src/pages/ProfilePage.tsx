import { useEffect, useMemo, useState } from 'react';
import type { Contact, StoredPost } from '../types';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { ProfileHeader } from '../components/ProfileHeader';
import { PostCard } from '../components/PostCard';
import { displayNameOrFallback } from '../utils/fingerprintNames';

const PROFILE_LOAD_STEP = 50;

interface ProfilePageProps {
  contact: Contact;
  posts: StoredPost[];
  likedPosts: StoredPost[];
  myPeerId?: string;
  onFollowToggle?: () => void;
  onBlock?: () => void;
  onMessage?: () => void;
  onAuthorClick: (peerId: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
  onHide?: (postId: string) => void;
  notice?: string | null;
  isOwnProfile?: boolean;
  profileSettings?: React.ReactNode;
  profileSettingsOpen?: boolean;
  onToggleProfileSettings?: () => void;
}

export function ProfilePage({
  contact,
  posts,
  likedPosts,
  myPeerId,
  onFollowToggle,
  onBlock,
  onMessage,
  onAuthorClick,
  onLike,
  onDislike,
  onHide,
  notice,
  isOwnProfile = false,
  profileSettings,
  profileSettingsOpen = false,
  onToggleProfileSettings
}: ProfilePageProps) {
  const [activeTab, setActiveTab] = useState<'posts' | 'liked'>('posts');
  const [visiblePostsCount, setVisiblePostsCount] = useState(PROFILE_LOAD_STEP);
  const [visibleLikedCount, setVisibleLikedCount] = useState(PROFILE_LOAD_STEP);

  useEffect(() => {
    setVisiblePostsCount(PROFILE_LOAD_STEP);
    setVisibleLikedCount(PROFILE_LOAD_STEP);
  }, [contact.fingerprint, posts.length, likedPosts.length]);

  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [posts]
  );
  const sortedLikedPosts = useMemo(
    () => [...likedPosts].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [likedPosts]
  );
  const activeItems = activeTab === 'posts' ? sortedPosts : sortedLikedPosts;
  const visibleItems = activeTab === 'posts'
    ? sortedPosts.slice(0, visiblePostsCount)
    : sortedLikedPosts.slice(0, visibleLikedCount);
  const remainingItems = Math.max(0, activeItems.length - visibleItems.length);

  return (
    <section className="page-view profile-page">
      <div className="page-header compact-profile-header">
        <h2>{isOwnProfile ? `Profile of ${displayNameOrFallback(contact.displayName, contact.fingerprint)}` : `Profile of ${displayNameOrFallback(contact.displayName, contact.fingerprint)}`}</h2>
      </div>

      {notice ? (
        <div className="card note-box">
          <p className="note">{notice}</p>
        </div>
      ) : null}

      <ProfileHeader
        contact={contact}
        myPeerId={myPeerId}
        onFollowToggle={onFollowToggle}
        onBlock={onBlock}
        onMessage={onMessage}
        showOnlineIndicator={!isOwnProfile}
        showActions={!isOwnProfile && Boolean(onFollowToggle && onBlock && onMessage)}
      />

      {isOwnProfile && profileSettings ? (
        <CollapsibleSection
          title="Profile settings"
          isOpen={profileSettingsOpen}
          onToggle={onToggleProfileSettings ?? (() => undefined)}
        >
          {profileSettings}
        </CollapsibleSection>
      ) : null}

      <div className="segment-control">
        <button className={activeTab === 'posts' ? 'active' : ''} type="button" onClick={() => setActiveTab('posts')}>Posts</button>
        <button className={activeTab === 'liked' ? 'active' : ''} type="button" onClick={() => setActiveTab('liked')}>Liked</button>
      </div>

      {activeItems.length === 0 ? (
        <div className="empty-state card"><p>No posts found for this profile.</p></div>
      ) : (
        <>
          <div className="feed-list">
            {visibleItems.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                authorName={displayNameOrFallback(
                  post.authorDisplayName || (post.authorFingerprint === contact.fingerprint ? contact.displayName : undefined),
                  post.authorFingerprint || (post.author === contact.publicKey ? contact.fingerprint : post.author)
                )}
                authorId={post.authorFingerprint || (post.author === contact.publicKey ? contact.fingerprint : post.author)}
                onAuthorClick={() => onAuthorClick(post.authorFingerprint || (post.author === contact.publicKey ? contact.fingerprint : post.author))}
                onLike={() => onLike(post.id)}
                onDislike={() => onDislike(post.id)}
                onHide={onHide}
                onReply={() => {} }
                isOwnPost={isOwnProfile}
              />
            ))}
          </div>
          {remainingItems > 0 ? (
            <div className="card" style={{ marginTop: '1rem' }}>
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  if (activeTab === 'posts') {
                    setVisiblePostsCount((count) => count + PROFILE_LOAD_STEP);
                    return;
                  }
                  setVisibleLikedCount((count) => count + PROFILE_LOAD_STEP);
                }}
              >
                Load more ({remainingItems} left)
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
