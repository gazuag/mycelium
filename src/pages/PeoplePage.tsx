import { useState } from 'react';
import type { Contact } from '../types';
import { PeerCard } from '../components/PeerCard';
import { CollapsibleSection } from '../components/CollapsibleSection';

interface PeoplePageProps {
  contacts: Contact[];
  onViewProfile: (peerId: string) => void;
  onMessage: (peerId: string) => void;
  onToggleFollow: (peerId: string) => void;
}

export function PeoplePage({ contacts, onViewProfile, onMessage, onToggleFollow }: PeoplePageProps) {
  const [openGroups, setOpenGroups] = useState({
    inbox: true,
    friends: true,
    following: true,
    followers: true,
    everyone: true
  });

  const unreadInbox = contacts.filter((c) => (c.unreadMessages || 0) > 0);
  const friends = contacts.filter((c) => c.followed && c.follower);
  const following = contacts.filter((c) => c.followed && !c.follower);
  const followers = contacts.filter((c) => !c.followed && c.follower);
  const everyoneElse = contacts.filter((c) => !c.followed && !c.follower && (c.unreadMessages || 0) === 0);

  const toggleGroup = (group: keyof typeof openGroups) => {
    setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  const renderGroup = (title: string, items: Contact[], key: keyof typeof openGroups) => (
    <CollapsibleSection
      key={title}
      title={title}
      summary={`${items.length} ${items.length === 1 ? 'person' : 'people'}`}
      isOpen={openGroups[key]}
      onToggle={() => toggleGroup(key)}
    >
      {items.length === 0 ? (
        <div className="empty-state card"><p>No one here yet.</p></div>
      ) : (
        <div className="group-list">
          {items.map((contact) => (
            <PeerCard
              key={contact.fingerprint}
              contact={contact}
              onViewProfile={onViewProfile}
              onMessage={onMessage}
              onToggleFollow={onToggleFollow}
            />
          ))}
        </div>
      )}
    </CollapsibleSection>
  );

  return (
    <section className="page-view">
      <div className="page-header">
        <h2>People</h2>
        <p className="note">Manage your contacts, messages, and peers.</p>
      </div>
      {renderGroup('Unread Inbox', unreadInbox, 'inbox')}
      {renderGroup('Friends', friends, 'friends')}
      {renderGroup('Following', following, 'following')}
      {renderGroup('Followers', followers, 'followers')}
      {renderGroup('Everyone Else', everyoneElse, 'everyone')}
    </section>
  );
}
