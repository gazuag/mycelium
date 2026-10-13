import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PostCard } from '../components/PostCard';
import { DiscoverPage } from './DiscoverPage';
import { HomePage } from './HomePage';
import { MyProfilePage } from './MyProfilePage';
import { PeoplePage } from './PeoplePage';
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
  it('shows only positive reply counts beside Reply and makes the count open the conversation', () => {
    const view = makeView();
    const openPost = vi.fn();
    const noReplies = renderToStaticMarkup(
      <PostCard post={view} {...commonPostProps} onOpenPost={openPost} replyCount={0} />
    );
    const oneReply = renderToStaticMarkup(
      <PostCard post={view} {...commonPostProps} onOpenPost={openPost} replyCount={1} />
    );
    const severalReplies = renderToStaticMarkup(
      <PostCard post={view} {...commonPostProps} onOpenPost={openPost} replyCount={3} />
    );

    expect(noReplies).not.toContain('post-reply-count');
    expect(oneReply).toContain('1 reply</button>');
    expect(oneReply).toContain('aria-label="1 locally known direct reply. Open conversation."');
    expect(severalReplies).toContain('3 replies</button>');
    expect(oneReply).toContain('>Reply</button>');
  });

  it('orders injected Home feed posts by injectedAt and keeps baseline posts chronological', () => {
    const baselineNewest = makeView();
    const injected = makeView();
    const baselineOlder = makeView();
    const posts: LocalPostView[] = [
      {
        ...baselineOlder,
        object: { ...baselineOlder.object, object_id: 'baseline-older', created_at: '2026-08-25T00:00:00.000Z', payload: { content: 'baseline older' } }
      },
      {
        ...injected,
        object: { ...injected.object, object_id: 'injected', created_at: '2026-08-20T00:00:00.000Z', payload: { content: 'injected' } },
        injectedAt: Date.parse('2026-08-26T00:00:00.000Z')
      },
      {
        ...baselineNewest,
        object: { ...baselineNewest.object, object_id: 'baseline-newest', created_at: '2026-08-27T00:00:00.000Z', payload: { content: 'baseline newest' } }
      }
    ];
    const markup = renderToStaticMarkup(
      <HomePage
        posts={posts}
        contacts={[contact]}
        postText=""
        onPostTextChange={noop}
        onSubmitPost={noop}
        canCreatePost
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        onReply={noop}
        onHide={noop}
      />
    );

    expect(markup.indexOf('baseline newest')).toBeLessThan(markup.indexOf('injected'));
    expect(markup.indexOf('injected')).toBeLessThan(markup.indexOf('baseline older'));
  });

  it('renders distinct recommendation and Discovery attribution with recommender names', () => {
    const recommendation = {
      ...makeView(),
      object: { ...makeView().object, object_id: 'recommendation-post', payload: { content: 'recommendation content' } },
      homeFeedSource: 'recommendation' as const,
      recommendationSummary: {
        post_id: 'recommendation-post',
        active_recommenders: ['rec-a', 'rec-b', 'rec-c'],
        active_recommender_count: 3,
        followed_recommenders: ['rec-a', 'rec-b', 'rec-c'],
        followed_recommender_count: 3,
        recommended_by_me: false
      }
    };
    const discovery = {
      ...makeView(),
      object: { ...makeView().object, object_id: 'discovery-post', payload: { content: 'discovery content' } },
      homeFeedSource: 'discovery' as const,
      injectedAt: Date.now()
    };
    const contacts: Contact[] = [
      contact,
      { ...contact, publicKey: 'rec-a', displayName: 'Ada' },
      { ...contact, publicKey: 'rec-b', displayName: 'Bryn' },
      { ...contact, publicKey: 'rec-c', displayName: 'Cy' }
    ];
    const markup = renderToStaticMarkup(
      <HomePage
        posts={[recommendation, discovery]}
        contacts={contacts}
        postText=""
        onPostTextChange={noop}
        onSubmitPost={noop}
        canCreatePost
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        onReply={noop}
        onHide={noop}
      />
    );

    expect(markup).toContain('Ada, Bryn and 1 more recommend this');
    expect(markup).toContain('You might like this');
    expect(markup).toContain('post-card recommended');
    expect(markup).toContain('post-card discovery-injected');
    expect(markup.indexOf('Ada, Bryn and 1 more recommend this')).toBeLessThan(markup.indexOf('recommendation content'));
    expect(markup.indexOf('You might like this')).toBeLessThan(markup.indexOf('discovery content'));
  });

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
    expect(home).not.toContain('New posts from people you follow.');
    expect(home).not.toContain('Refresh posts');
    expect(discover).not.toContain('Discover - Explore public posts from the wider network.');
    expect(discover).not.toContain('Refresh discovery');
  });

  it('does not show the removed People page subtitle', () => {
    const markup = renderToStaticMarkup(
      <PeoplePage
        contacts={[]}
        onViewProfile={noop}
        onMessage={noop}
        onToggleFollow={noop}
        onAddPeerAddress={async () => undefined}
      />
    );

    expect(markup).not.toContain('Manage your contacts, messages, and peers.');
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
        canCreatePost
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        onReply={noop}
        onHide={noop}
      />
    );

    expect(oneMarkup).toContain('Author recommends this');
    expect(severalMarkup).toContain('Author, peer-2 and 3 more recommend this');
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

describe('peer discovery suggestion UI', () => {
  it('shows Stage 2 peer-pool suggestions at the bottom of the People page', () => {
    const markup = renderToStaticMarkup(
      <PeoplePage
        contacts={[]}
        myPeerId="local-peer"
        suggestedPeerIds={['aa:bb:cc:dd:ee:ff:00:22']}
        onViewProfile={noop}
        onMessage={noop}
        onToggleFollow={noop}
        onAddPeerAddress={async () => undefined}
      />
    );

    expect(markup).toContain('Popular Peers');
    expect(markup).toContain('aa:bb:cc:dd:ee:ff:00:22');
    expect(markup).toContain('Follow');
  });

  it('hides popular peer suggestions when the user already follows someone', () => {
    const followedPeer: Contact = {
      publicKey: 'aa:bb:cc:dd:ee:ff:00:22',
      fingerprint: 'aa:bb:cc:dd:ee:ff:00:22',
      addedAt: '2026-08-25T00:00:00.000Z',
      followed: true
    };
    const markup = renderToStaticMarkup(
      <HomePage
        posts={[]}
        contacts={[followedPeer]}
        popularPeers={[{ peer_id: followedPeer.fingerprint, reply_count: 4 }]}
        onFollowPeer={noop}
        postText=""
        onPostTextChange={noop}
        onSubmitPost={noop}
        canCreatePost
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        onReply={noop}
        onHide={noop}
      />
    );

    expect(markup).not.toContain('Popular posters right now.');
    expect(markup).not.toContain('Unfollow');
    expect(markup).not.toContain('aria-label="Dismiss popular peer suggestions"');
    expect(markup).not.toContain('New posts from people you follow.');
    expect(markup).not.toContain('Refresh posts');
  });

  it('shows Stage 3 popular posters on Home when the user follows nobody', () => {
    const markup = renderToStaticMarkup(
      <HomePage
        posts={[]}
        contacts={[]}
        popularPeers={[{ peer_id: 'aa:bb:cc:dd:ee:ff:00:22', reply_count: 4 }]}
        onFollowPeer={noop}
        postText=""
        onPostTextChange={noop}
        onSubmitPost={noop}
        canCreatePost
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        onReply={noop}
        onHide={noop}
      />
    );

    expect(markup).toContain('Popular posters right now.');
    expect(markup).toContain('4 replies');
    expect(markup).toContain('Follow');
  });
});
