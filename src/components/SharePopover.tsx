import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { copyTextToClipboard } from '../utils/clipboard';

interface SharePopoverProps {
  title: string;
  description: string;
  url: string;
  ariaLabel?: string;
  avatar?: ReactNode;
  onOpenQr?: () => void;
  showTrigger?: boolean;
  containerClassName?: string;
  returnFocusRef?: RefObject<HTMLButtonElement>;
  onTriggerReady?: (trigger: (() => void) | null) => void;
  onShareComplete?: () => void;
}

function isShareCancellation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}

export function SharePopover({
  title,
  description,
  url,
  ariaLabel,
  avatar,
  onOpenQr,
  showTrigger = true,
  containerClassName = '',
  returnFocusRef,
  onTriggerReady,
  onShareComplete
}: SharePopoverProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [showManualCopy, setShowManualCopy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const sharingRef = useRef(false);
  const popoverId = useId();
  const nativeShareAvailable = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const shareNatively = async () => {
    if (!nativeShareAvailable || sharingRef.current) return;
    sharingRef.current = true;
    setSharing(true);
    try {
      await navigator.share({ title, text: description, url });
      setOpen(false);
      onShareComplete?.();
    } catch (error) {
      if (isShareCancellation(error)) return;
      setStatus('Native sharing could not be opened. Choose another option below.');
      setOpen(true);
    } finally {
      sharingRef.current = false;
      setSharing(false);
    }
  };

  const handleShareClick = useCallback(() => {
    setStatus('');
    setShowManualCopy(false);
    if (nativeShareAvailable) {
      void shareNatively();
    } else {
      setOpen(true);
    }
  }, [nativeShareAvailable, shareNatively]);

  useEffect(() => {
    onTriggerReady?.(handleShareClick);
    return () => onTriggerReady?.(null);
  }, [handleShareClick, onTriggerReady]);

  const copyLink = async () => {
    setCopying(true);
    setStatus('');
    try {
      await copyTextToClipboard(url);
      setShowManualCopy(false);
      setStatus('Link copied.');
    } catch {
      setShowManualCopy(true);
      setStatus('Copying is unavailable. Select the link below to copy it.');
    } finally {
      setCopying(false);
    }
  };

  const handleMoreClick = () => {
    setStatus('');
    void shareNatively();
  };

  const handleQrClick = () => {
    setOpen(false);
    onOpenQr?.();
  };

  useEffect(() => {
    if (!open) return;
    copyButtonRef.current?.focus();

    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        (returnFocusRef?.current ?? triggerRef.current)?.focus();
      }
    };

    document.addEventListener('pointerdown', dismissOnOutsidePointer);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (status !== 'Link copied.') return;
    const timeout = window.setTimeout(() => setStatus(''), 2000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const emailHref = `mailto:?subject=${encodeURIComponent(`Check out ${title} on Mycelium`)}&body=${encodeURIComponent(`${description}\n\n${url}`)}`;
  const messageHref = `sms:?body=${encodeURIComponent(`${description} ${url}`)}`;

  return (
    <div className={`share-popover-anchor${containerClassName ? ` ${containerClassName}` : ''}`} ref={containerRef}>
      {showTrigger ? <button
        ref={triggerRef}
        className="btn secondary share-popover-trigger"
        type="button"
        aria-label={ariaLabel ?? `Share ${title}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        disabled={sharing}
        onClick={handleShareClick}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="m8.7 10.7 6.6-4.4M8.7 13.3l6.6 4.4" />
        </svg>
        <span>Share</span>
      </button> : null}
      {open ? (
        <section
          className="share-popover card"
          id={popoverId}
          role="dialog"
          aria-label={`Share ${title}`}
        >
          <div className="share-popover-preview">
            {avatar ? <span className="share-popover-avatar">{avatar}</span> : null}
            <div className="share-popover-identity">
              <strong>{title}</strong>
              <span>{description}</span>
            </div>
          </div>
          {status ? <p className="share-popover-status note" role="status">{status}</p> : null}
          <div className="share-popover-link-row">
            <code className="share-popover-url" title={url}>{url}</code>
            <button
              ref={copyButtonRef}
              className="btn share-popover-copy"
              type="button"
              onClick={() => { void copyLink(); }}
              disabled={copying}
            >
              {copying ? 'Copying…' : 'Copy link'}
            </button>
          </div>
          {showManualCopy ? (
            <input
              className="share-popover-manual-url"
              aria-label="Profile link to copy"
              type="url"
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          ) : null}
          <nav className="share-popover-destinations" aria-label="Sharing options">
            <a className="btn secondary" href={emailHref}>Email</a>
            <a className="btn secondary" href={messageHref}>Message</a>
            {onOpenQr ? (
              <button className="btn secondary" type="button" onClick={handleQrClick}>QR code</button>
            ) : null}
            {nativeShareAvailable ? (
              <button className="btn secondary" type="button" onClick={handleMoreClick}>More</button>
            ) : null}
          </nav>
        </section>
      ) : null}
    </div>
  );
}
