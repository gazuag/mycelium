import { useEffect, useState } from 'react';
import { createPeerAddUrl } from '../utils/peerAddUrl';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface PeerProfileQrProps {
  peerId: string;
  displayName?: string;
}

export function PeerProfileQr({ peerId, displayName }: PeerProfileQrProps) {
  const [open, setOpen] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [error, setError] = useState('');
  const profileName = displayNameOrFallback(displayName, peerId);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const url = createPeerAddUrl(peerId, window.location.origin);
    setQrCode('');
    setError('');

    if (!url) {
      setError('A profile link cannot be created for this peer ID.');
      return () => {
        active = false;
      };
    }

    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240
    })).then((dataUrl) => {
      if (active) setQrCode(dataUrl);
    }).catch((reason: unknown) => {
      if (active) {
        setError(`Could not create profile QR code: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    });

    return () => {
      active = false;
    };
  }, [open, peerId]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const profileUrl = open ? createPeerAddUrl(peerId, window.location.origin) : null;

  return (
    <>
      <button
        className="profile-qr-button"
        type="button"
        aria-label={`Show ${profileName}'s profile QR code`}
        title="Show profile QR code"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
          <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
          <path d="M14 14h3v3h-3zM20 14v2M14 20h2M20 20v1M20 18h1" />
        </svg>
      </button>
      {open ? (
        <div className="profile-qr-backdrop" onClick={() => setOpen(false)}>
          <section
            className="profile-qr-dialog card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-qr-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="profile-qr-close btn secondary"
              type="button"
              aria-label="Close profile QR code"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <h2 id="profile-qr-title">{profileName}'s profile QR code</h2>
            {error ? <p className="note" role="alert">{error}</p> : null}
            {qrCode ? <img className="profile-qr-image" src={qrCode} alt={`QR code linking to ${profileName}'s profile`} /> : null}
            {profileUrl ? <p className="profile-qr-url">{profileUrl}</p> : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
