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

function normalizeSignalUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function resolveSignalServerUrl() {
  
  /* what the hell is this crap?
  const explicit = (import.meta as any).env?.VITE_SIGNAL_SERVER_URL as string | undefined;
  if (explicit && explicit.trim()) {
    return normalizeSignalUrl(explicit.trim());
  }

  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'ws://217.154.78.152:8765';
    }
    const pageProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${pageProtocol}//${hostname}:8765`;
  }
*/
  return 'ws://217.154.78.152:8765';
}

export function connectToSignalling(
  localId: string,
  onMessage: (message: SignalMessage) => void,
  onStatus?: (status: string) => void
) {
  const signalServerUrl = resolveSignalServerUrl();
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
