import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface WelcomeWizardProps {
  handle: string;
  initialDisplayName: string;
  onComplete: (displayName: string, nextStep: 'discover' | 'home') => Promise<void>;
}

export function WelcomeWizard({ handle, initialDisplayName, onComplete }: WelcomeWizardProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  const finish = async (nextStep: 'discover' | 'home' = 'home') => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await onComplete(displayName, nextStep);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void finishRef.current('home');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return createPortal(
    <div
      className="welcome-wizard-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) void finish('home');
      }}
    >
      <section
        className="welcome-wizard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          ref={closeRef}
          className="welcome-wizard-close"
          type="button"
          aria-label="Close welcome"
          onClick={() => void finish('home')}
          disabled={saving}
        >
          <span aria-hidden="true">&times;</span>
        </button>
        <h1 id={titleId}>Welcome! Pick your name!</h1>
        <p className="welcome-wizard-intro">
          Choose the name you&apos;d like people to see on Mycelium. You can change it later.
        </p>
        <label className="welcome-wizard-name">
          Display name
          <input
            autoComplete="nickname"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Optional"
            aria-label="Display name"
          />
        </label>
        <div className="welcome-wizard-handle">
          <span>Your generated handle is your unique identity on Mycelium:</span>
          <strong>@{handle}</strong>
        </div>
        {error ? <p className="welcome-wizard-error" role="alert">{error}</p> : null}
        <div className="welcome-wizard-actions">
          <button className="btn" type="button" onClick={() => void finish('discover')} disabled={saving}>
            Show me around
          </button>
          <button className="btn secondary" type="button" onClick={() => void finish()} disabled={saving}>
            I&apos;ll explore on my own
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
