export const MYP_PROTOCOL = 'mycelium';
export const MYP_VERSION = 1;

export type MyceliumPacketType =
  | 'HELLO'
  | 'PING'
  | 'PONG'
  | 'GOODBYE'
  | 'PROFILE_REQUEST'
  | 'PROFILE_RESPONSE'
  | 'PROFILE_UPDATE'
  | 'POST_REQUEST'
  | 'POST_BATCH'
  | 'POST'
  | 'MESSAGE'
  | 'MESSAGE_ACK'
  | 'DISCOVERY_PUBLISH'
  | 'DISCOVERY_GET'
  | 'DISCOVERY_RESULT'
  | 'ERROR';

export interface MyceliumPacket {
  protocol: 'mycelium';
  version: 1;
  id: string;
  type: MyceliumPacketType;
  timestamp: string;
  sender: string;
  recipient: string | null;
  payload: Record<string, unknown>;
  signature: string;
}

export interface UnsignedMyceliumPacket {
  protocol: 'mycelium';
  version: 1;
  id: string;
  type: MyceliumPacketType;
  timestamp: string;
  sender: string;
  recipient: string | null;
  payload: Record<string, unknown>;
}

export type PacketSigner = (packet: UnsignedMyceliumPacket) => Promise<string>;

export function isMyceliumPacket(value: unknown): value is MyceliumPacket {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MyceliumPacket>;
  return candidate.protocol === MYP_PROTOCOL
    && candidate.version === MYP_VERSION
    && typeof candidate.id === 'string'
    && typeof candidate.type === 'string'
    && typeof candidate.timestamp === 'string'
    && typeof candidate.sender === 'string'
    && (candidate.recipient === null || typeof candidate.recipient === 'string')
    && !!candidate.payload
    && typeof candidate.signature === 'string';
}

export function createPacketId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortObject(nested)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export async function buildPacket(
  sender: string,
  recipient: string | null,
  type: MyceliumPacketType,
  payload: Record<string, unknown>,
  signer?: PacketSigner
): Promise<MyceliumPacket> {
  const unsigned: UnsignedMyceliumPacket = {
    protocol: MYP_PROTOCOL,
    version: MYP_VERSION,
    id: createPacketId(),
    type,
    timestamp: new Date().toISOString(),
    sender,
    recipient,
    payload
  };

  let signature = 'unsigned-v1';
  if (signer) {
    signature = await signer(unsigned);
  }

  return {
    ...unsigned,
    signature
  };
}
