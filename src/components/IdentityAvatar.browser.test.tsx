// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IdentityProfilePicture } from '../utils/profile-picture';
import { IdentityAvatar } from './IdentityAvatar';

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

describe('IdentityAvatar image fallback', () => {
  it('uses the generated avatar when a signed picture cannot be decoded by the browser', async () => {
    const picture: IdentityProfilePicture = {
      mime_type: 'image/webp',
      width: 256,
      height: 256,
      data: 'AQID'
    };
    await act(async () => root.render(<IdentityAvatar seed="peer-id" profilePicture={picture} />));

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/webp;base64,AQID');
    await act(async () => image?.dispatchEvent(new Event('error')));

    expect(image?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  });
});
