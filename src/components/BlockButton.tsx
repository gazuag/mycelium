import { useMemo } from 'react';
import type { Contact } from '../types';

interface BlockButtonProps {
  peerId: string;
  contacts: Contact[];
  onBlock: (peerId: string) => void;
  myPeerId?: string;
}

export function BlockButton({ peerId, contacts, onBlock, myPeerId }: BlockButtonProps) {
  const match = useMemo(
    () => contacts.find((contact) => contact.publicKey === peerId || contact.fingerprint === peerId),
    [contacts, peerId]
  );
  const isFollowed = Boolean(match?.followed);

  const isOwnPeer = Boolean(
    myPeerId && (
      peerId === myPeerId
      || peerId === myPeerId.toLowerCase()
      || match?.publicKey === myPeerId
      || match?.fingerprint === myPeerId
    )
  );

  if (isFollowed || isOwnPeer) return null;

  return (
    <button className="btn secondary" onClick={() => onBlock(peerId)} type="button">
      Block
    </button>
  );
}
