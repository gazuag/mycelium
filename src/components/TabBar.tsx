type PageKey = 'home' | 'people' | 'discover';

interface TabBarProps {
  active: PageKey;
  onChange: (page: PageKey) => void;
}

const tabs: Array<{ key: PageKey; label: string }> = [
  { key: 'home', label: 'Home' },
  { key: 'people', label: 'People' },
  { key: 'discover', label: 'Discover' }
];

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav className="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={`tab-item ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
