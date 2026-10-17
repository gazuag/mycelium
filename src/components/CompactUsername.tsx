import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fingerprintToHumanName } from '../utils/fingerprintNames';
import { PeerName } from './PeerName';

interface CompactUsernameProps {
  peerId: string;
  displayName?: string;
  onProfileClick?: (peerId: string) => void;
  className?: string;
}

interface PopoverPosition {
  left: number;
  top: number;
}

let activePopover: { id: symbol; close: () => void } | null = null;
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function CompactUsername({
  peerId,
  displayName,
  onProfileClick,
  className = ''
}: CompactUsernameProps) {
  const identityRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const instanceId = useRef(Symbol());
  const popoverId = useId();
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);

  const handleClosePopover = useCallback(() => {
    setPopoverPosition(null);
    if (activePopover?.id === instanceId.current) activePopover = null;
  }, []);

  const handleClick = () => {
    if (popoverPosition) {
      handleClosePopover();
      onProfileClick?.(peerId);
      return;
    }

    const identity = identityRef.current;
    const label = identity?.querySelector('.peer-name');
    const isTruncated = Boolean(label && [...label.children].some((child) => (
      child instanceof HTMLElement && child.scrollWidth > child.clientWidth
    )));

    if (!isTruncated) {
      onProfileClick?.(peerId);
      return;
    }

    activePopover?.close();
    if (!identity) return;
    const bounds = identity.getBoundingClientRect();
    const maxWidth = Math.min(320, window.innerWidth - 16);
    setPopoverPosition({
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - maxWidth - 8)),
      top: bounds.bottom + 6
    });
    activePopover = { id: instanceId.current, close: handleClosePopover };
  };

  useBrowserLayoutEffect(() => {
    if (!popoverPosition || !popoverRef.current) return;
    const bounds = popoverRef.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(
      popoverPosition.left,
      window.innerWidth - bounds.width - margin
    ));
    const top = Math.max(margin, Math.min(
      popoverPosition.top,
      window.innerHeight - bounds.height - margin
    ));
    if (left !== popoverPosition.left || top !== popoverPosition.top) {
      setPopoverPosition({ left, top });
    }
  }, [popoverPosition]);

  useEffect(() => {
    if (!popoverPosition) return;
    const dismissIfOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node
        && !identityRef.current?.contains(target)
        && !popoverRef.current?.contains(target)
      ) {
        handleClosePopover();
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClosePopover();
    };
    document.addEventListener('pointerdown', dismissIfOutside);
    document.addEventListener('keydown', dismissOnEscape);
    window.addEventListener('resize', handleClosePopover);
    window.addEventListener('scroll', handleClosePopover, true);
    return () => {
      document.removeEventListener('pointerdown', dismissIfOutside);
      document.removeEventListener('keydown', dismissOnEscape);
      window.removeEventListener('resize', handleClosePopover);
      window.removeEventListener('scroll', handleClosePopover, true);
    };
  }, [handleClosePopover, popoverPosition]);

  useEffect(() => () => {
    if (activePopover?.id === instanceId.current) activePopover = null;
  }, []);

  const handle = fingerprintToHumanName(peerId);
  const hasGeneratedUsername = peerId.replace(/[^0-9a-f]/gi, '').length === 16;
  const name = displayName?.trim();
  const fullUsername = hasGeneratedUsername ? `@${handle}` : name || handle;
  const hasSeparateDisplayName = Boolean(name && name !== handle);
  const popupText = name && hasGeneratedUsername && name !== handle
    ? `${name} · ${fullUsername}`
    : fullUsername;

  return (
    <>
      <button
        ref={identityRef}
        type="button"
        className={`compact-username${hasGeneratedUsername && !hasSeparateDisplayName ? ' compact-username-handle' : ''} ${className}`.trim()}
        aria-label={popupText}
        aria-expanded={Boolean(popoverPosition)}
        aria-controls={popoverPosition ? `username-popover-${popoverId}` : undefined}
        aria-describedby={popoverPosition ? `username-popover-${popoverId}` : undefined}
        onClick={(event) => {
          event.stopPropagation();
          handleClick();
        }}
      >
        <span className="compact-username-label">
          <PeerName peerId={peerId} displayName={displayName} />
        </span>
      </button>
      {popoverPosition ? createPortal(
        <div
          ref={popoverRef}
          id={`username-popover-${popoverId}`}
          className="compact-username-popover"
          role="tooltip"
          style={{ left: popoverPosition.left, top: popoverPosition.top }}
        >
          {popupText}
        </div>,
        document.body
      ) : null}
    </>
  );
}
