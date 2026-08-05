export type ConnectionState = 'idle' | 'signalling' | 'connecting' | 'connected' | 'disconnected';

export interface SignedMessage {
  type: 'text';
  body: string;
  timestamp: number;
}
