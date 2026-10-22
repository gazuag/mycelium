import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Token } from 'marked';
import {
  cacheExternalImage,
  discardCachedExternalImage,
  DEFAULT_EXTERNAL_IMAGE_LIMIT_MB,
  fetchBoundedExternalImage,
  getCachedExternalImage,
  getExternalImageSize,
  lexMarkdown,
  releaseCachedExternalImage,
  validateExternalUrl
} from '../markdown/external-content';

export const ExternalImageLimitContext = createContext(DEFAULT_EXTERNAL_IMAGE_LIMIT_MB);

interface MarkdownContentProps {
  source: string;
  imageSizes?: unknown;
  className?: string;
}

export function MarkdownContent({ source, imageSizes, className = 'markdown-content' }: MarkdownContentProps) {
  const tokens = lexMarkdown(source);
  return (
    <div className={className}>
      {renderTokens(tokens, imageSizes)}
    </div>
  );
}

export function MarkdownPreview({ source }: { source: string }) {
  return (
    <ExternalImageLimitContext.Provider value={0}>
      <MarkdownContent source={source} className="markdown-content markdown-preview" />
    </ExternalImageLimitContext.Provider>
  );
}

function renderTokens(
  tokens: readonly Token[],
  imageSizes: unknown,
  stripUnderlineMarkers = false,
  depth = 0
): ReactNode[] {
  if (depth > 32) return tokens.map((token) => token.raw);
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case 'paragraph':
        return <p key={key}>{renderTokens(token.tokens ?? [], imageSizes, false, depth + 1)}</p>;
      case 'blockquote':
        return <blockquote key={key}>{renderTokens(token.tokens ?? [], imageSizes, false, depth + 1)}</blockquote>;
      case 'strong':
        if (token.raw.includes('\uE000')) {
          return <u key={key}>{renderTokens(token.tokens ?? [], imageSizes, true, depth + 1)}</u>;
        }
        if (token.raw.startsWith('__')) return token.raw;
        return <strong key={key}>{renderTokens(token.tokens ?? [], imageSizes, false, depth + 1)}</strong>;
      case 'em':
        return token.raw.startsWith('_')
          ? token.raw
          : <em key={key}>{renderTokens(token.tokens ?? [], imageSizes, false, depth + 1)}</em>;
      case 'link': {
        const destination = validateExternalUrl(token.href);
        const label = renderTokens(token.tokens ?? [], imageSizes, false, depth + 1);
        return destination
          ? <InterstitialLink key={key} destination={destination.href}>{label}</InterstitialLink>
          : <span key={key}>{label}</span>;
      }
      case 'image': {
        const destination = validateExternalUrl(token.href);
        return destination
          ? <ExternalImage key={key} url={token.href} alt={token.text} sizes={imageSizes} />
          : <span key={key}>{token.text || token.href}</span>;
      }
      case 'br':
        return <br key={key} />;
      case 'text':
      case 'escape':
        return stripUnderlineMarkers
          ? token.text.replace(/[\uE000\uE001]/g, '')
          : token.text;
      case 'html':
        return token.raw;
      case 'codespan':
        return token.raw;
      case 'code':
        return token.raw;
      case 'space':
        return null;
      default:
        return <span key={key}>{token.raw}</span>;
    }
  });
}

function InterstitialLink({ destination, children }: { destination: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const parsedDestination = validateExternalUrl(destination);

  const close = () => {
    setOpen(false);
    setError('');
    linkRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    backButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const proceed = () => {
    const validated = validateExternalUrl(destination);
    if (!validated) {
      setError('This destination is no longer a valid HTTP or HTTPS URL.');
      return;
    }
    window.open(validated.href, '_blank', 'noopener,noreferrer');
    close();
  };

  return (
    <>
      <a
        ref={linkRef}
        className="markdown-external-link"
        href="#external-link"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {children}
      </a>
      {open && parsedDestination ? createPortal(
        <div
          className="external-link-backdrop"
          role="presentation"
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            className="external-link-interstitial"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={titleId}>You are now leaving Mycelium.</h2>
            <p>Destination hostname</p>
            <strong className="external-link-hostname">{parsedDestination.hostname}</strong>
            <details>
              <summary>Inspect full destination URL</summary>
              <code className="external-link-full-url">{parsedDestination.href}</code>
            </details>
            {error ? <p role="alert">{error}</p> : null}
            <div className="row">
              <button ref={backButtonRef} className="btn secondary" type="button" onClick={close}>Go back</button>
              <button className="btn" type="button" onClick={proceed}>Proceed</button>
            </div>
          </section>
        </div>,
        document.body
      ) : null}
    </>
  );
}

function formatReportedSize(sizeBytes: number): string {
  const megabytes = sizeBytes / 1_000_000;
  return `${megabytes < 1 ? megabytes.toFixed(2) : megabytes.toFixed(1)} MB`;
}

function ExternalImage({
  url,
  alt,
  sizes
}: {
  url: string;
  alt: string;
  sizes: unknown;
}) {
  const displayLimitMb = useContext(ExternalImageLimitContext);
  const reportedSize = getExternalImageSize(sizes, url);
  const autoLoad = displayLimitMb > 0
    && reportedSize?.status === 'known'
    && reportedSize.sizeBytes <= displayLimitMb * 1_000_000;
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (explicit = false) => {
    if (controllerRef.current) return;
    const cachedUrl = getCachedExternalImage(url);
    if (cachedUrl) {
      setObjectUrl(cachedUrl);
      setStatus('loaded');
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
    setStatus('loading');
    setLoadError('');
    try {
      const blob = await fetchBoundedExternalImage(url, controller.signal);
      if (controller.signal.aborted) return;
      const localUrl = explicit
        ? cacheExternalImage(url, blob) ?? URL.createObjectURL(blob)
        : URL.createObjectURL(blob);
      setObjectUrl(localUrl);
      setStatus('loaded');
    } catch (error) {
      if (controller.signal.aborted) {
        setLoadError('Image loading timed out or was cancelled. Try again.');
      } else {
        setLoadError(error instanceof Error ? error.message : 'Could not load this image. Try again.');
      }
      setStatus('error');
    } finally {
      globalThis.clearTimeout(timeout);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [url]);

  useEffect(() => {
    if (autoLoad && status === 'idle') void load();
  }, [autoLoad, load, status]);

  useEffect(() => () => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => {
    if (!objectUrl) return;
    if (!releaseCachedExternalImage(objectUrl)) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (status === 'loaded' && objectUrl) {
    return (
      <img
        className="markdown-external-image"
        src={objectUrl}
        alt={alt}
        onError={() => {
          discardCachedExternalImage(objectUrl);
          setObjectUrl(null);
          setLoadError('The downloaded file could not be decoded as an image. Try again.');
          setStatus('error');
        }}
      />
    );
  }

  const sizeLabel = reportedSize?.status === 'known'
    ? formatReportedSize(reportedSize.sizeBytes)
    : 'Size unknown';
  const prompt = `Image · ${sizeLabel} · Tap to load`;

  return (
    <span className="markdown-image-placeholder">
      {status === 'loading' || (autoLoad && status === 'idle') ? (
        <span role="status">Loading external image…</span>
      ) : (
        <button
          type="button"
          className="markdown-image-load"
          aria-label={alt ? `Load image: ${alt}` : prompt}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void load(true);
          }}
        >
          {status === 'error' ? 'Image failed · Retry' : prompt}
        </button>
      )}
      {loadError ? <span className="markdown-image-error" role="status">{loadError}</span> : null}
    </span>
  );
}
