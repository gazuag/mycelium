import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const unreadState = vi.hoisted(() => ({ total: 0 }));
vi.mock('../hooks/useDmUnread', () => ({
  useDmUnread: () => ({ total: unreadState.total, byContact: {}, markRead: async () => {} })
}));

import { TabBar } from './TabBar';

describe('TabBar', () => {
  it('places Messages in the main navigation, marking the active page', () => {
    const markup = renderToStaticMarkup(
      <TabBar active="settings" onChange={() => {}} />
    );
    const labels = [...markup.matchAll(/<span class="tab-item-label">(Home|Messages|Discover|Profile|Settings)<\/span>/g)]
      .map((match) => match[1]);

    expect(labels).toEqual(['Home', 'Messages', 'Discover', 'Profile', 'Settings']);
    expect(markup).toMatch(/class="tab-item active"[^>]*><span class="tab-item-label">Settings<\/span><\/button>/);
  });

  it('shows one accessible red-dot indicator only when unread conversations exist', () => {
    unreadState.total = 2;
    const unreadMarkup = renderToStaticMarkup(
      <TabBar active="messages" onChange={() => {}} />
    );
    expect(unreadMarkup).toContain('aria-label="Messages, unread messages"');
    expect(unreadMarkup.match(/class="tab-unread-dot"/g)).toHaveLength(1);

    unreadState.total = 0;
    const readMarkup = renderToStaticMarkup(
      <TabBar active="messages" onChange={() => {}} />
    );
    expect(readMarkup).toContain('aria-label="Messages"');
    expect(readMarkup).not.toContain('tab-unread-dot');
  });
});
