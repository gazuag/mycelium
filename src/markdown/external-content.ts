import { marked, type Token } from 'marked';

export const DEFAULT_EXTERNAL_IMAGE_LIMIT_MB = 5;
export const MAX_EXTERNAL_IMAGE_LIMIT_MB = 1000;
export const EXTERNAL_IMAGE_LIMIT_STORAGE_KEY = 'myceliumExternalImageLimitMb';
export const EXTERNAL_IMAGE_HARD_LIMIT_BYTES = 10 * 1024 * 1024;
export const EXTERNAL_IMAGE_MEMORY_CACHE_BYTES = 10 * 1024 * 1024;
const EXTERNAL_IMAGE_MEMORY_CACHE_ENTRIES = 32;
const MAX_MARKDOWN_PARSE_LENGTH = 100_000;
const MAX_MARKDOWN_NESTING = 32;

interface CachedExternalImage {
  readonly objectUrl: string;
  readonly sizeBytes: number;
  activeUsers: number;
}

const cachedImages = new Map<string, CachedExternalImage>();
let cachedImageBytes = 0;

export type ExternalImageSize =
  | { readonly url: string; readonly status: 'known'; readonly sizeBytes: number }
  | { readonly url: string; readonly status: 'unknown' };

export interface MarkdownMessagePayload {
  readonly content: string;
  readonly imageSizes: readonly ExternalImageSize[];
}

export function parseExternalImageLimitMb(value: string | null): number {
  if (value === null || value.trim() === '') return DEFAULT_EXTERNAL_IMAGE_LIMIT_MB;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_EXTERNAL_IMAGE_LIMIT_MB
    ? parsed
    : DEFAULT_EXTERNAL_IMAGE_LIMIT_MB;
}

export function validateExternalUrl(value: string): URL | null {
  if (!value || value.length > 4096 || /[\u0000-\u0020\\]/.test(value)) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || !url.hostname
      || url.username
      || url.password
      || isLocalOrPrivateHostname(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost'
    || host === 'localhost.localdomain'
    || host === 'ip6-localhost'
    || ['.localhost', '.local', '.internal', '.home.arpa', '.lan'].some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = host.slice(1, -1).split(':');
    const firstGroup = Number.parseInt(groups[0] || '0', 16);
    if (firstGroup < 0x2000 || firstGroup > 0x3fff) return true;
    if (firstGroup === 0x2002) {
      const embedded = groups.slice(1, 3).map((group) => group.padStart(4, '0')).join('');
      if (embedded.length === 8 && isPrivateIpv4(Number.parseInt(embedded, 16))) return true;
    }
    return false;
  }
  const octets = host.split('.');
  if (octets.length === 1) return true;
  if (octets.length !== 4 || !octets.every((part) => /^\d+$/.test(part) && Number(part) <= 255)) return false;
  const address = octets.reduce((value, part) => (value * 256) + Number(part), 0);
  return isPrivateIpv4(address);
}

function isPrivateIpv4(address: number): boolean {
  const first = address >>> 24;
  const second = (address >>> 16) & 0xff;
  const third = (address >>> 8) & 0xff;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && ((second === 0 && third === 0) || second === 168))
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function protectUnderlineDelimiters(source: string): string {
  const dunderNames = new Set([
    'all', 'class', 'dict', 'doc', 'eq', 'file', 'getattr', 'hash', 'init',
    'iter', 'main', 'name', 'package', 'repr', 'slots', 'str'
  ]);
  return source.replace(
    /(^|[\t \r\n(\[{>])__([^\s_](?:[^_\n]*?[^\s_])?)__(?=$|[\t \r\n.,!?;:)\]}])/g,
    (_match, prefix: string, text: string) => dunderNames.has(text)
      ? `${prefix}__${text}__`
      : `${prefix}**\uE000${text}\uE001**`
  );
}

export function lexMarkdown(source: string): Token[] {
  if (source.length > MAX_MARKDOWN_PARSE_LENGTH) {
    return [{ type: 'text', raw: source, text: source }];
  }
  try {
    return marked.lexer(protectUnderlineDelimiters(source), { gfm: true, breaks: true });
  } catch {
    return [{ type: 'text', raw: source, text: source }];
  }
}

function collectImageTokens(tokens: readonly Token[], urls: string[], depth = 0): void {
  if (depth > MAX_MARKDOWN_NESTING) return;
  for (const token of tokens) {
    if (token.type === 'image') urls.push(token.href);
    if ('tokens' in token && Array.isArray(token.tokens)) collectImageTokens(token.tokens, urls, depth + 1);
    if (token.type === 'list') {
      for (const item of token.items) collectImageTokens(item.tokens, urls, depth + 1);
    }
  }
}

export function markdownImageUrls(source: string): string[] {
  const urls: string[] = [];
  collectImageTokens(lexMarkdown(source), urls);
  return [...new Set(urls.filter((url) => validateExternalUrl(url) !== null))].slice(0, 20);
}

export async function checkExternalImageSizes(
  source: string,
  fetcher: typeof fetch = fetch
): Promise<ExternalImageSize[]> {
  const urls = markdownImageUrls(source);
  return await Promise.all(urls.map(async (url): Promise<ExternalImageSize> => {
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = globalThis.setTimeout(() => controller.abort(), 3500);
      const response = await fetcher(url, {
        method: 'HEAD',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal
      });
      const header = response.headers.get('Content-Length');
      if (!response.ok || !header || !/^\d+$/.test(header)) return { url, status: 'unknown' };
      const sizeBytes = Number(header);
      return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
        ? { url, status: 'known', sizeBytes }
        : { url, status: 'unknown' };
    } catch {
      return { url, status: 'unknown' };
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
  }));
}

