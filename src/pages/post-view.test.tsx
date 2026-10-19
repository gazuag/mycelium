import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PostCard } from '../components/PostCard';
import { DiscoverPage } from './DiscoverPage';
import { HomePage } from './HomePage';
import { MyProfilePage } from './MyProfilePage';
import { MessagesPage } from './MessagesPage';
import { ProfilePage } from './ProfilePage';
import { RelationshipsPage } from './RelationshipsPage';
import { PersonRow } from '../components/PersonRow';
import { ProfileHeader } from '../components/ProfileHeader';
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
  it('keeps the Home composer open at the top without redundant headings or toggle controls', () => {
    const markup = renderToStaticMarkup(
      <HomePage
        posts={[]}
        contacts={[]}
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

    expect(markup).toContain('placeholder="Share what is happening..."');
    expect(markup.indexOf('home-composer')).toBeLessThan(markup.indexOf('popular-posters-banner'));
    expect(markup).not.toContain('<h2>Home</h2>');
    expect(markup).not.toContain('<h3>Create Post</h3>');
    expect(markup).not.toContain('>Hide</button>');
    expect(markup).not.toContain('>Write</button>');
  });

  it('renders an automatic feed continuation point with a manual fallback', () => {
    const markup = renderToStaticMarkup(
      <HomePage
        posts={Array.from({ length: 9 }, (_, index) => {
          const view = makeView();
          return {
            ...view,
            object: {
              ...view.object,
              object_id: `home-page-${index}`,
              created_at: new Date(Date.UTC(2026, 7, 25, 0, index)).toISOString()
            }
          };
        })}
        contacts={[]}
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
    expect(markup).toContain('class="home-feed-end"');
    expect(markup).toContain('>Load more</button>');
  });

  it('renders the current user avatar as a profile link beside the Home composer', () => {
    const markup = renderToStaticMarkup(
      <HomePage
        posts={[]}
        contacts={[]}
        myPeerId="my-peer-id"
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
    expect(markup).toContain('class="home-composer-avatar"');
    expect(markup).toContain('aria-label="View your profile"');
    expect(markup).toContain('width="40" height="40"');
    expect(markup).not.toContain('identity-avatar-online');
  });

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

  it('renders the aggregated active-like count accessibly', () => {
    const markup = renderToStaticMarkup(
      <PostCard post={makeView()} {...commonPostProps} likeCount={4} />
    );

    expect(markup).toContain('aria-label="4 people like this"');
    expect(markup).toContain('4 likes');
  });

  it('shows the shared online indicator for an explicitly online post author only', () => {
    const view = makeView();
    const online = renderToStaticMarkup(<PostCard post={view} {...commonPostProps} authorOnline />);
    const offline = renderToStaticMarkup(<PostCard post={view} {...commonPostProps} authorOnline={false} />);
    expect(online).toContain('class="identity-avatar-online"');
    expect(offline).not.toContain('identity-avatar-online');
    expect(online).toContain('Author');
    expect(online).toContain('@');
    expect(offline).toContain('Author');
  });

  it('preserves literal @ text authored in posts', () => {
    const view = makeView();
    const post = { ...view, object: { ...view.object, payload: { content: 'Hello @alice' } } };
    const markup = renderToStaticMarkup(<PostCard post={post} {...commonPostProps} />);

    expect(markup).toContain('Hello @alice');
  });

  it('does not render feed-injection debug metadata on posts', () => {
    const markup = renderToStaticMarkup(
      <PostCard
        post={makeView()}
        {...commonPostProps}
        feedSource="recommendation"
        recommendationLabel="Recommended by Alice"
      />
    );

    expect(markup).not.toContain('[DEBUG:');
    expect(markup).not.toContain('feed-debug-line');
  });

  it('sorts injections by their stable timestamp and moves them down as newer posts arrive', () => {
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
    const renderHomeFeed = (feedPosts: LocalPostView[]) => renderToStaticMarkup(
      <HomePage
        posts={feedPosts}
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
    const markup = renderHomeFeed(posts);

    expect(markup.indexOf('baseline newest')).toBeLessThan(markup.indexOf('injected'));
    expect(markup.indexOf('injected')).toBeLessThan(markup.indexOf('baseline older'));

    const newerPost = {
      ...makeView(),
      object: {
        ...makeView().object,
        object_id: 'baseline-newest-arrival',
        created_at: '2026-08-28T00:00:00.000Z',
        payload: { content: 'baseline newest arrival' }
      }
    };
    const refreshedMarkup = renderHomeFeed([newerPost, ...posts]);
    expect(refreshedMarkup.indexOf('baseline newest arrival')).toBeLessThan(refreshedMarkup.indexOf('injected'));
    expect(refreshedMarkup.indexOf('baseline newest')).toBeLessThan(refreshedMarkup.indexOf('injected'));
    expect(refreshedMarkup.indexOf('baseline newest')).toBeLessThan(refreshedMarkup.indexOf('baseline older'));
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
        followingCount={2}
        followerCount={3}
        onOpenRelationships={noop}
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
    expect(myProfile).toContain('Generated handle');
    expect(myProfile).toContain('readonly=""');
    expect(myProfile).toContain('Display Name');
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
    expect(profile).toContain('Following');
    expect(profile).toContain('Followers');
    expect(myProfile).toContain('Posts');
    expect(discover).toContain('canonical post content');
    expect(home).not.toContain('New posts from people you follow.');
    expect(home).not.toContain('Refresh posts');
    expect(discover).not.toContain('Discover - Explore public posts from the wider network.');
    expect(discover).not.toContain('Refresh discovery');
  });

  it('keeps inbox content out of the removed People page destination', () => {
    const markup = renderToStaticMarkup(
      <MessagesPage
        contacts={[]}
        myPublicKey="my-key"
        myPeerId="my-id"
        conversations={[]}
        previews={{}}
        loading={false}
        error={null}
        previewError={null}
        onOpenChat={noop}
        onViewProfile={noop}
      />
    );

    expect(markup).not.toContain('Manage your contacts, messages, and peers.');
    expect(markup).not.toContain('Unread Inbox');
    expect(markup).not.toContain('Add Peer by Address');
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
    expect(severalMarkup).toContain('Author, Peer and 3 more recommend this');
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

  it('renders the current profile display name instead of a legacy post snapshot', () => {
    const view = makeView({ authorDisplayName: 'Old Author Name' });
    const markup = renderToStaticMarkup(
      <ProfilePage
        contact={{ ...contact, displayName: 'Current Author Name' }}
        posts={[view]}
        likedPosts={[]}
        onAuthorClick={noop}
        onLike={noop}
        onDislike={noop}
        getRecommendationSummary={emptyRecommendationSummary}
      />
    );

    expect(markup).toContain('Current Author Name');
    expect(markup).not.toContain('Old Author Name');
    expect(markup).not.toContain('aa:bb:');
  });
});

describe('relationship and discovery people UI', () => {
  it('shows the shared indicator in profile headers only for online peers', () => {
    const online = renderToStaticMarkup(
      <ProfileHeader contact={{ ...contact, online: true }} showActions={false} />
    );
    const offline = renderToStaticMarkup(
      <ProfileHeader contact={{ ...contact, online: false }} showActions={false} />
    );
    expect(online).toContain('class="identity-avatar-online"');
    expect(offline).not.toContain('identity-avatar-online');
  });

  it('uses the shared online indicator in reusable relationship/person rows', () => {
    const onlineContact: Contact = { ...contact, online: true };
    const offlineContact: Contact = { ...contact, online: false };
    const online = renderToStaticMarkup(<PersonRow contact={onlineContact} onViewProfile={noop} />);
    const offline = renderToStaticMarkup(<PersonRow contact={offlineContact} onViewProfile={noop} />);
    expect(online).toContain('class="identity-avatar-online"');
    expect(offline).not.toContain('identity-avatar-online');
    expect(online).not.toContain('aa:bb:');
    expect(online).toContain('Author');
  });

  it('shows the requested Following or Followers list and the correct existing follow state', () => {
    const contacts: Contact[] = [
      { publicKey: 'mutual-key', fingerprint: 'mutual-id', displayName: 'Mutual', addedAt: '', followed: true, follower: true, online: false },
      { publicKey: 'follower-key', fingerprint: 'follower-id', displayName: 'Follower', addedAt: '', followed: false, follower: true },
      { publicKey: 'following-key', fingerprint: 'following-id', displayName: 'Following Only', addedAt: '', followed: true, follower: false, online: true }
    ];
    const following = renderToStaticMarkup(
      <RelationshipsPage
        ownerId="local-id"
        myPeerId="local-id"
        initialTab="following"
        contacts={contacts}
        onTabChange={noop}
        onViewProfile={noop}
        onToggleFollow={noop}
      />
    );
    const followers = renderToStaticMarkup(
      <RelationshipsPage
        ownerId="local-id"
        myPeerId="local-id"
        initialTab="followers"
        contacts={contacts}
        onTabChange={noop}
        onViewProfile={noop}
        onToggleFollow={noop}
      />
    );

    expect(following).toContain('aria-selected="true" class="active">Following</button>');
    expect(following).toContain('Follows you');
    expect(following.indexOf('Following Only')).toBeLessThan(following.indexOf('Mutual'));
    expect(following).not.toContain('Follower</strong>');
    expect(followers).toContain('aria-selected="true" class="active">Followers</button>');
    expect(followers).toContain('Follow back');
    expect(followers).toContain('>Following</button>');
  });

  it('shows an explicit unavailable state for another profile relationship graph', () => {
    const markup = renderToStaticMarkup(
      <RelationshipsPage
        ownerId="remote-id"
        myPeerId="local-id"
        initialTab="followers"
        contacts={[]}
        onTabChange={noop}
        onViewProfile={noop}
        onToggleFollow={noop}
      />
    );
    expect(markup).toContain('This device does not have followers information for this profile.');
  });

  it('defaults Discovery to Posts and combines/deduplicates existing people suggestions', () => {
    const online: Contact = {
      publicKey: 'online-id',
      fingerprint: 'online-id',
      displayName: 'Online Person',
      addedAt: '',
      followed: false,
      follower: false,
      online: true
    };
    const recent: Contact = {
      publicKey: 'recent-id',
      fingerprint: 'recent-id',
      displayName: 'Recent Person',
      addedAt: '',
      followed: false,
      follower: false,
      online: false,
      lastSeen: '2026-10-14T12:00:00.000Z'
    };
    const old: Contact = {
      publicKey: 'old-id',
      fingerprint: 'old-id',
      displayName: 'Older Person',
      addedAt: '',
      followed: false,
      follower: false,
      online: false,
      lastSeen: '2026-10-13T12:00:00.000Z'
    };
    const props = {
      discoveryPosts: [],
      contacts: [online, recent, old],
      suggestedPeerIds: ['online-id', 'pool-id'],
      popularPeers: Array.from({ length: 12 }, (_, index) => ({
        peer_id: `popular-${String(index + 1).padStart(2, '0')}`,
        activity_score: 3
      })),
      myPeerId: 'local-id',
      myPublicKey: 'local-key',
      onAuthorClick: noop,
      onFollow: noop,
      onLike: noop,
      onDislike: noop,
      onBlock: noop,
      getRecommendationSummary: emptyRecommendationSummary
    };
    const postsTab = renderToStaticMarkup(<DiscoverPage {...props} />);
    const peopleTab = renderToStaticMarkup(<DiscoverPage {...props} initialTab="people" />);

    expect(postsTab).toContain('aria-selected="true" class="active">Posts</button>');
    expect(postsTab).not.toContain('Popular right now');
    expect(peopleTab).toContain('Popular right now');
    expect(peopleTab).not.toContain('popular-01');
    expect(peopleTab).not.toContain('pool-id');
    expect(peopleTab.match(/class="peer-name-primary">Online Person<\/span>/g)).toHaveLength(1);
    expect(peopleTab).not.toContain('@online-id');
    expect(peopleTab).toContain('class="identity-avatar-online"');
    expect(peopleTab.indexOf('Online Person')).toBeLessThan(peopleTab.indexOf('Recent Person'));
    expect(peopleTab.indexOf('Recent Person')).toBeLessThan(peopleTab.indexOf('Older Person'));
  });

  it('does not start a suggestion cycle when the user already follows someone', () => {
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
        popularPeers={[{ peer_id: followedPeer.fingerprint, activity_score: 3 }]}
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
        popularPeers={[{ peer_id: 'aa:bb:cc:dd:ee:ff:00:22', activity_score: 3 }]}
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
    expect(markup).toContain('Reply activity');
    expect(markup).toContain('Follow');
  });
});
