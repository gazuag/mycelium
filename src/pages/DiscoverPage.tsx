import { useState } from 'react';
import type { Contact } from '../types';
import type { LocalPostView, RecommendationSummary } from '../object-layer';
import { FollowButton } from '../components/FollowButton';
import { PostCard } from '../components/PostCard';
import { BlockButton } from '../components/BlockButton';
import { PersonRow } from '../components/PersonRow';
import { displayNameOrFallback } from '../utils/fingerprintNames';
import type { PopularPeer } from '../services/peer-discovery';
import { useDmUnread } from '../hooks/useDmUnread';

interface DiscoverPageProps {
  discoveryPosts: LocalPostView[];
  replyCounts?: ReadonlyMap<string, number>;
  contacts: Contact[];
  suggestedPeerIds?: string[];
  popularPeers?: PopularPeer[];
  initialTab?: 'posts' | 'people';
  myPeerId?: string;
  myPublicKey?: string;
  onAuthorClick: (peerId: string) => void;
  onOpenPost?: (postId: string) => void;
  onFollow: (publicKey: string) => void;
  onLike: (objectId: string) => void;
  onDislike: (objectId: string) => void;
  onHide?: (objectId: string) => void;
  onDelete?: (objectId: string) => void;
  onBlock: (peerId: string) => void;
  getRecommendationSummary: (postId: string) => RecommendationSummary;
}

function emptyPeer(peerId: string): Contact {
  return {
    publicKey: peerId,
    fingerprint: peerId,
    addedAt: '',
    followed: false
  };
}

function peerAliases(contact: Contact): string[] {
  return [contact.fingerprint, contact.publicKey].filter(Boolean).map((peerId) => peerId.toLowerCase());
}

