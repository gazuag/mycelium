export interface SecurityHeadersOptions {
  signalOrigins: string[];
  meteredDomain: string;
  enforce: boolean;
}

function normalizeHostname(domain: string): string {
  const hostname = domain.trim().toLowerCase();
  const labels = hostname.split('.');
  if (
    hostname.length > 253 ||
    labels.some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    throw new Error(`Invalid VITE_METERED_APP_DOMAIN "${domain}": expected a plain hostname.`);
  }
  return hostname;
}

function normalizeSignalOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Invalid signalling origin "${origin}": expected a wss:// origin.`);
  }

  if (
    url.protocol !== 'wss:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid signalling origin "${origin}": expected a wss:// origin.`);
  }
  return url.origin;
}

export function buildSecurityHeaders({
  signalOrigins,
  meteredDomain,
  enforce
}: SecurityHeadersOptions): string {
  if (!meteredDomain.trim()) {
    throw new Error('VITE_METERED_APP_DOMAIN is required to build Cloudflare security headers.');
  }

  const hostname = normalizeHostname(meteredDomain);
  const connectOrigins = [...new Set(signalOrigins.map(normalizeSignalOrigin))];
  const connectSources = ["'self'", ...connectOrigins, `https://${hostname}`].join(' ');
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-elem 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src 'none'"
  ].join('; ');
  const cspHeader = enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';

  return [
    '/*',
    `  ${cspHeader}: ${csp}`,
    '  Strict-Transport-Security: max-age=31536000',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), accelerometer=(), gyroscope=(), magnetometer=()',
    ''
  ].join('\n');
}
