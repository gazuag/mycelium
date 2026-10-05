import type { PacketSigner, UnsignedMyceliumPacket } from '../p2p/protocol';
import type { PeerConnectionObjectTransport } from '../p2p/object-transport';
import type { FindClientTransport } from './find-client';
import type { ObjectPacket } from './types';

export interface FindTransportAdapterOptions {
  objectTransport: Pick<PeerConnectionObjectTransport, 'connectedPeers' | 'send' | 'onPacket'>;
  signPacket: PacketSigner;
}

export function wrapFindTransport({
  objectTransport,
  signPacket
}: FindTransportAdapterOptions): FindClientTransport {
  return {
    connectedPeers: () => objectTransport.connectedPeers(),
    subscribe: (handler) => objectTransport.onPacket(handler),
    async send(peerId, packet) {
      const unsignedPacket: UnsignedMyceliumPacket = {
        protocol: packet.protocol,
        version: packet.version,
        id: packet.id,
        type: packet.type,
        timestamp: packet.timestamp,
        sender: packet.sender,
        recipient: packet.recipient,
        payload: { ...packet.payload }
      };
      const signedPacket = {
        ...unsignedPacket,
        signature: await signPacket(unsignedPacket)
      } as ObjectPacket;
      await objectTransport.send(peerId, signedPacket);
    }
  };
}
