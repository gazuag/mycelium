import type { SignedPost } from '../types';

const DISCOVERY_SERVER = (import.meta as any).env?.VITE_DISCOVERY_SERVER_URL as string || 'http://217.154.78.152:8000';
const MAX_BATCH_SIZE = 30;

export async function publishPost(post: SignedPost) {
  const response = await fetch(`${DISCOVERY_SERVER}/api/discovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(post)
  });
  if (!response.ok) {
    throw new Error(`Discovery publish failed: ${response.statusText}`);
  }
  return response.text();
}

export async function fetchDiscovery(limit = 20, tag?: string) {
  const sanitizedLimit = Math.min(limit, MAX_BATCH_SIZE);
  const url = new URL(`${DISCOVERY_SERVER}/api/discovery`);
  url.searchParams.set('limit', sanitizedLimit.toString());
  if (tag) {
    url.searchParams.set('tag', tag);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Discovery fetch failed: ${response.statusText}`);
  }
  return (await response.json()) as SignedPost[];
}
