import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTERNAL_IMAGE_LIMIT_MB,
  EXTERNAL_IMAGE_HARD_LIMIT_BYTES,
  checkExternalImageSizes,
  decodeMarkdownMessage,
  encodeMarkdownMessage,
  fetchBoundedExternalImage,
  markdownImageUrls,
  parseExternalImageLimitMb,
  sanitizeExternalImageSizes,
  validateExternalUrl
} from './external-content';

describe('external Markdown content helpers', () => {
  it('accepts only absolute HTTP and HTTPS URLs without credentials', () => {
    expect(validateExternalUrl('https://example.com/a')).toMatchObject({ hostname: 'example.com' });
    expect(validateExternalUrl('https://bücher.example')?.hostname).toBe('xn--bcher-kva.example');
    expect(validateExternalUrl('https://[2001:4860:4860::8888]')).not.toBeNull();
    expect(validateExternalUrl('http://example.com')).not.toBeNull();
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      '//example.com/image.png',
      'https://user:secret@example.com/image.png',
      'https://example.com:99999/image.png',
      'https://example.com\\@attacker.test/image.png',
      'http://localhost/image.png',
      'http://intranet.local/image.png',
      'http://10.0.0.8/image.png',
      'http://2130706433/image.png',
      'http://[::1]/image.png',
      'http://[2002:7f00:1::]/image.png'
    ]) {
      expect(validateExternalUrl(url)).toBeNull();
    }
  });

  it('finds unique safe Markdown image URLs', () => {
    expect(markdownImageUrls(
      '![one](https://images.example/one.jpg) ![two](https://images.example/one.jpg) ![bad](javascript:alert(1))'
    )).toEqual(['https://images.example/one.jpg']);
  });

  it('records a valid HEAD content length and marks blocked or unusable sizes unknown', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Length': '1234' } }))
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Length': 'not-a-size' } }))
      .mockRejectedValueOnce(new TypeError('CORS blocked'));
    const result = await checkExternalImageSizes(
      '![a](https://a.example/a.png) ![b](https://b.example/b.png) ![c](https://c.example/c.png) ![d](https://d.example/d.png)',
      fetcher
    );
    expect(result).toEqual([
      { url: 'https://a.example/a.png', status: 'known', sizeBytes: 1234 },
      { url: 'https://b.example/b.png', status: 'unknown' },
      { url: 'https://c.example/c.png', status: 'unknown' },
      { url: 'https://d.example/d.png', status: 'unknown' }
    ]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenCalledWith(
      'https://a.example/a.png',
      expect.objectContaining({ method: 'HEAD', mode: 'cors', credentials: 'omit' })
    );
  });

  it('validates metadata received from untrusted peers and treats missing metadata as unknown', () => {
    const metadata = sanitizeExternalImageSizes([
      { url: 'https://images.example/a.png', status: 'known', sizeBytes: 1000 },
      { url: 'https://images.example/b.png', status: 'known', sizeBytes: -1 },
      { url: 'javascript:alert(1)', status: 'known', sizeBytes: 1 },
      { url: 'https://images.example/c.png', status: 'unknown', sizeBytes: 0 },
      { url: 'https://images.example/d.png', status: 'known', sizeBytes: Number.MAX_SAFE_INTEGER + 1 }
    ]);
    expect(metadata).toEqual([
      { url: 'https://images.example/a.png', status: 'known', sizeBytes: 1000 },
      { url: 'https://images.example/c.png', status: 'unknown' }
    ]);
    expect(parseExternalImageLimitMb(null)).toBe(DEFAULT_EXTERNAL_IMAGE_LIMIT_MB);
    expect(parseExternalImageLimitMb('0')).toBe(0);
    expect(parseExternalImageLimitMb('-2')).toBe(DEFAULT_EXTERNAL_IMAGE_LIMIT_MB);
  });

  it('round-trips encrypted-message Markdown metadata while preserving legacy plaintext', () => {
    const encoded = encodeMarkdownMessage('![alt](https://images.example/a.png)', [
      { url: 'https://images.example/a.png', status: 'known', sizeBytes: 42 }
    ]);
    expect(decodeMarkdownMessage(encoded)).toEqual({
      content: '![alt](https://images.example/a.png)',
      imageSizes: [{ url: 'https://images.example/a.png', status: 'known', sizeBytes: 42 }]
    });
    expect(decodeMarkdownMessage('legacy message')).toEqual({ content: 'legacy message', imageSizes: [] });
    expect(decodeMarkdownMessage('{"format":"mycelium-markdown-v1","content":"safe","imageSizes":null}'))
      .toEqual({ content: 'safe', imageSizes: [] });
  });

  it('aborts a streamed response that exceeds the hard cap even when Content-Length lies', async () => {
    const oversized = new Uint8Array(EXTERNAL_IMAGE_HARD_LIMIT_BYTES + 1);
    const response = new Response(oversized, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '1'
      }
    });
    await expect(fetchBoundedExternalImage(
      'https://images.example/large.png',
      new AbortController().signal,
      vi.fn<typeof fetch>().mockResolvedValue(response)
    )).rejects.toThrow('10 MiB loading limit');
  });

  it('rejects SVG, misleading raster content types, and CORS/network failures', async () => {
    const svg = new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
    await expect(fetchBoundedExternalImage(
      'https://images.example/vector.svg',
      new AbortController().signal,
      vi.fn<typeof fetch>().mockResolvedValue(svg)
    )).rejects.toThrow('Only PNG, JPEG');

    const mislabeled = new Response('<svg/>', { headers: { 'Content-Type': 'image/png' } });
    await expect(fetchBoundedExternalImage(
      'https://images.example/misleading.png',
      new AbortController().signal,
      vi.fn<typeof fetch>().mockResolvedValue(mislabeled)
    )).rejects.toThrow('safe raster format');

    await expect(fetchBoundedExternalImage(
      'https://images.example/cors.png',
      new AbortController().signal,
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('CORS failure'))
    )).rejects.toThrow('CORS failure');
  });
});
