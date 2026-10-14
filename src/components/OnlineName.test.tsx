import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineName } from './OnlineName';

describe('OnlineName', () => {
  it('shows the shared indicator only for explicitly online peers', () => {
    const online = renderToStaticMarkup(<OnlineName online>Peer</OnlineName>);
    const offline = renderToStaticMarkup(<OnlineName online={false}>Peer</OnlineName>);

    expect(online).toContain('class="online-name-dot"');
    expect(online).toContain('aria-label="Online"');
    expect(offline).not.toContain('online-name-dot');
    expect(offline).toContain('Peer');
  });
});
