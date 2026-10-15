import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { PeerName } from './PeerName';

describe('PeerName', () => {
  it('shows a provided display name above the generated handle', () => {
    const markup = renderToStaticMarkup(
      <PeerName peerId="aa:bb:cc:dd:ee:ff:00:11" displayName="Alice" />
    );
    const handle = fingerprintToHumanName('aa:bb:cc:dd:ee:ff:00:11');

    expect(markup.indexOf('Alice')).toBeLessThan(markup.indexOf(`@${handle}`));
  });

  it('uses the generated handle as the primary name when no display name exists', () => {
    const handle = fingerprintToHumanName('aa:bb:cc:dd:ee:ff:00:11');
    const markup = renderToStaticMarkup(<PeerName peerId="aa:bb:cc:dd:ee:ff:00:11" />);

    expect(markup).toContain(`class="peer-name-primary">${handle}</span>`);
    expect(markup).not.toContain(`@${handle}`);
  });
});
