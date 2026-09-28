export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' }
];

const CREDENTIALS_TIMEOUT_MS = 10000;

export async function fetchMeteredIceServers(
  appDomain = import.meta.env.VITE_METERED_APP_DOMAIN as string | undefined,
  apiKey = import.meta.env.VITE_METERED_API_KEY as string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<RTCIceServer[]> {
  if (!appDomain?.trim() || !apiKey?.trim()) {
    throw new Error('Metered TURN is not configured: set VITE_METERED_APP_DOMAIN and VITE_METERED_API_KEY');
  }

  const normalizedDomain = appDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const endpoint = new URL(`https://${normalizedDomain}/api/v1/turn/credentials`);
  endpoint.searchParams.set('apiKey', apiKey.trim());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CREDENTIALS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Metered TURN credentials request failed: HTTP ${response.status}`);

  const result: unknown = await response.json();
  if (!Array.isArray(result)) throw new Error('Metered TURN credentials response was not an ICE server array');

  const iceServers = result.flatMap((entry): RTCIceServer[] => {
    if (!entry || typeof entry !== 'object') return [];
    const server = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = typeof server.urls === 'string'
      ? server.urls
      : Array.isArray(server.urls) && server.urls.every((url) => typeof url === 'string')
        ? server.urls as string[]
        : null;
    if (!urls) return [];
    const urlList = typeof urls === 'string' ? [urls] : urls;
    const includesTurn = urlList.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
    if (includesTurn && (typeof server.username !== 'string' || typeof server.credential !== 'string')) return [];
    return [{
      urls,
      ...(typeof server.username === 'string' ? { username: server.username } : {}),
      ...(typeof server.credential === 'string' ? { credential: server.credential } : {})
    }];
  });

  if (!iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
  })) {
    throw new Error('Metered TURN response contained no usable TURN server credentials');
  }
  return iceServers;
}
