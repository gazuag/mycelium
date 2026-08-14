interface CollapsibleSectionProps {
  title: string;
  summary?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

export function CollapsibleSection({ title, summary, isOpen, onToggle, children }: CollapsibleSectionProps) {
  return (
    <section className="collapsible-section">
      <button className="collapsible-toggle" onClick={onToggle} type="button">
        <div>
          <strong>{title}</strong>
          {summary ? <span className="note"> - {summary}</span> : null}
        </div>
        <span>{isOpen ? '▾' : '▸'}</span>
      </button>
      {isOpen ? <div className="collapsible-content">{children}</div> : null}
    </section>
  );
}
