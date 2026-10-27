export type SignalMessage =
  | {
      type: 'offer' | 'answer' | 'ice-candidate';
      from: string;
      to: string;
      payload: any;
    }
  | {
      type: 'peer-list';
      peers: string[];
      requestId?: string;
    }
  | {
      type: 'discovery-result';
      packet: unknown;
    }
    | {
      type: 'peer-discovery-result';
      packet: unknown;
    };

interface PendingOnlinePeerList {
  readonly resolve: (peers: string[]) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const pendingOnlinePeerLists = new Map<string, PendingOnlinePeerList>();
const ONLINE_PEER_LIST_TIMEOUT_MS = 5_000;

export type PeerSignalMessage = Extract<SignalMessage, { type: 'offer' | 'answer' | 'ice-candidate' }>;

const SIGNAL_SERVER_HOST = 'discover.unfilter.ing';
const SIGNAL_SERVER_PORT = 8443;
const DEFAULT_SIGNAL_SERVER_URL = `wss://${SIGNAL_SERVER_HOST}:${SIGNAL_SERVER_PORT}`;

function normalizeSignalUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return DEFAULT_SIGNAL_SERVER_URL;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      console.warn('Only ws:// and wss:// are supported for the signalling server. HTTP/S endpoints are rejected.');
      return DEFAULT_SIGNAL_SERVER_URL;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      console.warn('Insecure ws:// signalling is allowed only for loopback hosts; falling back to the default wss:// endpoint.');
      return DEFAULT_SIGNAL_SERVER_URL;
    }
    return url.toString();
  } catch {
    return DEFAULT_SIGNAL_SERVER_URL;
  }
}

export function resolveSignalServerUrl() {
  const configuredUrl = (globalThis as typeof globalThis & { VITE_SIGNAL_SERVER_URL?: string }).VITE_SIGNAL_SERVER_URL ?? '';
  return normalizeSignalUrl(configuredUrl.trim() || DEFAULT_SIGNAL_SERVER_URL);
}

export function connectToSignalling(
  localId: string,
  onMessage: (message: SignalMessage) => void,
  onStatus?: (status: string) => void
) {
  const signalServerUrl = resolveSignalServerUrl();
  if (!signalServerUrl.startsWith('ws://') && !signalServerUrl.startsWith('wss://')) {
    throw new Error('The signalling server must use a websocket URL only. No HTTP/S endpoints are allowed.');
  }
  const socket = new WebSocket(signalServerUrl);
  const normalizedId = localId.trim();
  const socketStartedAt = Date.now();

  onStatus?.('connecting');

  socket.addEventListener('open', () => {
    onStatus?.('connected');
    console.log(`[signalling peer=${normalizedId} elapsed=${Date.now() - socketStartedAt}ms] WebSocket open`, signalServerUrl);
    const registerMessage = JSON.stringify({ type: 'register', id: normalizedId });
    socket.send(registerMessage);
  });

  socket.addEventListener('close', () => {
    onStatus?.('closed');
    console.log(`[signalling peer=${normalizedId} elapsed=${Date.now() - socketStartedAt}ms] WebSocket close`, signalServerUrl);
  });

  socket.addEventListener('error', (event) => {
    onStatus?.('error');
    console.error(`[signalling peer=${normalizedId} elapsed=${Date.now() - socketStartedAt}ms] WebSocket error`, signalServerUrl, event);
  });

  socket.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data);
      // Route Mycelium DISCOVERY_RESULT packets as a typed discovery-result message.
      if (parsed?.protocol === 'mycelium' && parsed?.type === 'DISCOVERY_RESULT') {
        onMessage({ type: 'discovery-result', packet: parsed });
        return;
      }
      if (parsed?.protocol === 'mycelium' && ['PEER_POOL_RESULT', 'POPULAR_PEERS_RESULT'].includes(parsed?.type)) {
        onMessage({ type: 'peer-discovery-result', packet: parsed });
        return;
      }
      const message = parsed as SignalMessage;
      onMessage(message);
    } catch (error) {
      console.error('Failed to parse signalling message', error);
    }
  });

  return socket;
}

export function sendSignal(socket: WebSocket, message: SignalMessage) {
  socket.send(JSON.stringify(message));
}

export function requestOnlinePeerList(socket: WebSocket, localId: string): Promise<string[]> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Online peer-list request failed: WebSocket not open'));
  }
  const requestId = createPeerListRequestId();
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOnlinePeerLists.delete(requestId);
      reject(new Error('Online peer-list request failed: timeout'));
    }, ONLINE_PEER_LIST_TIMEOUT_MS);
    pendingOnlinePeerLists.set(requestId, { resolve, timer });
    try {
      socket.send(JSON.stringify({ type: 'peer-list-request', id: localId, requestId }));
    } catch (error) {
      clearTimeout(timer);
      pendingOnlinePeerLists.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function resolveOnlinePeerList(message: SignalMessage): boolean {
  if (message.type !== 'peer-list' || typeof message.requestId !== 'string') return false;
  const pending = pendingOnlinePeerLists.get(message.requestId);
  if (!pending) return false;
  pendingOnlinePeerLists.delete(message.requestId);
  clearTimeout(pending.timer);
  pending.resolve(message.peers.filter((peerId): peerId is string => typeof peerId === 'string'));
  return true;
}

function createPeerListRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `peer-list-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
