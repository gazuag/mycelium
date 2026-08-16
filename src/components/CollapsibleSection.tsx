interface CollapsibleSectionProps {
  title?: string;
  summary?: string;
  isOpen?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function CollapsibleSection({ title, summary, isOpen, collapsed, onToggle, children, className = '' }: CollapsibleSectionProps) {
  const hasTitle = Boolean(title && title.trim().length > 0);
  const isCollapsed = typeof collapsed === 'boolean' ? collapsed : (typeof isOpen === 'boolean' ? !isOpen : false);

  if (!hasTitle) {
    return <div className={`card collapsible-card plain ${className}`.trim()}>{children}</div>;
  }

  return (
    <section className={`card collapsible-card with-title ${isCollapsed ? 'collapsed' : 'expanded'} ${className}`.trim()}>
      <button className="collapsible-toggle" onClick={onToggle ?? (() => undefined)} type="button" aria-expanded={!isCollapsed}>
        <span className="collapsible-toggle-text">
          <strong>{title}</strong>
          {summary ? <span className="note"> · {summary}</span> : null}
        </span>
        <span className="collapsible-arrow" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
      </button>
      {!isCollapsed ? <div className="collapsible-content">{children}</div> : null}
    </section>
  );
}
