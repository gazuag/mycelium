import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendBoundedLog, formatMessageLog, redactNetworkAddresses, shouldRenderDiagnosticPayload } from './diagnostics';

describe('diagnostic helpers', () => {
  it('formats message logs from metadata only', () => {
    const privateText = 'this message must never appear';
    const formatted = formatMessageLog('incoming', {
      peerId: 'peer-identifier-that-is-long',
      messageId: 'message-id-1',
      textLength: privateText.length
    });

    expect(formatted).toBe(`Message incoming: peer=peer-identif messageId=message-id-1 textLength=${privateText.length}`);
    expect(formatted).not.toContain(privateText);
  });

  it('redacts IPv4, IPv6, and ports while preserving ordinary text', () => {
    const diagnostic = 'candidate:abc 1 udp 123 192.0.2.10 54321 typ host remote=[2001:db8::1]:3478 port=9000 connected';
    const redacted = redactNetworkAddresses(diagnostic);

    expect(redacted).not.toContain('192.0.2.10');
    expect(redacted).not.toContain('54321');
    expect(redacted).not.toContain('2001:db8::1');
    expect(redacted).not.toContain('3478');
    expect(redacted).not.toContain('port=9000');
    expect(redacted).toContain('candidate:abc');
    expect(redacted).toContain('connected');
    expect(redactNetworkAddresses('state connected; retrying')).toBe('state connected; retrying');
  });

  it('caps logs and keeps the newest entries', () => {
    expect(appendBoundedLog(['one', 'two'], 'three', 2)).toEqual(['two', 'three']);
  });

  it('allows diagnostic payload rendering only for posts', () => {
    expect(shouldRenderDiagnosticPayload('mycelium.post')).toBe(true);
    expect(shouldRenderDiagnosticPayload('mycelium.dm')).toBe(false);
  });

  it('does not pass message content into App addLog calls', () => {
    const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const unsafeCalls = appSource.split('\n').filter((line) =>
      /\baddLog\s*\(/.test(line)
      && !line.includes('formatMessageLog(')
      && /(?:\.text(?:\.slice|\s*[}),])|incoming|trimmedMessage|messageText|text\.slice)/.test(line)
    );

    expect(unsafeCalls).toEqual([]);
  });
});