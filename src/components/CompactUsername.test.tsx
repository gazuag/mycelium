import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { CompactUsername } from './CompactUsername';

describe('CompactUsername', () => {
  it('keeps the complete generated username available to assistive technology', () => {
    const peerId = 'aa:bb:cc:dd:ee:ff:00:11';
    const username = `@${fingerprintToHumanName(peerId)}`;
    const markup = renderToStaticMarkup(
      <CompactUsername peerId={peerId} displayName="Alice" onProfileClick={() => {}} />
    );

    expect(markup).toContain(`aria-label="Alice · ${username}"`);
    expect(markup).toContain('class="peer-name-primary">Alice</span>');
    expect(markup).toContain(`class="peer-name-handle">${username}</span>`);
  });
});
