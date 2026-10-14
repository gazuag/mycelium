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
          className={`tab-item ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
          type="button"
          aria-label={tab.key === 'messages' && unreadCount > 0 ? 'Messages, unread messages' : tab.label}
        >
          <span className="tab-item-label">{tab.label}</span>
          {tab.key === 'messages' && unreadCount > 0 ? (
            <span className="tab-unread-dot" aria-hidden="true" />
          ) : null}
        </button>
      ))}
    </nav>
  );
}