export function sanitizeExternalImageSizes(value: unknown): ExternalImageSize[] {
  if (!Array.isArray(value)) return [];
  const result: ExternalImageSize[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.url !== 'string' || !validateExternalUrl(candidate.url)) continue;
    if (candidate.status === 'known'
      && typeof candidate.sizeBytes === 'number'
      && Number.isSafeInteger(candidate.sizeBytes)
      && candidate.sizeBytes >= 0) {
      result.push({ url: candidate.url, status: 'known', sizeBytes: candidate.sizeBytes });
    } else if (candidate.status === 'unknown') {
      result.push({ url: candidate.url, status: 'unknown' });
    }
  }
  return result;
}

export function getExternalImageSize(
  sizes: unknown,
  url: string
): ExternalImageSize | undefined {
  return sanitizeExternalImageSizes(sizes).find((size) => size.url === url);
}

export function getCachedExternalImage(url: string): string | null {
  const cached = cachedImages.get(url);
  if (!cached) return null;
  cached.activeUsers += 1;
  cachedImages.delete(url);
  cachedImages.set(url, cached);
  return cached.objectUrl;
}

export function cacheExternalImage(url: string, image: Blob): string | null {
  if (image.size > EXTERNAL_IMAGE_MEMORY_CACHE_BYTES) return null;
  const existing = cachedImages.get(url);
  if (existing) {
    existing.activeUsers += 1;
    cachedImages.delete(url);
    cachedImages.set(url, existing);
    return existing.objectUrl;
  }
  while (cachedImageBytes + image.size > EXTERNAL_IMAGE_MEMORY_CACHE_BYTES
    || cachedImages.size >= EXTERNAL_IMAGE_MEMORY_CACHE_ENTRIES) {
    const evictable = [...cachedImages.entries()].find(([, cached]) => cached.activeUsers === 0);
    if (!evictable) return null;
    cachedImages.delete(evictable[0]);
    cachedImageBytes -= evictable[1].sizeBytes;
    URL.revokeObjectURL(evictable[1].objectUrl);
  }
  const objectUrl = URL.createObjectURL(image);
  cachedImages.set(url, { objectUrl, sizeBytes: image.size, activeUsers: 1 });
  cachedImageBytes += image.size;
  return objectUrl;
}

export function releaseCachedExternalImage(objectUrl: string): boolean {
  const cached = [...cachedImages.values()].find((item) => item.objectUrl === objectUrl);
  if (!cached) return false;
  cached.activeUsers = Math.max(0, cached.activeUsers - 1);
  return true;
}

export function discardCachedExternalImage(objectUrl: string): void {
  for (const [url, cached] of cachedImages) {
    if (cached.objectUrl !== objectUrl) continue;
    cachedImages.delete(url);
    cachedImageBytes -= cached.sizeBytes;
    URL.revokeObjectURL(objectUrl);
    return;
  }
}

const DM_MARKDOWN_PAYLOAD_MARKER = 'mycelium-markdown-v1';

export function encodeMarkdownMessage(
  content: string,
  imageSizes: readonly ExternalImageSize[]
): string {
  return JSON.stringify({
    format: DM_MARKDOWN_PAYLOAD_MARKER,
    content,
    imageSizes: sanitizeExternalImageSizes(imageSizes)
  });
}

export function decodeMarkdownMessage(text: string): MarkdownMessagePayload {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { content: text, imageSizes: [] };
    const candidate = value as Record<string, unknown>;
    if (candidate.format !== DM_MARKDOWN_PAYLOAD_MARKER || typeof candidate.content !== 'string') {
      return { content: text, imageSizes: [] };
    }
    return {
      content: candidate.content,
      imageSizes: sanitizeExternalImageSizes(candidate.imageSizes)
    };
  } catch {
    return { content: text, imageSizes: [] };
  }
}

export async function fetchBoundedExternalImage(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<Blob> {
  if (!validateExternalUrl(url)) throw new Error('This is not a valid external image URL.');
  const response = await fetcher(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal
  });
  if (!response.ok || response.type === 'opaque') {
    await response.body?.cancel();
    throw new Error('The image server did not allow a readable response.');
  }
  if (!validateExternalUrl(response.url || url)) {
    await response.body?.cancel();
    throw new Error('The image redirected to an invalid destination.');
  }
  const mediaType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (!mediaType || !/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mediaType)) {
    await response.body?.cancel();
    throw new Error('Only PNG, JPEG, GIF, WebP, AVIF, and BMP images can be displayed.');
  }
  const headerLength = response.headers.get('Content-Length');
  if (headerLength && /^\d+$/.test(headerLength) && Number(headerLength) > EXTERNAL_IMAGE_HARD_LIMIT_BYTES) {
    await response.body?.cancel();
    throw new Error('The image exceeds Mycelium’s 10 MiB loading limit.');
  }
  if (!response.body) throw new Error('The image response could not be read.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > EXTERNAL_IMAGE_HARD_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error('The image exceeds Mycelium’s 10 MiB loading limit.');
    }
    chunks.push(value);
  }
  if (signal.aborted) throw new Error('Image loading was cancelled.');
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!isSupportedRasterImage(bytes, mediaType)) {
    throw new Error('The image data is not a supported safe raster format.');
  }
  return new Blob([bytes.buffer], { type: mediaType });
}

function isSupportedRasterImage(bytes: Uint8Array, mediaType: string): boolean {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 8
        && bytes[0] === 0x89 && ascii(1, 3) === 'PNG'
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a');
    case 'image/webp':
      return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
    case 'image/bmp':
      return bytes.length >= 2 && ascii(0, 2) === 'BM';
    case 'image/avif':
      return bytes.length >= 12 && ascii(4, 4) === 'ftyp' && /^(avif|avis)$/.test(ascii(8, 4));
    default:
      return false;
  }
}
