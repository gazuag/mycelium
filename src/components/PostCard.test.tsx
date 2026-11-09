// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalPostView, type LocalPostView, type PostObject } from '../object-layer';
import { PostCard } from './PostCard';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const content = 'a'.repeat(301);
const object: PostObject = {
  object_id: 'a'.repeat(64),
  object_type: 'mycelium.post',
  author: 'author-key',
  created_at: '2026-10-25T00:00:00.000Z',
  payload: { content, tags: [] },
  replication_policy: {},
  signature: 'signature'
};
const post: LocalPostView = createLocalPostView(object, 'author-id');

describe('PostCard content preview', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('renders full Markdown before clipping and expands the complete rendered post', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <PostCard
        post={post}
        authorName="Author"
        authorId="author-id"
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onReply={vi.fn()}
      />
    ));

    const preview = container.querySelector('.post-content .markdown-content')!;
    const moreButton = container.querySelector<HTMLButtonElement>('.post-content-more')!;
    expect(preview.textContent).toBe(content);
    expect(preview.closest('.rendered-post-preview')?.classList.contains('is-collapsed')).toBe(true);
    expect(moreButton.textContent).toBe('more...');
    expect(moreButton.getAttribute('href')).toBeNull();

    await act(async () => moreButton.click());
    expect(container.querySelector('.post-content .markdown-content')?.textContent).toBe(content);
    expect(container.querySelector('.post-content-more')).toBeNull();
    expect(container.querySelector('.rendered-post-preview')?.classList.contains('is-collapsed')).toBe(false);
  });

  it('keeps formatting and links intact beyond the preview cutoff', async () => {
    const markdown = `${'a'.repeat(301)} **bold text** [source](https://example.com)`;
    const markdownPost = createLocalPostView({
      ...object,
      payload: { content: markdown, tags: [] }
    }, 'author-id');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <PostCard
        post={markdownPost}
        authorName="Author"
        authorId="author-id"
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onReply={vi.fn()}
      />
    ));

    expect(container.querySelector('.markdown-content strong')?.textContent).toBe('bold text');
    expect(container.querySelector('.markdown-content a')?.textContent).toBe('source');
    expect(container.querySelector('.post-content-more')).not.toBeNull();
  });

  it('does not show an expand control at the preview length', async () => {
    const shortPost = createLocalPostView({
      ...object,
      payload: { content: 'a'.repeat(300), tags: [] }
    }, 'author-id');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <PostCard
        post={shortPost}
        authorName="Author"
        authorId="author-id"
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onReply={vi.fn()}
      />
    ));

    expect(container.querySelector('.post-content-more')).toBeNull();
  });

  it('renders the larger feed author avatar', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <PostCard
        post={post}
        authorName="Author"
        authorId="author-id"
        onAuthorClick={vi.fn()}
        onLike={vi.fn()}
        onDislike={vi.fn()}
        onReply={vi.fn()}
      />
    ));

    expect(container.querySelector('.post-avatar-button .identity-avatar-wrap')?.getAttribute('style'))
      .toBe('width: 44px; height: 44px;');
  });
});
