// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../types';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { createPeerAddUrl } from '../utils/peerAddUrl';
import { ProfileHeader } from './ProfileHeader';

const profile: Contact = {
  publicKey: 'profile-public-key',
  fingerprint: '00:00:00:00:00:00:00:01',
  addedAt: '2026-01-01T00:00:00.000Z',
  followed: false,
  displayName: 'Alice'
};
const profileWithPicture: Contact = {
  ...profile,
  profilePicture: {
    mime_type: 'image/webp',
    width: 256,
    height: 256,
    data: 'aGVsbG8='
  }
};

const originalShareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'share');
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');

let container: HTMLDivElement;
let root: Root;

function setNavigatorProperty(name: 'share' | 'clipboard', value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value });
}

function restoreNavigatorProperty(name: 'share' | 'clipboard', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(navigator, name, descriptor);
  } else {
    Reflect.deleteProperty(navigator, name);
  }
}

async function clickButton(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderProfile(contact = profile) {
  await act(async () => root.render(
    <ProfileHeader
      contact={contact}
      onFollowToggle={vi.fn()}
      onBlock={vi.fn()}
      onMessage={vi.fn()}
    />
  ));
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreNavigatorProperty('share', originalShareDescriptor);
  restoreNavigatorProperty('clipboard', originalClipboardDescriptor);
  if (originalActEnvironmentDescriptor) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironmentDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
  vi.clearAllMocks();
});