export function DiscoverPage({
  discoveryPosts,
  replyCounts,
  contacts,
  suggestedPeerIds = [],
  popularPeers = [],
  initialTab = 'posts',
  myPeerId,
  myPublicKey,
  onAuthorClick,
  onOpenPost,
  onFollow,
  onLike,
  onDislike,
  onHide,
  onDelete,
  onBlock,
  getRecommendationSummary
}: DiscoverPageProps) {
  const [activeTab, setActiveTab] = useState<'posts' | 'people'>(initialTab);
  const { byContact } = useDmUnread();
  const isCurrentUser = (contact: Contact) => (
    contact.fingerprint === myPeerId || contact.publicKey === myPublicKey
  );
  const localSuggestions = contacts.filter((contact) =>
    !contact.followed
    && !contact.follower
    && !isCurrentUser(contact)
    && (byContact[contact.publicKey] ?? 0) === 0
  );
  const suggestedPeople: Contact[] = [];
  const seenSuggestionAliases = new Set<string>();
  const addSuggestedPerson = (contact: Contact) => {
    const aliases = peerAliases(contact);
    if (aliases.some((alias) => seenSuggestionAliases.has(alias))) return;
    aliases.forEach((alias) => seenSuggestionAliases.add(alias));
    suggestedPeople.push(contact);
  };
  localSuggestions.forEach(addSuggestedPerson);
  suggestedPeerIds.forEach((peerId) => {
    if (peerId === myPeerId || peerId === myPublicKey) return;
    const knownContact = contacts.find((candidate) =>
      candidate.fingerprint === peerId || candidate.publicKey === peerId
    );
    if (knownContact) return;
    addSuggestedPerson(emptyPeer(peerId));
  });
  suggestedPeople.sort((left, right) => {
    const onlineOrder = Number(right.online === true) - Number(left.online === true);
    if (onlineOrder !== 0) return onlineOrder;
    const leftSeen = left.lastSeen && Number.isFinite(Date.parse(left.lastSeen)) ? Date.parse(left.lastSeen) : null;
    const rightSeen = right.lastSeen && Number.isFinite(Date.parse(right.lastSeen)) ? Date.parse(right.lastSeen) : null;
    if (leftSeen === null) return rightSeen === null ? 0 : 1;
    if (rightSeen === null) return -1;
    return rightSeen - leftSeen;
  });
  const popularPeople: Array<{ peer: Contact }> = [];
  const seenPopularAliases = new Set<string>();
  for (const popular of popularPeers) {
    if (popularPeople.length >= 10 || popular.peer_id === myPeerId || popular.peer_id === myPublicKey) continue;
    const contact = contacts.find((candidate) =>
      candidate.fingerprint === popular.peer_id || candidate.publicKey === popular.peer_id
    ) ?? emptyPeer(popular.peer_id);
    const aliases = peerAliases(contact);
    if (aliases.some((alias) => seenPopularAliases.has(alias))) continue;
    aliases.forEach((alias) => seenPopularAliases.add(alias));
    popularPeople.push({ peer: contact });
  }

  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Discover</h2>
      </div>

      <div className="discovery-tabs" role="tablist" aria-label="Discovery">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'posts'}
          className={activeTab === 'posts' ? 'active' : ''}
          onClick={() => setActiveTab('posts')}
        >
          Posts
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'people'}
          className={activeTab === 'people' ? 'active' : ''}
          onClick={() => setActiveTab('people')}
        >
          People
        </button>
      </div>

      {activeTab === 'people' ? (
        <div className="discovery-people">
          <section>
            <h3>Popular right now</h3>
            {popularPeople.length > 0 ? (
              <div className="person-list">
                {popularPeople.map(({ peer }) => (
                  <PersonRow
                    key={peer.fingerprint || peer.publicKey}
                    contact={peer}
                    onViewProfile={onAuthorClick}
                    actionLabel={peer.followed ? 'Following' : 'Follow'}
                    onAction={() => onFollow(peer.fingerprint || peer.publicKey)}
                    metric="Reply activity"
                  />
                ))}
              </div>
            ) : <p className="note">No popular people are available yet.</p>}
          </section>
          <section>
            <h3>Suggested people</h3>
            {suggestedPeople.length > 0 ? (
              <div className="person-list">
                {suggestedPeople.map((peer) => (
                  <PersonRow
                    key={peer.fingerprint || peer.publicKey}
                    contact={peer}
                    onViewProfile={onAuthorClick}
                    actionLabel={peer.followed ? 'Following' : 'Follow'}
                    onAction={() => onFollow(peer.fingerprint || peer.publicKey)}
                  />
                ))}
              </div>
            ) : <p className="note">No suggested people are available yet.</p>}
          </section>
        </div>
      ) : (
        discoveryPosts.length === 0 ? (
          <div className="empty-state card">
            <p>No discovery posts available yet. Pull to refresh or publish a post.</p>
          </div>
        ) : (
          <div className="feed-list">
            {discoveryPosts.map((post) => {
              const matchedContact = contacts.find((contact) =>
                contact.fingerprint === post.authorFingerprint || contact.publicKey === post.object.author
              );
              const authorFingerprint = post.authorFingerprint || matchedContact?.fingerprint || post.object.author;
              const authorName = matchedContact
                ? displayNameOrFallback(matchedContact.displayName, authorFingerprint)
                : displayNameOrFallback(undefined, authorFingerprint);
              const recommendationSummary = getRecommendationSummary(post.object.object_id);

              return (
                <PostCard
                  key={post.object.object_id}
                  post={post}
                  replyCount={replyCounts?.get(post.object.object_id) ?? 0}
                  likeCount={recommendationSummary.active_recommender_count}
                  authorName={authorName}
                  authorDisplayName={matchedContact?.displayName}
                  authorId={authorFingerprint}
                  authorOnline={matchedContact?.online === true}
                  onAuthorClick={() => onAuthorClick(authorFingerprint)}
                  onOpenPost={onOpenPost ? () => onOpenPost(post.object.object_id) : undefined}
                  onLike={() => onLike(post.object.object_id)}
                  onDislike={() => onDislike(post.object.object_id)}
                  onDelete={onDelete}
                  onReply={() => {} }
                  isLiked={recommendationSummary.recommended_by_me}
                  isOwnPost={authorFingerprint === myPeerId || post.object.author === myPublicKey}
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
        )
      )}
    </section>
  );
}
