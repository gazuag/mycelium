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
    }
  | {
      type: 'discovery-result';
      packet: unknown;
    };

export type PeerSignalMessage = Extract<SignalMessage, { type: 'offer' | 'answer' | 'ice-candidate' }>;

const SIGNAL_SERVER_HOST = 'mycelium.my.to';
const SIGNAL_SERVER_PORT = 8765;
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

  onStatus?.('connecting');

  socket.addEventListener('open', () => {
    onStatus?.('connected');
    console.log('Signalling server connected', signalServerUrl);
    const registerMessage = JSON.stringify({ type: 'register', id: normalizedId });
    socket.send(registerMessage);
  });

  socket.addEventListener('close', () => {
    onStatus?.('closed');
    console.log('Signalling server disconnected', signalServerUrl);
  });

  socket.addEventListener('error', (event) => {
    onStatus?.('error');
    console.error('Signalling server error', signalServerUrl, event);
  });

  socket.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data);
      // Route Mycelium DISCOVERY_RESULT packets as a typed discovery-result message.
      if (parsed?.protocol === 'mycelium' && parsed?.type === 'DISCOVERY_RESULT') {
        onMessage({ type: 'discovery-result', packet: parsed });
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
