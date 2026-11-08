import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { guidedTourSteps } from '../help/help-content';

interface GuidedTourProps {
  onExit: () => void;
  onSkip: () => void;
  onFinish: () => void;
}

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function GuidedTour({ onExit, onSkip, onFinish }: GuidedTourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [highlight, setHighlight] = useState<HighlightRect | null>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const step = guidedTourSteps[stepIndex];

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    skipRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onExit();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(document.querySelectorAll<HTMLElement>(
        '.guided-tour-dialog button:not([disabled])'
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else document.querySelector<HTMLElement>('[data-tour-target="help"]')?.focus();
    };
  }, [onExit]);

  useEffect(() => {
    const updateHighlight = () => {
      const target = document.querySelector<HTMLElement>(step.target);
      if (!target || target.getClientRects().length === 0) {
        setHighlight(null);
        return;
      }
      const style = window.getComputedStyle(target);
      if (style.display === 'none' || style.visibility === 'hidden') {
        setHighlight(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const visible = rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
      setHighlight(visible
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : null);
    };
    updateHighlight();
    window.addEventListener('resize', updateHighlight);
    window.addEventListener('scroll', updateHighlight, true);
    return () => {
      window.removeEventListener('resize', updateHighlight);
      window.removeEventListener('scroll', updateHighlight, true);
    };
  }, [step.target]);

  return createPortal(
    <div className="guided-tour-layer">
      {highlight ? (
        <div
          className="guided-tour-spotlight"
          aria-hidden="true"
          style={{
            top: highlight.top,
            left: highlight.left,
            width: highlight.width,
            height: highlight.height
          }}
        />
      ) : <div className="guided-tour-dim" aria-hidden="true" />}
      <section
        className="guided-tour-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-tour-title"
        aria-describedby="guided-tour-description"
      >
        <div className="guided-tour-progress-row">
          <span>Step {stepIndex + 1} of {guidedTourSteps.length}</span>
          <button ref={skipRef} className="guided-tour-skip" type="button" onClick={onSkip}>Skip tour</button>
        </div>
        <div
          className="guided-tour-progress"
          role="progressbar"
          aria-label="Tour progress"
          aria-valuemin={1}
          aria-valuemax={guidedTourSteps.length}
          aria-valuenow={stepIndex + 1}
        >
          <span style={{ width: `${((stepIndex + 1) / guidedTourSteps.length) * 100}%` }} />
        </div>
        <p className="help-center-eyebrow">A QUICK TOUR</p>
        <h2 id="guided-tour-title">{step.title}</h2>
        <p id="guided-tour-description">{step.description}</p>
        {!highlight ? (
          <p className="guided-tour-target-note">This control is not visible here, but you can still continue the tour.</p>
        ) : null}
        <div className="guided-tour-actions">
          <button
            className="btn secondary"
            type="button"
            onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
            disabled={stepIndex === 0}
          >
            Back
          </button>
          {stepIndex < guidedTourSteps.length - 1 ? (
            <button className="btn" type="button" onClick={() => setStepIndex((current) => current + 1)}>
              Next
            </button>
          ) : (
            <button className="btn" type="button" onClick={onFinish}>Let&apos;s go!</button>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
