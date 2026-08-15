import { useEffect, useState } from 'react';
import type { Contact } from '../types';
import { PeerCard } from '../components/PeerCard';
import { CollapsibleSection } from '../components/CollapsibleSection';

interface PeoplePageProps {
  contacts: Contact[];
  onViewProfile: (peerId: string) => void;
  onMessage: (peerId: string) => void;
  onToggleFollow: (peerId: string) => void;
  onBlockPeer?: (peerId: string) => void;
  onAddPeerAddress: (address: string) => Promise<void>;
}

export function PeoplePage({ contacts, onViewProfile, onMessage, onToggleFollow, onBlockPeer, onAddPeerAddress }: PeoplePageProps) {
  const [newPeerAddress, setNewPeerAddress] = useState('');

  const unreadInbox = contacts.filter((c) => (c.unreadMessages || 0) > 0);
  const friends = contacts.filter((c) => c.followed && c.follower && (c.unreadMessages || 0) === 0);
  const following = contacts.filter((c) => c.followed && !c.follower && (c.unreadMessages || 0) === 0);
  const followers = contacts.filter((c) => !c.followed && c.follower && (c.unreadMessages || 0) === 0);
  const everyoneElse = contacts.filter((c) => !c.followed && !c.follower && (c.unreadMessages || 0) === 0);

  const [openGroups, setOpenGroups] = useState({
    inbox: unreadInbox.length > 0,
    friends: friends.length > 0,
    following: following.length > 0,
    followers: followers.length > 0,
    everyone: everyoneElse.length > 0
  });

  useEffect(() => {
    setOpenGroups((prev) => ({
      inbox: unreadInbox.length > 0 ? true : false,
      friends: friends.length > 0 ? true : false,
      following: following.length > 0 ? true : false,
      followers: followers.length > 0 ? true : false,
      everyone: everyoneElse.length > 0 ? true : false
    }));
  }, [unreadInbox.length, friends.length, following.length, followers.length, everyoneElse.length]);

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
              onBlock={onBlockPeer}
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
      <div className="card add-peer-card">
        <h3>Add Peer by Address</h3>
        <p className="note">Paste peer node ID or public key, then add and connect.</p>
        <div className="row">
          <input
            value={newPeerAddress}
            onChange={(event) => setNewPeerAddress(event.target.value)}
            placeholder="Peer address"
          />
          <button
            className="btn"
            type="button"
            onClick={async () => {
              const normalized = newPeerAddress.trim();
              if (!normalized) return;
              await onAddPeerAddress(normalized);
              setNewPeerAddress('');
            }}
          >
            Add peer
          </button>
        </div>
      </div>
      {renderGroup('Unread Inbox', unreadInbox, 'inbox')}
      {renderGroup('Friends', friends, 'friends')}
      {renderGroup('Following', following, 'following')}
      {renderGroup('Followers', followers, 'followers')}
      {renderGroup('Follow Suggestions', everyoneElse, 'everyone')}
    </section>
  );
}
