import type { Contact, StoredPost } from '../types';
import { FollowButton } from '../components/FollowButton';
import { PostCard } from '../components/PostCard';
import { BlockButton } from '../components/BlockButton';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface DiscoverPageProps {
  discoveryPosts: StoredPost[];
  contacts: Contact[];
  myPeerId?: string;
  myPublicKey?: string;
  onRefreshDiscovery: () => void;
  onAuthorClick: (peerId: string) => void;
  onFollow: (publicKey: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
  onHide?: (postId: string) => void;
  onBlock: (peerId: string) => void;
  onSave: (post: StoredPost) => void;
}

export function DiscoverPage({ discoveryPosts, contacts, myPeerId, myPublicKey, onRefreshDiscovery, onAuthorClick, onFollow, onLike, onDislike, onHide, onBlock, onSave }: DiscoverPageProps) {
  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Discover</h2>
        <p className="note">Discover - Explore public posts from the wider network.</p>
        <div className="page-header-actions">
          <button className="btn secondary" type="button" onClick={onRefreshDiscovery}>Refresh discovery</button>
        </div>
      </div>

      {discoveryPosts.length === 0 ? (
        <div className="empty-state card">
          <p>No discovery posts available yet. Pull to refresh or publish a post.</p>
        </div>
      ) : (
        <div className="feed-list">
          {discoveryPosts.map((post) => {
            const matchedContact = contacts.find((contact) =>
              contact.fingerprint === post.author || contact.publicKey === post.author
            );
            const authorFingerprint = post.authorFingerprint || matchedContact?.fingerprint || post.author;
            const authorName = matchedContact
              ? displayNameOrFallback(matchedContact.displayName, authorFingerprint)
              : post.authorDisplayName?.trim() || displayNameOrFallback(undefined, authorFingerprint);

            return (
              <PostCard
                key={post.id}
                post={post}
                authorName={authorName}
                authorId={authorFingerprint}
                onAuthorClick={() => onAuthorClick(authorFingerprint)}
                onLike={() => onLike(post.id)}
                onDislike={() => onDislike(post.id)}
                onReply={() => {} }
                isOwnPost={authorFingerprint === myPeerId || post.author === myPublicKey}
                showDislikeButton={false}
                footerActions={
                  <div className="discover-actions">
                    <FollowButton
                      peerId={authorFingerprint}
                      contacts={contacts}
                      myPeerId={myPeerId}
                      onToggleFollow={async (peerId) => { await onFollow(peerId); }}
                    />
                    <BlockButton
                      peerId={authorFingerprint}
                      contacts={contacts}
                      myPeerId={myPeerId}
                      onBlock={onBlock}
                    />
                  </div>
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
