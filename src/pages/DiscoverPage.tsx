import type { Contact, StoredPost } from '../types';
import { PostCard } from '../components/PostCard';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface DiscoverPageProps {
  discoveryPosts: StoredPost[];
  contacts: Contact[];
  onRefreshDiscovery: () => void;
  onAuthorClick: (peerId: string) => void;
  onAddContact: (publicKey: string) => void;
  onFollow: (publicKey: string) => void;
  onLike: (postId: string) => void;
  onDislike: (postId: string) => void;
  onHide: (postId: string) => void;
  onSave: (post: StoredPost) => void;
}

export function DiscoverPage({ discoveryPosts, contacts, onRefreshDiscovery, onAuthorClick, onAddContact, onFollow, onLike, onDislike, onHide, onSave }: DiscoverPageProps) {
  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Discover</h2>
        <p className="note">Explore public posts from the wider network.</p>
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
            const authorName = matchedContact
              ? displayNameOrFallback(matchedContact.displayName, matchedContact.fingerprint || matchedContact.publicKey || post.author)
              : post.authorDisplayName?.trim() || 'Unknown peer';

            return (
              <PostCard
                key={post.id}
                post={post}
                authorName={authorName}
                authorId={post.author}
                onAuthorClick={onAuthorClick}
                onLike={() => onLike(post.id)}
                onDislike={() => onDislike(post.id)}
                onReply={() => {} }
                footerActions={
                  <div className="discover-actions">
                    <button className="chip" type="button" onClick={() => onAddContact(post.author)}>Add contact</button>
                    <button className="chip" type="button" onClick={() => onFollow(post.author)}>Follow</button>
                    <button className="chip secondary" type="button" onClick={() => onHide(post.id)}>Hide</button>
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
