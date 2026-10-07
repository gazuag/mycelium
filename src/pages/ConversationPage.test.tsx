import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConversationPage } from './ConversationPage';
import { HomePage } from './HomePage';
import { createLocalPostView, type LocalPostView } from '../object-layer';
import type { Contact } from '../types';

const contact: Contact = {
  publicKey: 'author-key',
  fingerprint: 'aa:bb:cc:dd:ee:ff:00:11',
  addedAt: '2026-08-25T00:00:00.000Z',
  followed: true,
  displayName: 'Author'
};

const root = createLocalPostView({
  object_id: 'a'.repeat(64),
  object_type: 'mycelium.post',
  author: contact.publicKey,
  created_at: '2026-08-25T00:00:00.000Z',
  payload: { content: 'root post' },
  replication_policy: {},
  signature: 'signature'
}, contact.fingerprint);

function makeReply(parentId: string, id: string, content: string, createdAt: string): LocalPostView {
  return createLocalPostView({
    ...root.object,
    object_id: id.repeat(64),
    created_at: createdAt,
    payload: { content, reply_to: parentId }
  }, contact.fingerprint);
}

const recommendationSummary = (postId: string) => ({
  post_id: postId,
  active_recommenders: [],
  active_recommender_count: 0,
  followed_recommenders: [],
  followed_recommender_count: 0,
  recommended_by_me: false
});

describe('ConversationPage', () => {
  it('shows only loaded direct replies in a flat chronological sequence', () => {
    const reply1 = makeReply(root.object.object_id, 'b', 'direct reply 1', '2026-08-25T00:01:00.000Z');
    const reply2 = makeReply(root.object.object_id, 'c', 'direct reply 2', '2026-08-25T00:02:00.000Z');
    const nestedReply = makeReply(reply1.object.object_id, 'd', 'nested reply', '2026-08-25T00:03:00.000Z');
    const html = renderToStaticMarkup(
      <ConversationPage
        post={root}
        posts={[root, reply2, nestedReply, reply1]}
        contacts={[contact]}
        onLeave={vi.fn()}
        onOpenPost={vi.fn()}
        onOpenParent={vi.fn()}
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onHide={vi.fn()}
        onReply={vi.fn()}
        getRecommendationSummary={recommendationSummary}
      />
    );

    expect(html.indexOf('root post')).toBeLessThan(html.indexOf('direct reply 1'));
    expect(html.indexOf('direct reply 1')).toBeLessThan(html.indexOf('direct reply 2'));
    expect(html).not.toContain('nested reply');
    expect(html).toContain('aria-label="Return to previous view"');
  });

  it('offers parent navigation when the parent post is already loaded', () => {
    const reply = makeReply(root.object.object_id, 'b', 'reply to root', '2026-08-25T00:01:00.000Z');
    const html = renderToStaticMarkup(
      <ConversationPage
        post={reply}
        posts={[root, reply]}
        contacts={[contact]}
        onLeave={vi.fn()}
        onOpenPost={vi.fn()}
        onOpenParent={vi.fn()}
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onHide={vi.fn()}
        onReply={vi.fn()}
        getRecommendationSummary={recommendationSummary}
      />
    );

    expect(html).toContain('Replying to Author');
    expect(html).toContain('reply to root');
    expect(html).toContain('aria-label="View parent post"');
  });

  it('keeps an unloaded parent explicitly unavailable without enabling retrieval', () => {
    const reply = makeReply('f'.repeat(64), 'b', 'reply to missing parent', '2026-08-25T00:01:00.000Z');
    const html = renderToStaticMarkup(
      <ConversationPage
        post={reply}
        posts={[reply]}
        contacts={[contact]}
        onLeave={vi.fn()}
        onOpenPost={vi.fn()}
        onOpenParent={vi.fn()}
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onHide={vi.fn()}
        onReply={vi.fn()}
        getRecommendationSummary={recommendationSummary}
      />
    );

    expect(html).toContain('aria-label="Parent post unavailable"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Replying to a post that is not loaded on this device');
  });

  it('keeps loaded replies as individual feed posts without expandable thread controls', () => {
    const reply1 = makeReply(root.object.object_id, 'b', 'direct reply 1', '2026-08-25T00:01:00.000Z');
    const reply2 = makeReply(root.object.object_id, 'c', 'direct reply 2', '2026-08-25T00:02:00.000Z');
    const html = renderToStaticMarkup(
      <HomePage
        posts={[root, reply1, reply2]}
        contacts={[contact]}
        postText=""
        onPostTextChange={vi.fn()}
        onSubmitPost={vi.fn()}
        onRefreshPosts={vi.fn()}
        canCreatePost
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onReply={vi.fn()}
        onHide={vi.fn()}
        onOpenPost={vi.fn()}
      />
    );

    expect(html.indexOf('direct reply 2')).toBeLessThan(html.indexOf('direct reply 1'));
    expect(html.indexOf('direct reply 1')).toBeLessThan(html.indexOf('root post'));
    expect(html).not.toContain('thread-replies-toggle');
    expect(html).not.toContain('post-thread');
  });
});
