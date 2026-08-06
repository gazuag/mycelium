import { CollapsibleSection } from '../components/CollapsibleSection';
import { PeerCard } from '../components/PeerCard';
import type { Contact } from '../types';

interface PeoplePageProps {
  contacts: Contact[];
  onOpenProfile: (peerId: string) => void;
  onToggleFollow: (publicKey: string) => void;
  onSelectPeer: (peerId: string) => void;
}

const groupContacts = (contacts: Contact[]) => {
  const unread = contacts.filter((contact) => contact.unreadMessages && contact.unreadMessages > 0);
  const friends = contacts.filter((contact) => contact.followed && contact.follower);
  const following = contacts.filter((contact) => contact.followed && !contact.follower);
  const followers = contacts.filter((contact) => contact.follower && !contact.followed);
  const others = contacts.filter((contact) => !contact.followed && !contact.follower && !(contact.unreadMessages && contact.unreadMessages > 0));
  return { unread, friends, following, followers, others };
};

export function PeoplePage({ contacts, onOpenProfile, onToggleFollow, onSelectPeer }: PeoplePageProps) {
  const groups = groupContacts(contacts);

  return (
    <main className="page-content">
      <section className="section-title">
        <h2>People</h2>
        <p className="note">Your inbox, friends, followers, and everyone else.</p>
      </section>

      <CollapsibleSection title={`Unread Inbox (${groups.unread.length})`} defaultOpen={true}>
        {groups.unread.length === 0 ? <p className="note">No unread messages.</p> : groups.unread.map((contact) => (
          <PeerCard
            key={contact.fingerprint}
            contact={contact}
            onSelect={onSelectPeer}
            onToggleFollow={onToggleFollow}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title={`Friends (${groups.friends.length})`} defaultOpen={true}>
        {groups.friends.length === 0 ? <p className="note">No friends yet.</p> : groups.friends.map((contact) => (
          <PeerCard
            key={contact.fingerprint}
            contact={contact}
            onSelect={onSelectPeer}
            onToggleFollow={onToggleFollow}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title={`Following (${groups.following.length})`} defaultOpen={false}>
        {groups.following.length === 0 ? <p className="note">You are not following anyone yet.</p> : groups.following.map((contact) => (
          <PeerCard
            key={contact.fingerprint}
            contact={contact}
            onSelect={onSelectPeer}
            onToggleFollow={onToggleFollow}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title={`Followers (${groups.followers.length})`} defaultOpen={false}>
        {groups.followers.length === 0 ? <p className="note">No followers yet.</p> : groups.followers.map((contact) => (
          <PeerCard
            key={contact.fingerprint}
            contact={contact}
            onSelect={onSelectPeer}
            onToggleFollow={onToggleFollow}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title={`Everyone Else (${groups.others.length})`} defaultOpen={false}>
        {groups.others.length === 0 ? <p className="note">No other contacts yet.</p> : groups.others.map((contact) => (
          <PeerCard
            key={contact.fingerprint}
            contact={contact}
            onSelect={onSelectPeer}
            onToggleFollow={onToggleFollow}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </CollapsibleSection>
    </main>
  );
}
