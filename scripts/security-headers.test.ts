import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from './security-headers';

const options = {
  signalOrigins: ['wss://discover.unfilter.ing:8443'],
  meteredDomain: 'turn.example.net',
  enforce: false
};

describe('Cloudflare security headers', () => {
  it('includes the required CSP directives without unsafe script allowances', () => {
    const headers = buildSecurityHeaders(options);
    const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy'))!;

    for (const directive of [
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
      "manifest-src 'self'",
      "worker-src 'self'",
      "frame-src 'none'"
    ]) {
      expect(csp).toContain(directive);
    }

    expect(csp.replace("style-src-attr 'unsafe-inline'", '')).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('limits connect-src to self, signalling origins, and the Metered origin', () => {
    const headers = buildSecurityHeaders({
      ...options,
      signalOrigins: ['wss://signal.example:9443', 'wss://discover.unfilter.ing:8443']
    });
    const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy'))!;
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1];

    expect(connectSrc?.split(' ')).toEqual([
      "'self'",
      'wss://signal.example:9443',
      'wss://discover.unfilter.ing:8443',
      'https://turn.example.net'
    ]);
    expect(connectSrc).not.toContain('*');
    expect(connectSrc?.split(' ').every((source) =>
      source === "'self'" || /^wss:\/\/[^/]+$/.test(source) || /^https:\/\/[^/]+$/.test(source)
    )).toBe(true);
  });

  it('uses the correct CSP header name for report-only and enforce modes', () => {
    expect(buildSecurityHeaders(options)).toContain('Content-Security-Policy-Report-Only:');
    expect(buildSecurityHeaders({ ...options, enforce: true })).toContain('Content-Security-Policy:');
    expect(buildSecurityHeaders({ ...options, enforce: true })).not.toContain('Content-Security-Policy-Report-Only:');
  });

  it('sets HSTS without includeSubDomains or preload', () => {
    const hsts = buildSecurityHeaders(options).split('\n').find((line) => line.includes('Strict-Transport-Security'))!;

    expect(hsts).toBe('  Strict-Transport-Security: max-age=31536000');
    expect(hsts).not.toMatch(/includeSubDomains|preload/i);
  });

  it('sets the remaining required security headers and denies the listed capabilities', () => {
    const headers = buildSecurityHeaders(options);

    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toContain(
      'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), accelerometer=(), gyroscope=(), magnetometer=()'
    );
  });

  it('rejects missing or invalid Metered hostnames', () => {
    expect(() => buildSecurityHeaders({ ...options, meteredDomain: '' })).toThrow(/VITE_METERED_APP_DOMAIN is required/);
    for (const meteredDomain of ['https://turn.example.net', 'turn.example.net:443', '*.example.net', 'turn.example.net/path']) {
      expect(() => buildSecurityHeaders({ ...options, meteredDomain })).toThrow(/plain hostname/);
    }
  });

  it('accepts only secure WebSocket signalling origins', () => {
    for (const origin of ['http://signal.example', 'ws://signal.example', 'wss://signal.example/path']) {
      expect(() => buildSecurityHeaders({ ...options, signalOrigins: [origin] })).toThrow(/wss:\/\/ origin/);
    }
  });

  it('produces deterministic output', () => {
    expect(buildSecurityHeaders(options)).toBe(buildSecurityHeaders(options));
    expect(buildSecurityHeaders({
      ...options,
      signalOrigins: ['wss://signal.example', 'wss://signal.example']
    })).toBe(buildSecurityHeaders({ ...options, signalOrigins: ['wss://signal.example'] }));
  });
});
