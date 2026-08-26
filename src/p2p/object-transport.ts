import { isMyceliumPacket, type MyceliumPacket } from './protocol';
import type { ObjectPacket, ObjectTransport } from '../object-layer/types';
import { PeerConnectionManager } from './webrtc';

export class PeerConnectionObjectTransport implements ObjectTransport {
  private readonly getManagers: () => Record<string, PeerConnectionManager>;
  private readonly handlers = new Set<(peerId: string, packet: ObjectPacket) => void>();

  constructor(getManagers: () => Record<string, PeerConnectionManager>) {
    this.getManagers = getManagers;
  }

  connectedPeers(): string[] {
    return Object.entries(this.getManagers())
      .filter(([, manager]) => manager.isDataChannelOpen())
      .map(([peerId]) => peerId);
  }

  async send(peerId: string, packet: ObjectPacket): Promise<void> {
    const manager = this.getManagers()[peerId];
    if (!manager || !manager.isDataChannelOpen()) {
      throw new Error(`Object transport peer is not connected: ${peerId}`);
    }
    manager.sendObjectPacket(packet);
  }

  onPacket(handler: (peerId: string, packet: ObjectPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  handlePacket(peerId: string, packet: unknown): void {
    if (!isMyceliumPacket(packet) || !['OBJECT_STORE', 'FIND', 'FIND_RESPONSE'].includes(packet.type)) return;
    this.handlers.forEach((handler) => handler(peerId, packet as MyceliumPacket & ObjectPacket));
  }
}