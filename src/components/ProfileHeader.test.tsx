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

async function clickShareButton() {
  await clickShareButtonFor('Alice');
}

async function clickShareButtonFor(name: string) {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="Share ${name}'s profile"]`);
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  it('shares the profile name, description, and canonical profile URL', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('share', share);
    await act(async () => root.render(<ProfileHeader contact={profile} showActions={false} />));

    await clickShareButton();

    expect(share).toHaveBeenCalledWith({
      title: 'Alice',
      text: 'Check out this profile on Mycelium',
      url: createPeerAddUrl(profile.fingerprint, window.location.origin)
    });
  });

  it('shares an own profile using its generated Mycelium handle', async () => {
    const ownProfile = { ...profile, displayName: undefined };
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('share', share);
    await act(async () => root.render(<ProfileHeader contact={ownProfile} showActions={false} />));

    await clickShareButtonFor(fingerprintToHumanName(ownProfile.fingerprint));

    expect(share).toHaveBeenCalledWith({
      title: fingerprintToHumanName(ownProfile.fingerprint),
      text: 'Check out this profile on Mycelium',
      url: createPeerAddUrl(ownProfile.fingerprint, window.location.origin)
    });
  });

  it('copies the canonical URL when native sharing is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('clipboard', { writeText });
    await act(async () => root.render(<ProfileHeader contact={profile} showActions={false} />));

    await clickShareButton();

    expect(writeText).toHaveBeenCalledWith(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.textContent).toContain('Profile link copied.');
  });

  it('does not fall back to copying when native sharing is cancelled', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    const writeText = vi.fn();
    setNavigatorProperty('share', share);
    setNavigatorProperty('clipboard', { writeText });
    await act(async () => root.render(<ProfileHeader contact={profile} showActions={false} />));

    await clickShareButton();

    expect(writeText).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Profile link copied.');
    expect(container.querySelector('.profile-share-fallback')).toBeNull();
  });

  it('shows a selectable URL when clipboard access fails', async () => {
    setNavigatorProperty('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('Denied')) });
    await act(async () => root.render(<ProfileHeader contact={profile} showActions={false} />));

    await clickShareButton();

    const urlField = container.querySelector<HTMLInputElement>('.profile-share-url');
    expect(urlField?.value).toBe(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.textContent).toContain('Select and copy the profile link below.');
  });

  it('shows a selectable URL when clipboard access is unavailable', async () => {
    await act(async () => root.render(<ProfileHeader contact={profile} showActions={false} />));

    await clickShareButton();

    expect(container.querySelector<HTMLInputElement>('.profile-share-url')?.value)
      .toBe(createPeerAddUrl(profile.fingerprint, window.location.origin));
  });

  it('uses clipboard fallback if native sharing fails for a reason other than cancellation', async () => {
    const share = vi.fn().mockRejectedValue(new Error('Sharing failed'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty('share', share);
    setNavigatorProperty('clipboard', { writeText });
    await act(async () => root.render(<ProfileHeader contact={profile} showActions={false} />));

    await clickShareButton();

    expect(writeText).toHaveBeenCalledWith(createPeerAddUrl(profile.fingerprint, window.location.origin));
    expect(container.textContent).toContain('Profile link copied.');
  });
});
