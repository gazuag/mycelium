import { isPeerFingerprint } from './protocol';

export type SignalMessage =
  | {
      type: 'offer' | 'answer' | 'ice-candidate';
      from: string;
      to: string;
      payload: Record<string, unknown>;
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

export function isNegotiationId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

export function shouldYieldToRemoteOffer(localPeerId: string, remotePeerId: string): boolean {
  return localPeerId > remotePeerId;
}

export function isPeerSignalMessage(value: unknown): value is PeerSignalMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<PeerSignalMessage>;
  if ((message.type !== 'offer' && message.type !== 'answer' && message.type !== 'ice-candidate')
    || !isPeerFingerprint(message.from)
    || !isPeerFingerprint(message.to)
    || !message.payload
    || typeof message.payload !== 'object'
    || Array.isArray(message.payload)) return false;

  const payload = message.payload as Record<string, unknown>;
  if (!isNegotiationId(payload.negotiationId)) return false;

  if (message.type === 'offer' || message.type === 'answer') {
    return payload.type === message.type
      && typeof payload.sdp === 'string'
      && payload.sdp.length > 0
      && payload.sdp.length <= 100_000;
  }

  const candidate = payload.candidate;
  if (candidate === null) return true;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const iceCandidate = candidate as Record<string, unknown>;
  return typeof iceCandidate.candidate === 'string'
    && iceCandidate.candidate.length <= 2048
    && (iceCandidate.sdpMid === undefined || iceCandidate.sdpMid === null || typeof iceCandidate.sdpMid === 'string')
    && (iceCandidate.sdpMLineIndex === undefined
      || iceCandidate.sdpMLineIndex === null
      || (typeof iceCandidate.sdpMLineIndex === 'number'
        && Number.isSafeInteger(iceCandidate.sdpMLineIndex)
        && iceCandidate.sdpMLineIndex >= 0))
    && (iceCandidate.usernameFragment === undefined
      || iceCandidate.usernameFragment === null
      || typeof iceCandidate.usernameFragment === 'string');
}

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
      if (message?.type === 'offer' || message?.type === 'answer' || message?.type === 'ice-candidate') {
        if (!isPeerSignalMessage(message)) {
          console.warn('Ignoring malformed peer signalling message');
          return;
        }
      }
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
