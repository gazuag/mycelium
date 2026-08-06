interface TabBarProps {
  currentTab: string;
  onChangeTab: (tab: string) => void;
}

const tabs = [
  { id: 'home', label: 'Home' },
  { id: 'people', label: 'People' },
  { id: 'discover', label: 'Discover' }
];

export function TabBar({ currentTab, onChangeTab }: TabBarProps) {
  return (
    <nav className="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab-button ${currentTab === tab.id ? 'active' : ''}`}
          onClick={() => onChangeTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
