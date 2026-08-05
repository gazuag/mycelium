export interface SignalMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  from: string;
  to: string;
  payload: any;
}

const SIGNAL_SERVER = ((import.meta as any).env?.VITE_SIGNAL_SERVER_URL as string) || 'ws://217.154.78.152:8765';

export function connectToSignalling(localId: string, onMessage: (message: SignalMessage) => void) {
  const socket = new WebSocket(SIGNAL_SERVER);

  socket.addEventListener('open', () => {
    console.log('Signalling server connected');
    const registerMessage = JSON.stringify({ type: 'register', id: localId });
    socket.send(registerMessage);
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
