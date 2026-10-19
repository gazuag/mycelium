import { parsePeerId } from './peerId';

export interface AddPeerInvite {
  handle: string;
  peerId: string | null;
}

export function parseAddPeerInvitePath(pathname: string): AddPeerInvite | null {
  const match = pathname.match(/^\/add\/([^/]+)\/?$/);
  if (!match) return null;

  let address: string;
  try {
    address = decodeURIComponent(match[1]!);
  } catch {
    return { handle: match[1]!, peerId: null };
  }

  const handle = address.startsWith('@') ? address.slice(1) : address;
  return { handle, peerId: parsePeerId(address) };
}
