import { useEffect, useState } from 'react';
import type { Contact } from '../types';
import { PersonRow } from '../components/PersonRow';

export type RelationshipTab = 'following' | 'followers';

interface RelationshipsPageProps {
  ownerId: string;
  myPeerId: string;
  initialTab: RelationshipTab;
  contacts: Contact[];
  onTabChange: (tab: RelationshipTab) => void;
  onViewProfile: (peerId: string) => void;
  onToggleFollow: (peerId: string) => void;
}

export function RelationshipsPage({
  ownerId,
  myPeerId,
  initialTab,
  contacts,
  onTabChange,
  onViewProfile,
  onToggleFollow
}: RelationshipsPageProps) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const isOwnRelationships = ownerId === myPeerId;

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const people = isOwnRelationships
    ? contacts.filter((contact) => activeTab === 'following' ? contact.followed : contact.follower)
    : [];
  people.sort((left, right) => Number(right.online === true) - Number(left.online === true));

  const selectTab = (tab: RelationshipTab) => {
    setActiveTab(tab);
    onTabChange(tab);
  };

  return (
    <section className="page-view relationships-page">
      <div className="page-header">
        <h2>{activeTab === 'following' ? 'Following' : 'Followers'}</h2>
      </div>
      <div className="relationship-tabs" role="tablist" aria-label="Profile relationships">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'following'}
          className={activeTab === 'following' ? 'active' : ''}
          onClick={() => selectTab('following')}
        >
          Following
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'followers'}
          className={activeTab === 'followers' ? 'active' : ''}
          onClick={() => selectTab('followers')}
        >
          Followers
        </button>
      </div>
      {!isOwnRelationships ? (
        <p className="note relationship-unavailable" role="status">
          This device does not have {activeTab} information for this profile.
        </p>
      ) : people.length === 0 ? (
        <p className="note relationship-empty">No {activeTab} yet.</p>
      ) : (
        <div className="person-list">
          {people.map((contact) => {
            const isFollowing = Boolean(contact.followed);
            const actionLabel = activeTab === 'following' || isFollowing ? 'Following' : 'Follow back';
            return (
              <PersonRow
                key={contact.fingerprint || contact.publicKey}
                contact={contact}
                onViewProfile={onViewProfile}
                actionLabel={actionLabel}
                onAction={() => onToggleFollow(contact.fingerprint || contact.publicKey)}
                mutualLabel={activeTab === 'following' && contact.follower ? 'Follows you' : undefined}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
