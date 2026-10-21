import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function MarkdownHelp() {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        className="markdown-help-link"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Markdown formatting
      </button>
      {open ? createPortal(
        <div
          className="markdown-help-backdrop"
          role="presentation"
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <section
            className="markdown-help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="markdown-help-heading">
              <h2 id={titleId}>Markdown formatting</h2>
              <button
                ref={closeRef}
                className="btn secondary"
                type="button"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Close
              </button>
            </div>
            <p>Use these shortcuts in posts, replies, and messages:</p>
            <ul className="markdown-help-list">
              <li><code>**bold**</code> for <strong>bold</strong></li>
              <li><code>*italic*</code> for <em>italic</em></li>
              <li><code>__underline__</code> for <u>underline</u></li>
              <li><code>&gt; quoted text</code> for a blockquote</li>
              <li><code>[link text](https://example.com)</code> for a link</li>
              <li><code>https://example.com</code> for an automatically detected link</li>
              <li><code>![description](https://example.com/image.jpg)</code> for an external image</li>
            </ul>
            <p>Separate paragraphs with a blank line. External links show a safety warning before opening, and external images may need to be loaded manually.</p>
            <p>Raw HTML is not supported.</p>
          </section>
        </div>,
        document.body
      ) : null}
    </>
  );
}
