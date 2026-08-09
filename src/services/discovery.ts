import type { SignedPost } from '../types';
import { buildPacket, isMyceliumPacket } from '../p2p/protocol';

const MAX_BATCH_SIZE = 30;

function normalizeDiscoveryUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'ws:') {
      url.protocol = 'http:';
    } else if (url.protocol === 'wss:') {
      url.protocol = 'https:';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return rawUrl.replace(/\/$/, '');
  }
}

export function resolveDiscoveryServerUrl() {
  const explicit = (import.meta as any).env?.VITE_DISCOVERY_SERVER_URL as string | undefined;
  if (explicit && explicit.trim()) {
    return normalizeDiscoveryUrl(explicit.trim());
  }

  if (typeof window !== 'undefined') {
    const pageProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${pageProtocol}//${window.location.hostname}:8000`;
  }

  return 'http://127.0.0.1:8000';
}

const DISCOVERY_SERVER = resolveDiscoveryServerUrl();

export async function publishPost(post: SignedPost) {
  const packet = await buildPacket(post.author, null, 'DISCOVERY_PUBLISH', { post });
  let response = await fetch(`${DISCOVERY_SERVER}/api/discovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(packet)
  });
  if (!response.ok) {
    response = await fetch(`${DISCOVERY_SERVER}/api/discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(post)
    });
  }
  if (!response.ok) {
    throw new Error(`Discovery publish failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export async function fetchDiscovery(limit = 20, tag?: string) {
  const sanitizedLimit = Math.min(limit, MAX_BATCH_SIZE);
  const packet = await buildPacket('discovery-client', null, 'DISCOVERY_GET', {
    limit: sanitizedLimit,
    tag: tag ?? null
  });

  let response = await fetch(`${DISCOVERY_SERVER}/api/discovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(packet)
  });

  if (!response.ok) {
    const url = new URL(`${DISCOVERY_SERVER}/api/discovery`);
    url.searchParams.set('limit', sanitizedLimit.toString());
    if (tag) {
      url.searchParams.set('tag', tag);
    }
    response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Discovery fetch failed: ${response.status} ${response.statusText}`);
    }
  }

  const body = await response.json();
  if (Array.isArray(body)) {
    return body as SignedPost[];
  }
  if (isMyceliumPacket(body) && body.type === 'DISCOVERY_RESULT' && Array.isArray(body.payload?.posts)) {
    return body.payload.posts as SignedPost[];
  }
  throw new Error('Discovery fetch failed: malformed response packet');
}
