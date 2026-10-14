import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IdentityAvatar } from './IdentityAvatar';

describe('IdentityAvatar', () => {
  it('shows an online dot only when explicitly online', () => {
    const online = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={40} online />);
    const offline = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={40} online={false} />);
    const unknown = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={40} />);

    expect(online).toContain('class="identity-avatar-online"');
    expect(online).toContain('aria-label="Online"');
    expect(offline).not.toContain('identity-avatar-online');
    expect(unknown).not.toContain('identity-avatar-online');
  });

  it('scales the avatar wrapper and keeps the online dot attached at small sizes', () => {
    const markup = renderToStaticMarkup(<IdentityAvatar seed="peer-id" size={21} online />);

    expect(markup).toContain('class="identity-avatar-wrap" style="width:21px;height:21px"');
    expect(markup).toContain('width="21" height="21"');
    expect(markup).toContain('class="identity-avatar-online"');
  });
});
