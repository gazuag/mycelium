import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PostCard } from '../components/PostCard';
import { DiscoverPage } from './DiscoverPage';
import { HomePage } from './HomePage';
import { MyProfilePage } from './MyProfilePage';
import { ProfilePage } from './ProfilePage';
import { createLocalPostView, upsertLocalPostView, type LocalPostView, type PostObject } from '../object-layer';
import type { Contact } from '../types';

const contact: Contact = {
  publicKey: 'author-key',
  fingerprint: 'aa:bb:cc:dd:ee:ff:00:11',
  addedAt: '2026-08-25T00:00:00.000Z',
  followed: true,
  displayName: 'Author'
};

function makeView(metadata: Partial<LocalPostView> = {}): LocalPostView {
  const object: PostObject = {
    object_id: 'a'.repeat(64),
    object_type: 'mycelium.post',
    author: contact.publicKey,
    created_at: '2026-08-25T00:00:00.000Z',
    payload: { content: 'canonical post content', tags: ['stage4c'] },
    replication_policy: {},
    signature: 'signature'
  };
  return createLocalPostView(object, contact.fingerprint, metadata);
}

const noop = vi.fn();

const commonPostProps = {
  authorName: 'Author',
  authorId: contact.fingerprint,
  onAuthorClick: noop,
  onLike: noop,
  onDislike: noop,
  onReply: noop
};

describe('LocalPostView UI migration', () => {
  it('renders PostCard, HomePage, ProfilePage, MyProfilePage, and DiscoverPage from LocalPostView input', () => {
    const view = makeView();
    const postCard = renderToStaticMarkup(<PostCard post={view} {...commonPostProps} />);
    const home = renderToStaticMarkup(
      <HomePage
        posts={[view]}
        contacts={[contact]}
        postText=""
        onPostTextChange={noop}
        onSubmitPost={noop}
        onRefreshPosts={noop}
        canCreatePost
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        onReply={noop}
        onHide={noop}
      />
    );
    const profile = renderToStaticMarkup(
      <ProfilePage
        contact={contact}
        posts={[view]}
        likedPosts={[]}
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
      />
    );
    const myProfile = renderToStaticMarkup(
      <MyProfilePage
        identityId={contact.fingerprint}
        publicKey={contact.publicKey}
        contacts={[contact]}
        posts={[view]}
        nickname="Author"
        bio=""
        blockedPeers={[]}
        followedAuthorsRatio={60}
        followedLikesRatio={40}
        onNicknameChange={noop}
        onBioChange={noop}
        onFollowedAuthorsRatioChange={noop}
        onFollowedLikesRatioChange={noop}
        onSaveProfile={noop}
        onExportIdentity={noop}
        onImportIdentity={noop}
        onCreateIdentity={noop}
        onClearIdentity={noop}
        onUnblockPeer={noop}
      />
    );
    const discover = renderToStaticMarkup(
      <DiscoverPage
        discoveryPosts={[view]}
        contacts={[contact]}
        myPeerId="other-peer"
        myPublicKey="other-key"
        onRefreshDiscovery={noop}
        onAuthorClick={noop}
        onFollow={noop}
        onLike={noop}
        onDislike={noop}
        onBlock={noop}
      />
    );

    expect(postCard).toContain('canonical post content');
    expect(home).toContain('canonical post content');
    expect(profile).toContain('canonical post content');
    expect(myProfile).toContain('Posts');
    expect(discover).toContain('canonical post content');
  });

  it('uses object_id as the sole stable identity when local and peer paths meet', () => {
    const local = makeView({ source: 'local' });
    const peer = makeView({ source: 'peer' });
    const merged = upsertLocalPostView(upsertLocalPostView([], local), peer);

    expect(merged).toHaveLength(1);
    expect(merged[0].object.object_id).toBe(local.object.object_id);
    expect(merged[0].source).toBe('peer');
  });
});
