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
    };

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
  const explicit = (import.meta as any).env?.VITE_SIGNAL_SERVER_URL as string | undefined;
  if (explicit && explicit.trim()) {
    return normalizeSignalUrl(explicit.trim());
  }

  if (typeof window !== 'undefined') {
    const pageProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${pageProtocol}//${window.location.hostname}:8765`;
  }

  return 'ws://127.0.0.1:8765';
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
      const message = JSON.parse(event.data) as SignalMessage;
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
