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

const SIGNAL_SERVER = ((import.meta as any).env?.VITE_SIGNAL_SERVER_URL as string) || 'ws://217.154.78.152:8765';

export function connectToSignalling(
  localId: string,
  onMessage: (message: SignalMessage) => void,
  onStatus?: (status: string) => void
) {
  const socket = new WebSocket(SIGNAL_SERVER);
  const normalizedId = localId.trim();

  onStatus?.('connecting');

  socket.addEventListener('open', () => {
    onStatus?.('connected');
    console.log('Signalling server connected');
    const registerMessage = JSON.stringify({ type: 'register', id: normalizedId });
    socket.send(registerMessage);
  });

  socket.addEventListener('close', () => {
    onStatus?.('closed');
    console.log('Signalling server disconnected');
  });

  socket.addEventListener('error', (event) => {
    onStatus?.('error');
    console.error('Signalling server error', event);
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
