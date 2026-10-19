import { usernameToKey } from './usernameCodec';

const COLON_SEPARATED_PEER_ID = /^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$/i;
const COMPACT_PEER_ID = /^[0-9a-f]{16}$/i;

function formatPeerId(value: bigint): string {
  const hex = value.toString(16).padStart(16, '0');
  return hex.match(/.{2}/g)!.join(':');
}

export function parsePeerId(value: string): string | null {
  const normalized = value.trim();
  if (COLON_SEPARATED_PEER_ID.test(normalized)) {
    return normalized.toLowerCase();
  }
  if (COMPACT_PEER_ID.test(normalized)) {
    return normalized.toLowerCase().match(/.{2}/g)!.join(':');
  }

  const username = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  if (!username) return null;
  try {
    return formatPeerId(usernameToKey(username));
  } catch {
    return null;
  }
}
