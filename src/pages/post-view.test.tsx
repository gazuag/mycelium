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

const emptyRecommendationSummary = (postId: string) => ({
  post_id: postId,
  active_recommenders: [],
  active_recommender_count: 0,
  followed_recommenders: [],
  followed_recommender_count: 0,
  recommended_by_me: false
});

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
        getRecommendationSummary={emptyRecommendationSummary}
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
        getRecommendationSummary={emptyRecommendationSummary}
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

  it('renders canonical recommendation attribution for one and several recommenders', () => {
    const oneRecommender = {
      ...makeView(),
      homeFeedSource: 'recommendation' as const,
      recommendationSummary: {
        post_id: 'a'.repeat(64),
        active_recommenders: [contact.publicKey],
        active_recommender_count: 1,
        followed_recommenders: [contact.publicKey],
        followed_recommender_count: 1,
        recommended_by_me: false
      }
    };
    const severalRecommenders = {
      ...oneRecommender,
      recommendationSummary: {
        ...oneRecommender.recommendationSummary,
        active_recommenders: [contact.publicKey, 'peer-2', 'peer-3', 'peer-4', 'peer-5'],
        active_recommender_count: 5,
        followed_recommenders: [contact.publicKey, 'peer-2', 'peer-3', 'peer-4', 'peer-5'],
        followed_recommender_count: 5
      }
    };

    const oneMarkup = renderToStaticMarkup(
      <HomePage
        posts={[oneRecommender]}
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
    const severalMarkup = renderToStaticMarkup(
      <HomePage
        posts={[severalRecommenders]}
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

    expect(oneMarkup).toContain('Author recommends this');
    expect(severalMarkup).toContain('Author and 4 others recommend this');
  });

  it('uses canonical own-recommendation state for the like indicator and omits empty attribution', () => {
    const view = {
      ...makeView(),
      homeFeedSource: 'recommendation' as const,
      recommendationSummary: {
        post_id: 'a'.repeat(64),
        active_recommenders: [],
        active_recommender_count: 0,
        followed_recommenders: [],
        followed_recommender_count: 0,
        recommended_by_me: true
      }
    };
    const markup = renderToStaticMarkup(
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

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('recommend this');
  });

  it('keeps canonical like state consistent across profile and discover views', () => {
    const summary = (postId: string) => ({
      ...emptyRecommendationSummary(postId),
      recommended_by_me: true
    });
    const view = makeView();
    const profileMarkup = renderToStaticMarkup(
      <ProfilePage
        contact={contact}
        posts={[view]}
        likedPosts={[]}
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        getRecommendationSummary={summary}
      />
    );
    const discoverMarkup = renderToStaticMarkup(
      <DiscoverPage
        discoveryPosts={[view]}
        contacts={[contact]}
        onRefreshDiscovery={noop}
        onAuthorClick={noop}
        onFollow={noop}
        onLike={noop}
        onDislike={noop}
        onBlock={noop}
        getRecommendationSummary={summary}
      />
    );

    expect(profileMarkup).toContain('aria-pressed="true"');
    expect(discoverMarkup).toContain('aria-pressed="true"');
  });
});
