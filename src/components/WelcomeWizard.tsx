import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';

interface WelcomeWizardProps {
  handle: string;
  initialDisplayName: string;
  onComplete: (displayName: string, nextStep: 'discover' | 'home') => Promise<void>;
}

type WelcomeBackdropStyle = CSSProperties & { '--welcome-viewport-height': string };

export function WelcomeWizard({ handle, initialDisplayName, onComplete }: WelcomeWizardProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [visualViewport, setVisualViewport] = useState<{ height: number; offsetTop: number } | null>(null);

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
    nameInputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void finishRef.current('home');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateViewport = () => setVisualViewport({
      height: viewport.height,
      offsetTop: viewport.offsetTop
    });
    updateViewport();
    viewport.addEventListener('resize', updateViewport);
    viewport.addEventListener('scroll', updateViewport);
    return () => {
      viewport.removeEventListener('resize', updateViewport);
      viewport.removeEventListener('scroll', updateViewport);
    };
  }, []);

  const backdropStyle: WelcomeBackdropStyle | undefined = visualViewport
    ? {
        height: `${visualViewport.height}px`,
        top: `${visualViewport.offsetTop}px`,
        '--welcome-viewport-height': `${visualViewport.height}px`
      }
    : undefined;

  return createPortal(
    <div
      className="welcome-wizard-backdrop"
      style={backdropStyle}
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
          className="welcome-wizard-close"
          type="button"
          aria-label="Close welcome"
          onClick={() => void finish('home')}
          disabled={saving}
        >
          <span aria-hidden="true">&times;</span>
        </button>
        <h1 id={titleId}>Welcome to Mycelium!</h1>
        <p className="welcome-wizard-intro">Please pick your name.</p>
        <p className="welcome-wizard-change-name">(You can change it later)</p>
        <label className="welcome-wizard-name">
          Display name
          <input
            ref={nameInputRef}
            autoFocus
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
