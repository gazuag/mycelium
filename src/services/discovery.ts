import type { SignedPost } from '../types';
import { buildPacket, isMyceliumPacket } from '../p2p/protocol';

const DISCOVERY_SERVER = (import.meta as any).env?.VITE_DISCOVERY_SERVER_URL as string || 'https://217.154.78.152:8000';
const MAX_BATCH_SIZE = 30;

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
    throw new Error(`Discovery publish failed: ${response.statusText}`);
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
      throw new Error(`Discovery fetch failed: ${response.statusText}`);
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
