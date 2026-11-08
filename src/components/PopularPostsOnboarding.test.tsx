// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalPostView } from '../object-layer';
import type { Contact } from '../types';
import type { IdentityProfilePicture } from '../utils/profile-picture';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { PopularPostsOnboarding } from './PopularPostsOnboarding';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

function makePost(id: string, author: string, content: string): LocalPostView {
  return {
    object: {
      object_id: id,
      object_type: 'mycelium.post',
      author,
      created_at: '2025-01-01T00:00:00.000Z',
      payload: { content },
      signature: 'signature',
      replication_policy: {}
    },
    authorFingerprint: author,
    source: 'discovery'
  };
}

function makeContact(
  peerId: string,
  followed = false,
  displayName?: string,
  profilePicture?: IdentityProfilePicture
): Contact {
  return {
    publicKey: peerId,
    fingerprint: peerId,
    displayName,
    profilePicture,
    addedAt: '2025-01-01T00:00:00.000Z',
    followed
  };
}

describe('PopularPostsOnboarding', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function renderOnboarding(
    posts: LocalPostView[] = [],
    status: 'loading' | 'ready' | 'unavailable' = 'ready',
    onToggleFollow = vi.fn(async () => {}),
    onFinish = vi.fn(),
    contacts: Contact[] = []
  ) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <PopularPostsOnboarding
        posts={posts}
        contacts={contacts}
        status={status}
        myPeerId="me"
        myPublicKey="my-public-key"
        onToggleFollow={onToggleFollow}
        onFinish={onFinish}
      />
    ));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error('Popular-posts onboarding dialog was not rendered.');
    return { dialog, onToggleFollow, onFinish };
  }

  it('renders original-post suggestions without duplicating an author and updates follow state', async () => {
    const peerId = 'aa:bb:cc:dd:ee:ff:00:11';
    const firstPost = makePost('post-1', peerId, 'A **useful** public post with [a source](https://example.com).');
    const duplicateAuthorPost = makePost('post-2', peerId, 'A later post from the same author.');
    const secondPeerId = '11:22:33:44:55:66:77:88';
    const noProfileNamePost = makePost('post-3', secondPeerId, 'A post without profile metadata.');
    const picture: IdentityProfilePicture = {
      mime_type: 'image/webp',
      width: 256,
      height: 256,
      data: 'AQID'
    };
    const longDisplayName = 'UnbrokenDisplayName'.repeat(8);
    let resolveFollow: (() => void) | undefined;
    const onToggleFollow = vi.fn((_peerId: string) => new Promise<void>((resolve) => {
      resolveFollow = resolve;
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    function Harness() {
      const [contacts, setContacts] = useState<Contact[]>([
        makeContact(peerId, false, longDisplayName, picture),
        makeContact('peer-a')
      ]);
      return (
        <PopularPostsOnboarding
          posts={[firstPost, duplicateAuthorPost, noProfileNamePost]}
          contacts={contacts}
          status="ready"
          myPeerId="me"
          myPublicKey="my-public-key"
          onToggleFollow={async (peerId) => {
            await onToggleFollow(peerId);
            setContacts((previous) => previous.map((contact) =>
              contact.publicKey === peerId ? { ...contact, followed: true } : contact
            ));
          }}
          onFinish={vi.fn()}
        />
      );
    }

    await act(async () => root?.render(<Harness />));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error('Popular-posts onboarding dialog was not rendered.');
    expect(dialog.querySelectorAll('.popular-post-onboarding-item')).toHaveLength(2);
    expect(dialog.textContent).not.toContain('A later post from the same author.');
    expect(dialog.querySelector('.popular-post-onboarding-author-details .peer-name-primary')?.textContent).toBe(longDisplayName);
    expect(dialog.querySelector('.popular-post-onboarding-author-details .peer-name-handle')?.textContent)
      .toBe(`@${fingerprintToHumanName(peerId)}`);
    expect(dialog.querySelector('.popular-post-onboarding-author-details .peer-name')?.textContent)
      .toBe(`${longDisplayName}@${fingerprintToHumanName(peerId)}`);
    expect(dialog.querySelector('.popular-post-onboarding-author img')?.getAttribute('src'))
      .toBe('data:image/webp;base64,AQID');
    expect(dialog.querySelectorAll('.popular-post-onboarding-author-details .peer-name-primary')[1]?.textContent)
      .toBe(fingerprintToHumanName(secondPeerId));
    expect(dialog.querySelectorAll('.popular-post-onboarding-author-details .peer-name-handle')).toHaveLength(1);
    expect(dialog.querySelectorAll('.popular-post-onboarding-author img')[1]?.getAttribute('src'))
      .toContain('data:image/svg+xml');
    expect(dialog.querySelector('.popular-post-onboarding-content strong')?.textContent).toBe('useful');
    expect(dialog.querySelector('.popular-post-onboarding-content')?.textContent)
      .toContain('A useful public post with a source.');
    const externalLink = dialog.querySelector<HTMLAnchorElement>('.popular-post-onboarding-content a');
    expect(externalLink?.getAttribute('href')).toBe('#external-link');
    await act(async () => externalLink?.click());
    const linkDialog = document.body.querySelector<HTMLElement>('.external-link-interstitial');
    expect(linkDialog?.textContent).toContain('example.com');
    const goBack = Array.from(linkDialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'Go back');
    await act(async () => goBack?.click());

    const follow = dialog.querySelector<HTMLButtonElement>('.popular-post-onboarding-item button');
    expect(follow?.textContent).toBe('Follow');
    await act(async () => {
      follow?.click();
      await Promise.resolve();
    });
    expect(onToggleFollow).toHaveBeenCalledOnce();
    expect(onToggleFollow).toHaveBeenCalledWith(peerId);
    expect(dialog.querySelector<HTMLButtonElement>('.popular-post-onboarding-item button')?.disabled).toBe(true);
    await act(async () => resolveFollow?.());
    expect(dialog.querySelector('.popular-post-onboarding-item button')?.textContent).toBe('Unfollow');
  });

  it('shows loading and unavailable states without blocking continuation', async () => {
    const onFinish = vi.fn();
    const { dialog } = await renderOnboarding([], 'loading', vi.fn(async () => {}), onFinish);
    expect(dialog.textContent).toContain('Loading public posts from Discover');
    const continueButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Continue to your introduction');
    expect(continueButton).toBeDefined();
    await act(async () => continueButton?.click());
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('explains an empty discovery result and still allows onboarding to finish', async () => {
    const onFinish = vi.fn();
    const { dialog } = await renderOnboarding([], 'ready', vi.fn(async () => {}), onFinish);
    expect(dialog.textContent).toContain('There are no public posts to show right now');
    const continueButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Continue to your introduction');
    await act(async () => continueButton?.click());
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('allows continuing when discovery is unavailable and exits with Escape', async () => {
    const onFinish = vi.fn();
    const { dialog } = await renderOnboarding([], 'unavailable', vi.fn(async () => {}), onFinish);
    expect(dialog.textContent).toContain('Public posts are unavailable right now');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onFinish).toHaveBeenCalledOnce();
  });
});
