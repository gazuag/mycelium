import { useDmUnread } from '../hooks/useDmUnread';

type PageKey = 'home' | 'messages' | 'discover' | 'myProfile' | 'settings';

interface TabBarProps {
  active: PageKey;
  onChange: (page: PageKey) => void;
}

const tabs: Array<{ key: PageKey; label: string }> = [
  { key: 'home', label: 'Home' },
  { key: 'messages', label: 'Messages' },
  { key: 'discover', label: 'Discover' },
  { key: 'myProfile', label: 'Profile' },
  { key: 'settings', label: 'Settings' }
];

export function TabBar({ active, onChange }: TabBarProps) {
  const { total: unreadCount } = useDmUnread();
  return (
    <nav className="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={['tab-item', `tab-item-${tab.key}`, active === tab.key ? 'active' : ''].join(' ')}
          onClick={() => onChange(tab.key)}
          type="button"
          aria-label={tab.key === 'messages' && unreadCount > 0 ? 'Messages, unread messages' : tab.label}
        >
          <img
            className="tab-item-icon"
            src={
              tab.key === 'messages'
                ? '/mycelium-messages-envelope.svg'
                : tab.key === 'discover'
                  ? '/mycelium-discovery.svg'
                  : '/mycelium-home-icon-organic.svg'
            }
            alt=""
            aria-hidden="true"
          />
          <span className="tab-item-label">{tab.label}</span>
          {tab.key === 'messages' && unreadCount > 0 ? (
            <span className="tab-unread-dot" aria-hidden="true" />
          ) : null}
        </button>
      ))}
    </nav>
  );
}
