import { useEffect, useMemo, useState } from 'react';
import type { Contact } from '../types';
import type { LocalPostView, RecommendationSummary } from '../object-layer';
import type { RelationshipTab } from './RelationshipsPage';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { ProfileHeader } from '../components/ProfileHeader';
import { PostCard } from '../components/PostCard';
import { CompactUsername } from '../components/CompactUsername';
import { displayNameOrFallback } from '../utils/fingerprintNames';

const PROFILE_LOAD_STEP = 50;

interface ProfilePageProps {
  contact: Contact;
  posts: LocalPostView[];
  likedPosts: LocalPostView[];
  contacts?: Contact[];
  replyCounts?: ReadonlyMap<string, number>;
  myPeerId?: string;
  followingCount?: number;
  followerCount?: number;
  onOpenRelationships?: (tab: RelationshipTab) => void;
  onFollowToggle?: () => void;
  onBlock?: () => void;
  onMessage?: () => void;
  onAuthorClick: (peerId: string) => void;
  onOpenPost?: (postId: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onHide?: (objectId: string) => void;
  onDelete?: (objectId: string) => void;
  notice?: string | null;
  isOwnProfile?: boolean;
  profileSettings?: React.ReactNode;
  profileSettingsOpen?: boolean;
  onToggleProfileSettings?: () => void;
  getRecommendationSummary: (postId: string) => RecommendationSummary;
}

export function ProfilePage({
  contact,
  posts,
  likedPosts,
  contacts = [],
  replyCounts,
  myPeerId,
  followingCount,
  followerCount,
  onOpenRelationships,
  onFollowToggle,
  onBlock,
  onMessage,
  onAuthorClick,
  onOpenPost,
  onLike,
  onDislike,
  onHide,
  onDelete,
  notice,
  isOwnProfile = false,
  profileSettings,
  profileSettingsOpen = false,
  onToggleProfileSettings,
  getRecommendationSummary
}: ProfilePageProps) {
  const [activeTab, setActiveTab] = useState<'posts' | 'liked'>('posts');
  const [visiblePostsCount, setVisiblePostsCount] = useState(PROFILE_LOAD_STEP);
  const [visibleLikedCount, setVisibleLikedCount] = useState(PROFILE_LOAD_STEP);

  useEffect(() => {
    setVisiblePostsCount(PROFILE_LOAD_STEP);
    setVisibleLikedCount(PROFILE_LOAD_STEP);
  }, [contact.fingerprint, posts.length, likedPosts.length]);

  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime()),
    [posts]
  );
  const sortedLikedPosts = useMemo(
    () => [...likedPosts].sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime()),
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
        <h2>
          <CompactUsername
            peerId={contact.fingerprint || contact.publicKey}
            displayName={displayNameOrFallback(contact.displayName, contact.fingerprint || contact.publicKey)}
            onProfileClick={onAuthorClick}
          />
        </h2>
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
        onAvatarClick={() => onAuthorClick(contact.fingerprint || contact.publicKey)}
        showOnlineIndicator={!isOwnProfile}
        showActions={!isOwnProfile && Boolean(onFollowToggle && onBlock && onMessage)}
      />

      {onOpenRelationships ? (
        <div className="profile-relationship-links" aria-label="Profile relationships">
          <button type="button" onClick={() => onOpenRelationships('following')}>
            <strong>{followingCount ?? ''}</strong> Following
          </button>
          <button type="button" onClick={() => onOpenRelationships('followers')}>
            <strong>{followerCount ?? ''}</strong> Followers
          </button>
        </div>
      ) : null}

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
            {visibleItems.map((post) => {
              const postAuthorContact = contacts.find((candidate) => (
                candidate.fingerprint === post.authorFingerprint
                || candidate.publicKey === post.object.author
              ));
              const isProfileAuthor = post.authorFingerprint === contact.fingerprint
                || post.object.author === contact.publicKey;
              const authorContact = isProfileAuthor
                ? contact
                : postAuthorContact;
              const recommendationSummary = getRecommendationSummary(post.object.object_id);
              return <PostCard
                key={post.object.object_id}
                post={post}
                replyCount={replyCounts?.get(post.object.object_id) ?? 0}
                likeCount={recommendationSummary.active_recommender_count}
                authorName={displayNameOrFallback(
                  authorContact?.displayName,
                  post.authorFingerprint
                )}
                authorId={post.authorFingerprint}
                authorOnline={
                  (postAuthorContact?.online === true && !isProfileAuthor)
                  || (isProfileAuthor && !isOwnProfile && contact.online === true)
                }
                onAuthorClick={() => onAuthorClick(post.authorFingerprint)}
                onOpenPost={onOpenPost ? () => onOpenPost(post.object.object_id) : undefined}
                onLike={() => onLike(post.object.object_id)}
                onDislike={() => onDislike(post.object.object_id)}
                onHide={onHide}
                onDelete={onDelete}
                onReply={() => {} }
                isLiked={recommendationSummary.recommended_by_me}
                isOwnPost={isOwnProfile && (
                  post.authorFingerprint === myPeerId || post.object.author === contact.publicKey
                )}
              />;
            })}
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
