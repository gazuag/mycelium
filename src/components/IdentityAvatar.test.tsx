import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IdentityAvatar } from './IdentityAvatar';
import type { IdentityProfilePicture } from '../utils/profile-picture';

describe('IdentityAvatar', () => {
  it('shows an online dot only when explicitly online', () => {
    const online = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={40} online />);
    const offline = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={40} online={false} />);
    const unknown = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={40} />);

    expect(online).toContain('class="identity-avatar-online"');
    expect(online).toContain('class="identity-avatar-wrap is-online"');
    expect(online).toContain('aria-label="Online"');
    expect(offline).not.toContain('identity-avatar-online');
    expect(offline).not.toContain('is-online');
    expect(unknown).not.toContain('identity-avatar-online');
  });

  it('scales the avatar wrapper and keeps the online dot attached at small sizes', () => {
    const markup = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={21} online />);

    expect(markup).toContain('class="identity-avatar-wrap is-online" style="width:21px;height:21px"');
    expect(markup).toContain('width="21" height="21"');
    expect(markup).toContain('class="identity-avatar-online"');
  });

  it('uses a valid profile picture and falls back to the generated avatar for invalid data', () => {
    const picture: IdentityProfilePicture = {
      mime_type: 'image/webp',
      width: 256,
      height: 256,
      data: 'AQID'
    };
    const custom = renderToStaticMarkup(<IdentityAvatar seed="peer-id" profilePicture={picture} />);
    const invalid = renderToStaticMarkup(<IdentityAvatar seed="peer-id" profilePicture={{ ...picture, width: 128 }} />);

    expect(custom).toContain('src="data:image/webp;base64,AQID"');
    expect(invalid).toContain('src="data:image/svg+xml;charset=utf-8,');
    expect(invalid).not.toContain('data:image/webp');
  });
});