describe('ProfileHeader sharing', () => {
  it('uses a prominent profile avatar and shows remote actions in order', async () => {
    await renderProfile();

    const avatar = container.querySelector('.profile-avatar-actions .identity-avatar-wrap');
    const actionLabels = [...container.querySelectorAll<HTMLButtonElement>('.profile-action-buttons button')]
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim());

    expect(avatar?.classList.contains('profile-main-avatar')).toBe(true);
    expect(container.querySelector('.profile-avatar-tools')).toBeNull();
    expect(actionLabels).toEqual([
      "Message Alice",
      "Show Alice's profile QR code",
      'Follow',
      'More profile actions'
    ]);
    expect(container.querySelector('.profile-title-name strong')?.textContent).toBe('Alice');
    expect(container.querySelector('.profile-handle')?.textContent).toBe(`@${fingerprintToHumanName(profile.fingerprint)}`);
    expect(container.textContent).not.toContain(profile.fingerprint);
  });

  it('opens the full custom profile picture in a centered dialog', async () => {
    const onAvatarClick = vi.fn();
    await act(async () => root.render(
      <ProfileHeader contact={profileWithPicture} showActions={false} onAvatarClick={onAvatarClick} />
    ));

    await clickButton('[aria-label="View Alice\'s profile picture"]');

    const dialog = container.querySelector('[role="dialog"][aria-label="Alice\'s profile picture"]');
    const image = dialog?.querySelector<HTMLImageElement>('img');
    expect(dialog).not.toBeNull();
    expect(image?.src).toBe('data:image/webp;base64,aGVsbG8=');
    expect(image?.width).toBe(256);
    expect(image?.height).toBe(256);
    expect(onAvatarClick).not.toHaveBeenCalled();

    await clickButton('[aria-label="Close profile picture"]');
    expect(container.querySelector('[role="dialog"][aria-label="Alice\'s profile picture"]')).toBeNull();
  });

  it('keeps generated avatar clicks navigating to the profile', async () => {
    const onAvatarClick = vi.fn();
    await act(async () => root.render(
      <ProfileHeader contact={profile} showActions={false} onAvatarClick={onAvatarClick} />
    ));

    await clickButton('[aria-label="View Alice\'s profile"]');

    expect(onAvatarClick).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"][aria-label="Alice\'s profile picture"]')).toBeNull();
  });

  it('closes the profile-picture viewer with Escape', async () => {
    await act(async () => root.render(
      <ProfileHeader contact={profileWithPicture} showActions={false} onAvatarClick={vi.fn()} />
    ));
    await clickButton('[aria-label="View Alice\'s profile picture"]');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(container.querySelector('[role="dialog"][aria-label="Alice\'s profile picture"]')).toBeNull();
  });

  it('uses native sharing with the profile identity and canonical URL', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('share', share);
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');

    await clickButton('[aria-label="Share Alice\'s profile"]');

    expect(share).toHaveBeenCalledWith({
      title: 'Alice',
      text: 'Check out this profile on Mycelium',
      url: createPeerAddUrl(profile.fingerprint, window.location.origin)
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shares an own profile using its generated Mycelium handle', async () => {
    const ownProfile = { ...profile, displayName: undefined };
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('share', share);
    await renderProfile(ownProfile);
    await clickButton('[aria-label="More profile actions"]');

    expect(container.querySelector('.profile-title-name strong')?.textContent)
      .toBe(`@${fingerprintToHumanName(ownProfile.fingerprint)}`);
    expect(container.querySelector('.profile-handle')).toBeNull();

    await clickButton(`[aria-label="Share ${fingerprintToHumanName(ownProfile.fingerprint)}'s profile"]`);

    expect(share).toHaveBeenCalledWith({
      title: fingerprintToHumanName(ownProfile.fingerprint),
      text: 'Check out this profile on Mycelium',
      url: createPeerAddUrl(ownProfile.fingerprint, window.location.origin)
    });
  });

  it('opens the custom share popover when native sharing is unavailable', async () => {
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');

    await clickButton('[aria-label="Share Alice\'s profile"]');

    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).not.toBeNull();
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('Check out this profile on Mycelium');
    expect(container.querySelector('.share-popover-url')?.textContent)
      .toBe(createPeerAddUrl(profile.fingerprint, window.location.origin));
  });

  it('copies the profile link and confirms success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('clipboard', { writeText });
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-copy');

    expect(writeText).toHaveBeenCalledWith(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.textContent).toContain('Link copied.');
  });

  it('provides a selectable link when clipboard access is unavailable', async () => {
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-copy');

    expect(container.querySelector<HTMLInputElement>('.share-popover-manual-url')?.value)
      .toBe(createPeerAddUrl(profile.fingerprint, window.location.origin));
  });

  it('provides a selectable link when clipboard access fails', async () => {
    setNavigatorProperty('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('Denied')) });
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-copy');

    expect(container.querySelector<HTMLInputElement>('.share-popover-manual-url')?.value)
      .toBe(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.textContent).toContain('Copying is unavailable.');
  });

  it('offers email and message actions containing the profile URL', async () => {
    const url = createPeerAddUrl(profile.fingerprint, window.location.origin)!;
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Share Alice\'s profile"]');

    const email = container.querySelector<HTMLAnchorElement>('.share-popover-destinations a[href^="mailto:"]');
    const message = container.querySelector<HTMLAnchorElement>('.share-popover-destinations a[href^="sms:"]');
    expect(decodeURIComponent(email?.getAttribute('href') ?? '')).toContain(url);
    expect(decodeURIComponent(message?.getAttribute('href') ?? '')).toContain(url);
    expect(email?.getAttribute('href')).toContain('subject=');
  });

  it('keeps QR code as an independent action outside the More menu', async () => {
    await renderProfile();

    expect(container.querySelector('[aria-label="Show Alice\'s profile QR code"]')).not.toBeNull();
    await clickButton('[aria-label="Show Alice\'s profile QR code"]');
    expect(container.querySelector('#profile-qr-title')?.textContent).toBe("Alice's profile QR code");
    expect(container.querySelector('.profile-more-menu')).toBeNull();
  });

  it('opens the QR dialog directly from the standalone QR button', async () => {
    await renderProfile();

    await clickButton('[aria-label="Show Alice\'s profile QR code"]');

    expect(container.querySelector('#profile-qr-title')?.textContent).toBe("Alice's profile QR code");
    expect(container.querySelector('[aria-label="More profile actions"]')).not.toBeNull();
  });

  it('copies the peer ID and canonical profile URL from the More menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('clipboard', { writeText });
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');

    expect(container.querySelector('.profile-menu-peer-id code')?.textContent).toBe(profile.fingerprint);
    await clickButton('[aria-label="Copy peer ID"]');
    expect(writeText).toHaveBeenLastCalledWith(profile.fingerprint);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Peer ID copied.');
    expect(container.querySelector('.profile-more-menu')).toBeNull();

    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Copy link to profile"]');
    expect(writeText).toHaveBeenLastCalledWith(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Profile link copied.');
  });

  it('offers Block in remote More menu and never offers it on the local profile', async () => {
    const onBlock = vi.fn();
    await act(async () => root.render(
      <ProfileHeader contact={profile} onBlock={onBlock} onMessage={vi.fn()} onFollowToggle={vi.fn()} />
    ));
    await clickButton('[aria-label="More profile actions"]');
    expect(container.querySelector('.profile-menu-item.destructive')?.textContent).toBe('Block');
    await clickButton('.profile-menu-item.destructive');
    expect(onBlock).toHaveBeenCalledOnce();

    await act(async () => root.render(
      <ProfileHeader contact={profile} isOwnProfile profileSettings={<div>Local settings</div>} />
    ));
    const localActionLabels = [...container.querySelectorAll<HTMLButtonElement>('.profile-action-buttons button')]
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim());
    expect(localActionLabels).toEqual([
      "Show Alice's profile QR code",
      'Profile',
      'More profile actions'
    ]);
    await clickButton('[aria-label="More profile actions"]');
    expect(container.querySelector('.profile-menu-item.destructive')).toBeNull();
    expect(container.querySelector('[aria-label="Message Alice"]')).toBeNull();
  });

  it('closes the More menu on outside click and Escape', async () => {
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    expect(container.querySelector('.profile-more-menu')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.profile-more-menu')).toBeNull();

    await clickButton('[aria-label="More profile actions"]');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.profile-more-menu')).toBeNull();
  });

  it('opens profile settings in a dismissible dialog without duplicating its controls', async () => {
    await act(async () => root.render(
      <ProfileHeader contact={profile} isOwnProfile profileSettings={<label>Display Name<input /></label>} />
    ));
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await clickButton('.profile-settings-trigger');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Profile settings');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Display Name');
    expect(container.querySelectorAll('input')).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps relationship counts prominent and delegates clicks to the existing lists', async () => {
    const onOpenRelationships = vi.fn();
    await act(async () => root.render(
      <ProfileHeader
        contact={profile}
        showActions={false}
        followingCount={12}
        followerCount={34}
        onOpenRelationships={onOpenRelationships}
      />
    ));

    expect(container.querySelector('.profile-relationship-links')?.textContent).toContain('12 Following');
    expect(container.querySelector('.profile-relationship-links')?.textContent).toContain('34 Followers');
    await clickButton('.profile-relationship-links button:first-child');
    expect(onOpenRelationships).toHaveBeenCalledWith('following');
    await clickButton('.profile-relationship-links button:last-child');
    expect(onOpenRelationships).toHaveBeenLastCalledWith('followers');
    expect(container.textContent).not.toContain(profile.fingerprint);
  });

  it('does not open the fallback or copy the link when native sharing is cancelled', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    const writeText = vi.fn();
    setNavigatorProperty('share', share);
    setNavigatorProperty('clipboard', { writeText });
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');

    await clickButton('[aria-label="Share Alice\'s profile"]');

    expect(writeText).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).toBeNull();
  });

  it('opens the fallback and reports a native share failure', async () => {
    setNavigatorProperty('share', vi.fn().mockRejectedValue(new Error('Sharing failed')));
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');

    await clickButton('[aria-label="Share Alice\'s profile"]');

    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).not.toBeNull();
    expect(container.textContent).toContain('Native sharing could not be opened.');
  });

  it('invokes native sharing again from More in the fallback popover', async () => {
    const share = vi.fn()
      .mockRejectedValueOnce(new Error('Initial share failed'))
      .mockResolvedValueOnce(undefined);
    setNavigatorProperty('share', share);
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-destinations button:last-child');

    expect(share).toHaveBeenCalledTimes(2);
  });

  it('closes the More menu for Share and restores focus when the share popover closes', async () => {
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Share Alice\'s profile"]');
    expect(container.querySelector('.profile-more-menu')).toBeNull();

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="More profile actions"]'));
  });

  it('dismisses when the user clicks outside the popover', async () => {
    await renderProfile();
    await clickButton('[aria-label="More profile actions"]');
    await clickButton('[aria-label="Share Alice\'s profile"]');

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).toBeNull();
  });
});
