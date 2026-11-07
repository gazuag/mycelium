// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityProfilePicture } from '../utils/profile-picture';
import { ProfilePictureEditor } from './ProfilePictureEditor';

const picture: IdentityProfilePicture = {
  mime_type: 'image/webp',
  width: 256,
  height: 256,
  data: 'AQID'
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

describe('ProfilePictureEditor', () => {
  it('lets users remove their custom picture from the existing profile settings', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(
      <ProfilePictureEditor seed="my-peer" picture={picture} onChange={onChange} />
    ));

    const removeButton = container.querySelector<HTMLButtonElement>('button');
    expect(container.textContent).toContain('Replace picture');
    expect(removeButton?.textContent).toBe('Remove custom picture');

    await act(async () => removeButton?.click());

    expect(onChange).toHaveBeenCalledWith(null);
    expect(container.textContent).toContain('Custom picture removed.');
  });
});
