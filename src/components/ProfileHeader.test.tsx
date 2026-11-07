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
  await act(async () => root.render(<ProfileHeader contact={contact} showActions={false} />));
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
  it('uses native sharing with the profile identity and canonical URL', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('share', share);
    await renderProfile();

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

    await clickButton(`[aria-label="Share ${fingerprintToHumanName(ownProfile.fingerprint)}'s profile"]`);

    expect(share).toHaveBeenCalledWith({
      title: fingerprintToHumanName(ownProfile.fingerprint),
      text: 'Check out this profile on Mycelium',
      url: createPeerAddUrl(ownProfile.fingerprint, window.location.origin)
    });
  });

  it('opens the custom share popover when native sharing is unavailable', async () => {
    await renderProfile();

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
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-copy');

    expect(writeText).toHaveBeenCalledWith(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.textContent).toContain('Link copied.');
  });

  it('provides a selectable link when clipboard access is unavailable', async () => {
    await renderProfile();
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-copy');

    expect(container.querySelector<HTMLInputElement>('.share-popover-manual-url')?.value)
      .toBe(createPeerAddUrl(profile.fingerprint, window.location.origin));
  });

  it('provides a selectable link when clipboard access fails', async () => {
    setNavigatorProperty('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('Denied')) });
    await renderProfile();
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-copy');

    expect(container.querySelector<HTMLInputElement>('.share-popover-manual-url')?.value)
      .toBe(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.textContent).toContain('Copying is unavailable.');
  });

  it('offers email and message actions containing the profile URL', async () => {
    const url = createPeerAddUrl(profile.fingerprint, window.location.origin)!;
    await renderProfile();
    await clickButton('[aria-label="Share Alice\'s profile"]');

    const email = container.querySelector<HTMLAnchorElement>('.share-popover-destinations a[href^="mailto:"]');
    const message = container.querySelector<HTMLAnchorElement>('.share-popover-destinations a[href^="sms:"]');
    expect(decodeURIComponent(email?.getAttribute('href') ?? '')).toContain(url);
    expect(decodeURIComponent(message?.getAttribute('href') ?? '')).toContain(url);
    expect(email?.getAttribute('href')).toContain('subject=');
  });

  it('opens the existing QR dialog from the popover and preserves the standalone QR action', async () => {
    await renderProfile();

    expect(container.querySelector('[aria-label="Show Alice\'s profile QR code"]')).not.toBeNull();
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-destinations button');
    expect(container.querySelector('#profile-qr-title')?.textContent).toBe("Alice's profile QR code");
    expect(container.querySelector('[aria-label="Show Alice\'s profile QR code"]')).not.toBeNull();
  });

  it('opens the QR dialog directly from the standalone QR button', async () => {
    await renderProfile();

    await clickButton('[aria-label="Show Alice\'s profile QR code"]');

    expect(container.querySelector('#profile-qr-title')?.textContent).toBe("Alice's profile QR code");
    expect(container.querySelector('[aria-label="Share Alice\'s profile"]')).not.toBeNull();
  });

  it('does not open the fallback or copy the link when native sharing is cancelled', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    const writeText = vi.fn();
    setNavigatorProperty('share', share);
    setNavigatorProperty('clipboard', { writeText });
    await renderProfile();

    await clickButton('[aria-label="Share Alice\'s profile"]');

    expect(writeText).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).toBeNull();
  });

  it('opens the fallback and reports a native share failure', async () => {
    setNavigatorProperty('share', vi.fn().mockRejectedValue(new Error('Sharing failed')));
    await renderProfile();

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
    await clickButton('[aria-label="Share Alice\'s profile"]');
    await clickButton('.share-popover-destinations button:last-child');

    expect(share).toHaveBeenCalledTimes(2);
  });

  it('dismisses by Escape and restores focus to the Share button', async () => {
    await renderProfile();
    await clickButton('[aria-label="Share Alice\'s profile"]');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Share Alice\'s profile"]'));
  });

  it('dismisses when the user clicks outside the popover', async () => {
    await renderProfile();
    await clickButton('[aria-label="Share Alice\'s profile"]');

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"][aria-label="Share Alice"]')).toBeNull();
  });
});
