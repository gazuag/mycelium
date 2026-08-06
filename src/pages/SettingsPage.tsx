interface SettingsPageProps {
  onResetApp: () => void;
}

export function SettingsPage({ onResetApp }: SettingsPageProps) {
  return (
    <section className="page-view">
      <div className="page-header">
        <h2>Settings</h2>
        <p className="note">App-level options and diagnostics.</p>
      </div>

      <div className="card">
        <h3>Diagnostics</h3>
        <p className="note">No network rewrites are performed here. This is UI-only settings surface.</p>
      </div>

      <div className="card">
        <button className="btn secondary" onClick={onResetApp}>Reset local state</button>
      </div>
    </section>
  );
}
