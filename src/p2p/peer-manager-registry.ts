import { PeerConnectionManager } from './webrtc';

export function closeAndRemovePeerManager(
  managers: Record<string, PeerConnectionManager>,
  peerId: string,
  expected?: PeerConnectionManager
) {
  const manager = managers[peerId];
  if (!manager || (expected && manager !== expected)) return false;
  manager.closeConnection();
  if (managers[peerId] === manager) {
    delete managers[peerId];
  }
  return true;
}
