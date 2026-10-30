import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DistributedObject, FeedCursor, FeedPageMetadata, ObjectPacket } from '../object-layer/types';
import type { PeerSignalMessage } from './signalling';
import type { PeerMetadata } from '../types';
import type { MyceliumPacket } from './protocol';
import {
  configureIceServers,
  MAX_PEER_LIST_SIZE,
  PEER_GOSSIP_CAPABILITY,
  PeerConnectionManager,
  PEER_LIST_RESPONSE_TIMEOUT_MS,
  POST_REQUEST_LIMIT_MAX,
  type PeerListExchangeCallbacks
} from './webrtc';
import { closeAndRemovePeerManager } from './peer-manager-registry';
import { FALLBACK_ICE_SERVERS } from '../services/metered-turn';

class FakeDataChannel {
  readonly label = 'chat';
  readonly id: number;
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 'closed';
    this.onclose?.();
  });

  constructor(id: number) {
    this.id = id;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static activeRemoteDescriptionCalls = 0;
  static maxActiveRemoteDescriptionCalls = 0;
  static createDataChannelCalls = 0;
  lastDataChannel: FakeDataChannel | null = null;
  configuration: RTCConfiguration;

  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onicecandidateerror: ((event: RTCPeerConnectionIceErrorEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  stats = new Map<string, any>();

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel() {
    FakePeerConnection.createDataChannelCalls += 1;
    this.lastDataChannel = new FakeDataChannel(FakePeerConnection.createDataChannelCalls);
    return this.lastDataChannel;
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'offer' };
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: 'answer' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    if (description.type === 'rollback') {
      this.signalingState = 'stable';
    } else if (description.type === 'offer') {
      this.signalingState = 'have-local-offer';
    } else if (description.type === 'answer') {
      this.signalingState = 'stable';
    }
    this.onsignalingstatechange?.();
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    FakePeerConnection.activeRemoteDescriptionCalls += 1;
    FakePeerConnection.maxActiveRemoteDescriptionCalls = Math.max(
      FakePeerConnection.maxActiveRemoteDescriptionCalls,
      FakePeerConnection.activeRemoteDescriptionCalls
    );
    await Promise.resolve();
    FakePeerConnection.activeRemoteDescriptionCalls -= 1;
    if (description.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      this.remoteDescription = description;
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new DOMException('wrong state', 'InvalidStateError');
      this.signalingState = 'stable';
      this.remoteDescription = description;
    }
    this.onsignalingstatechange?.();
  }

  async addIceCandidate() {}
  async getStats() { return this.stats; }
  close() {
    this.connectionState = 'closed';
  }
}

const noop = () => {};
const fakeSocket = () => ({ send: vi.fn() } as unknown as WebSocket);

function createManager(options: {
  localId?: string;
  localCapabilities?: string[];
  peerListExchange?: PeerListExchangeCallbacks;
  onRequestPosts?: (peerId: string, since?: string | null, limit?: number, after?: FeedCursor | null, requestId?: string) => void;
  onMetadata?: (peerId: string, metadata: PeerMetadata, packet?: MyceliumPacket) => void;
  onEvent?: (peerId: string, event: string) => void;
  onObject?: (peerId: string, object: DistributedObject) => void;
  onObjectsBatch?: (peerId: string, objects: DistributedObject[], page?: FeedPageMetadata) => void;
} = {}) {
  return new PeerConnectionManager(
    options.localId ?? 'peer-a',
    noop,
    noop,
    options.onObject ?? noop,
    options.onMetadata ?? noop,
    options.onRequestPosts ?? noop,
    options.onObjectsBatch ?? noop,
    noop,
    noop,
    options.onEvent ?? noop,
    noop,
    undefined,
    options.localCapabilities ?? ['profiles', 'posts', 'messages', 'relay-v1', PEER_GOSSIP_CAPABILITY],
    undefined,
    undefined,
    options.peerListExchange
  );
}

function signal(type: PeerSignalMessage['type'], from = 'peer-b', to = 'peer-a'): PeerSignalMessage {
  return { type, from, to, payload: { type, sdp: type, negotiationId: 'negotiation-test' } } as PeerSignalMessage;
}

async function openDataChannel(
  manager: PeerConnectionManager,
  localId = 'peer-a',
  remoteId = 'peer-b'
): Promise<FakeDataChannel> {
  const peerConnection = FakePeerConnection.instances[FakePeerConnection.instances.length - 1]!;
  const socket = fakeSocket();
  await manager.createOffer(remoteId, socket);
  await manager.handleSignal(signal('answer', remoteId, localId), socket);
  const channel = peerConnection.lastDataChannel!;
  channel.readyState = 'open';
  channel.onopen?.();
  return channel;
}

function helloPacket(payload: Record<string, unknown>, sender = 'peer-b', recipient = 'peer-a'): MyceliumPacket {
  return {
    protocol: 'mycelium',
    version: 1,
    id: 'hello-test',
    type: 'HELLO',
    timestamp: new Date(0).toISOString(),
    sender,
    recipient,
    payload,
    signature: 'packet-signature'
  };
}

function peerListPacket(
  type: 'PEER_LIST_REQUEST' | 'PEER_LIST_RESPONSE',
  payload: Record<string, unknown>,
  sender = 'peer-b',
  recipient: string | null = 'peer-a'
): MyceliumPacket {
  return {
    protocol: 'mycelium',
    version: 1,
    id: `${type.toLowerCase()}-test`,
    type,
    timestamp: new Date(0).toISOString(),
    sender,
    recipient,
    payload,
    signature: 'packet-signature'
  };
}

function receivePacket(channel: FakeDataChannel, packet: MyceliumPacket) {
  channel.onmessage?.({ data: JSON.stringify(packet) } as MessageEvent);
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function peerFingerprint(index: number): string {
  const hex = index.toString(16).padStart(16, '0');
  return hex.match(/.{2}/g)!.join(':');
}

beforeEach(() => {
  configureIceServers(FALLBACK_ICE_SERVERS);
  FakePeerConnection.instances = [];
  FakePeerConnection.activeRemoteDescriptionCalls = 0;
  FakePeerConnection.maxActiveRemoteDescriptionCalls = 0;
  FakePeerConnection.createDataChannelCalls = 0;
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: FakePeerConnection, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: { setInterval, clearInterval, setTimeout, clearTimeout }, configurable: true });
});

describe('PROFILE_UPDATE metadata forwarding', () => {
  it('allows clearing ICE servers for host-only peers', () => {
    configureIceServers([]);

    createManager();

    expect(FakePeerConnection.instances[0].configuration.iceServers).toEqual([]);
  });

  it('preserves the original packet at the metadata callback boundary', () => {
    const received: Array<{ peerId: string; metadata: PeerMetadata; packet?: MyceliumPacket }> = [];
    const manager = createManager({
      onMetadata: (peerId, metadata, packet) => received.push({ peerId, metadata, packet })
    });
    const metadata: PeerMetadata = {
      author: 'peer-b',
      publicKey: 'public-key',
      displayName: 'Peer B',
      following: false,
      timestamp: new Date(0).toISOString()
    };
    const packet: MyceliumPacket = {
      protocol: 'mycelium',
      version: 1,
      id: 'profile-update-1',
      type: 'PROFILE_UPDATE',
      timestamp: new Date(0).toISOString(),
      sender: 'peer-b',
      recipient: 'peer-a',
      payload: { profile: metadata },
      signature: 'packet-signature'
    };

    (manager as any).handleMyceliumPacket(packet);

    expect(received).toEqual([{ peerId: 'peer-b', metadata, packet }]);
  });
});

describe('POST_REQUEST limit handling', () => {
  it('clamps the incoming POST_REQUEST limit above the max', () => {
    const requests: Array<{ limit?: number }> = [];
    const manager = createManager({ onRequestPosts: (_peerId, _since, limit) => requests.push({ limit }) });

    (manager as any).handleMyceliumPacket({
      type: 'POST_REQUEST',
      sender: 'peer-b',
      payload: { since: null, limit: 9999 }
    });

    expect(requests).toEqual([{ limit: POST_REQUEST_LIMIT_MAX }]);
  });

  it('falls back to the default POST_REQUEST limit for invalid values', () => {
    const requests: Array<{ limit?: number }> = [];
    const manager = createManager({ onRequestPosts: (_peerId, _since, limit) => requests.push({ limit }) });

    (manager as any).handleMyceliumPacket({
      type: 'POST_REQUEST',
      sender: 'peer-b',
      payload: { since: null, limit: 0 }
    });
    (manager as any).handleMyceliumPacket({
      type: 'POST_REQUEST',
      sender: 'peer-b',
      payload: { since: null, limit: Number.NaN }
    });
    (manager as any).handleMyceliumPacket({
      type: 'POST_REQUEST',
      sender: 'peer-b',
      payload: { since: null }
    });

    expect(requests).toEqual([{ limit: 100 }, { limit: 100 }, { limit: 100 }]);
  });

  it('passes through a valid POST_REQUEST limit under the max', () => {
    const requests: Array<{ limit?: number }> = [];
    const manager = createManager({ onRequestPosts: (_peerId, _since, limit) => requests.push({ limit }) });

    (manager as any).handleMyceliumPacket({
      type: 'POST_REQUEST',
      sender: 'peer-b',
      payload: { since: null, limit: 42 }
    });

    expect(requests).toEqual([{ limit: 42 }]);
  });

  it('clamps POST_REQUEST limits to the feed page maximum of 200', () => {
    const requests: Array<{ limit?: number }> = [];
    const manager = createManager({ onRequestPosts: (_peerId, _since, limit) => requests.push({ limit }) });
    (manager as any).handleMyceliumPacket({ type: 'POST_REQUEST', sender: 'peer-b', payload: { limit: 500 } });
    expect(requests).toEqual([{ limit: 200 }]);
  });

  it('round-trips after and requestId while treating malformed values as absent', async () => {
    const requests: Array<{ since?: string | null; limit?: number; after?: FeedCursor | null; requestId?: string }> = [];
    const manager = createManager({
      onRequestPosts: (_peerId, since, limit, after, requestId) => requests.push({ since, limit, after, requestId })
    });
    const sendPacket = vi.fn();
    (manager as any).sendPacket = sendPacket;
    const after = { created_at: '2026-10-07T08:00:00.000Z', object_id: 'a'.repeat(64) };

    await manager.sendRequestPosts(null, 200, { after, requestId: 'request-1' });
    expect(sendPacket).toHaveBeenCalledWith('POST_REQUEST', { since: null, limit: 200, after, requestId: 'request-1' }, true);
    (manager as any).handleMyceliumPacket({
      type: 'POST_REQUEST',
      sender: 'peer-b',
      payload: { since: 'ignored-cursor', limit: 200, after, requestId: 'request-1' }
    });
    (manager as any).handleMyceliumPacket({
      type: 'POST_REQUEST',
      sender: 'peer-b',
      payload: { after: { created_at: 'bad', object_id: 9 }, requestId: 12 }
    });

    expect(requests).toEqual([
      { since: 'ignored-cursor', limit: 200, after, requestId: 'request-1' },
      { since: null, limit: 100, after: null, requestId: undefined }
    ]);
  });

  it('forwards valid page metadata and continues handling legacy batches without it', () => {
    const batches: Array<{ objects: DistributedObject[]; page?: FeedPageMetadata }> = [];
    const manager = createManager({
      onObjectsBatch: (_peerId, objects, page) => batches.push({ objects, page })
    });
    const object = { object_id: 'a'.repeat(64) } as DistributedObject;
    const page: FeedPageMetadata = {
      request_id: 'request-2',
      next_cursor: { created_at: '2026-10-07T08:00:00.000Z', object_id: object.object_id },
      has_more: true
    };
    const sendPacket = vi.fn();
    (manager as any).sendPacket = sendPacket;

    manager.sendObjectsBatch([object]);
    manager.sendObjectsBatch([object], page);
    (manager as any).handleMyceliumPacket({ type: 'OBJECT_BATCH', sender: 'peer-b', payload: { objects: [object] } });
    (manager as any).handleMyceliumPacket({ type: 'OBJECT_BATCH', sender: 'peer-b', payload: { objects: [object], page } });

    expect(sendPacket).toHaveBeenNthCalledWith(1, 'OBJECT_BATCH', { objects: [object] });
    expect(sendPacket).toHaveBeenNthCalledWith(2, 'OBJECT_BATCH', { objects: [object], page });
    expect(batches).toEqual([{ objects: [object], page: undefined }, { objects: [object], page }]);
  });
});

describe('HELLO peer capabilities', () => {
  it('retains advertised capabilities and matches names exactly', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({
      nickname: 'Peer B',
      capabilities: ['profiles', 'peer-gossip-v1', 'relay-v1']
    }));

    expect(manager.supportsCapability('profiles')).toBe(true);
    expect(manager.supportsCapability('peer-gossip-v1')).toBe(true);
    expect(manager.supportsCapability('peer-gossip')).toBe(false);
    manager.closeConnection();
  });

  it('treats a missing capabilities field as unsupported without disrupting older peers', async () => {
    const events: string[] = [];
    const manager = createManager({ onEvent: (_peerId, event) => events.push(event) });
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ nickname: 'Older Peer' }));

    expect(manager.supportsCapability('peer-gossip-v1')).toBe(false);
    expect(manager.isDataChannelOpen()).toBe(true);
    expect(events).toContain('HELLO received from Older Peer capabilities=[none]');
    manager.closeConnection();
  });

  it('treats a malformed capabilities field as supporting nothing', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ capabilities: ['peer-gossip-v1'] }));
    receivePacket(channel, helloPacket({ capabilities: 'peer-gossip-v1' }));

    expect(manager.supportsCapability('peer-gossip-v1')).toBe(false);
    manager.closeConnection();
  });

  it('ignores non-string entries while retaining valid string capabilities', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({
      capabilities: ['peer-gossip-v1', 42, null, { name: 'profiles' }, 'relay-v1']
    }));

    expect(manager.supportsCapability('peer-gossip-v1')).toBe(true);
    expect(manager.supportsCapability('42')).toBe(false);
    expect(manager.supportsCapability('profiles')).toBe(false);
    manager.closeConnection();
  });

  it('keeps capabilities isolated to their connection manager', async () => {
    const firstManager = createManager();
    const firstChannel = await openDataChannel(firstManager);
    const secondManager = createManager();
    const secondChannel = await openDataChannel(secondManager);
    receivePacket(firstChannel, helloPacket({ capabilities: ['peer-gossip-v1'] }));

    expect(firstManager.supportsCapability('peer-gossip-v1')).toBe(true);
    expect(secondManager.supportsCapability('peer-gossip-v1')).toBe(false);
    firstManager.closeConnection();
    secondManager.closeConnection();
  });

  it('clears capabilities when the connection manager is destroyed', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ capabilities: ['peer-gossip-v1'] }));
    expect(manager.supportsCapability('peer-gossip-v1')).toBe(true);

    manager.closeConnection();

    expect(manager.supportsCapability('peer-gossip-v1')).toBe(false);
  });

  it('clears capabilities when the data channel closes', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ capabilities: ['peer-gossip-v1'] }));
    expect(manager.supportsCapability('peer-gossip-v1')).toBe(true);

    channel.close();

    expect(manager.supportsCapability('peer-gossip-v1')).toBe(false);
  });
});

describe('direct peer-list gossip', () => {
  it('advertises support and sends one request only after the remote advertises support', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    const hello = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .find((packet) => packet.type === 'HELLO');
    expect(hello?.payload.capabilities).toContain(PEER_GOSSIP_CAPABILITY);

    receivePacket(channel, helloPacket({ capabilities: ['profiles', PEER_GOSSIP_CAPABILITY] }));
    await flushMicrotasks();
    receivePacket(channel, helloPacket({ capabilities: [PEER_GOSSIP_CAPABILITY] }));
    await flushMicrotasks();

    const requests = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .filter((packet) => packet.type === 'PEER_LIST_REQUEST');
    expect(requests).toHaveLength(1);
    expect(typeof requests[0].payload.requestId).toBe('string');
    manager.closeConnection();
  });

  it('does not request a peer list from an older peer without the capability', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ nickname: 'Older Peer' }));
    await flushMicrotasks();

    expect(channel.send.mock.calls.map(([data]) => JSON.parse(data).type))
      .not.toContain('PEER_LIST_REQUEST');
    expect(manager.isDataChannelOpen()).toBe(true);
    manager.closeConnection();
  });

  it('responds with only unique, valid currently connected peers, excluding requester and self', async () => {
    const localId = peerFingerprint(1);
    const requesterId = peerFingerprint(2);
    const connectedPeer = peerFingerprint(3);
    const manager = createManager({
      localId,
      peerListExchange: {
        getConnectedPeerIds: () => [requesterId, localId, connectedPeer, connectedPeer.toUpperCase(), 'invalid-peer'],
        onPeerList: noop
      }
    });
    const channel = await openDataChannel(manager, localId, requesterId);

    receivePacket(channel, peerListPacket(
      'PEER_LIST_REQUEST',
      { requestId: 'request-1' },
      requesterId,
      localId
    ));
    await flushMicrotasks();

    const response = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .find((packet) => packet.type === 'PEER_LIST_RESPONSE');
    expect(response?.payload).toEqual({ requestId: 'request-1', peers: [connectedPeer] });
    manager.closeConnection();
  });

  it('bounds response size after excluding invalid IDs and duplicates', async () => {
    const localId = peerFingerprint(1);
    const requesterId = peerFingerprint(2);
    const candidates = Array.from({ length: MAX_PEER_LIST_SIZE + 10 }, (_, index) => peerFingerprint(index + 10));
    const manager = createManager({
      localId,
      peerListExchange: {
        getConnectedPeerIds: () => [...candidates, candidates[0], 'malformed-id', requesterId, localId],
        onPeerList: noop
      }
    });
    const channel = await openDataChannel(manager, localId, requesterId);
    receivePacket(channel, peerListPacket(
      'PEER_LIST_REQUEST',
      { requestId: 'bounded-request' },
      requesterId,
      localId
    ));
    await flushMicrotasks();

    const response = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .find((packet) => packet.type === 'PEER_LIST_RESPONSE');
    const peers = response?.payload.peers as string[];
    expect(peers).toHaveLength(MAX_PEER_LIST_SIZE);
    expect(new Set(peers).size).toBe(MAX_PEER_LIST_SIZE);
    expect(peers).not.toContain(requesterId);
    expect(peers).not.toContain(localId);
    expect(peers).not.toContain('malformed-id');
    manager.closeConnection();
  });

  it('delivers only a matching response from the connected peer to the App callback', async () => {
    const candidates = [peerFingerprint(3), peerFingerprint(3), 'malformed', 'peer-a', 'peer-b'];
    const received: Array<{ sourcePeerId: string; peerIds: readonly string[] }> = [];
    const manager = createManager({
      peerListExchange: {
        getConnectedPeerIds: () => [],
        onPeerList: (sourcePeerId, peerIds) => received.push({ sourcePeerId, peerIds })
      }
    });
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ capabilities: [PEER_GOSSIP_CAPABILITY] }));
    await flushMicrotasks();
    const request = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .find((packet) => packet.type === 'PEER_LIST_REQUEST')!;
    const requestId = request.payload.requestId as string;

    receivePacket(channel, peerListPacket('PEER_LIST_RESPONSE', { requestId: 'unknown', peers: candidates }));
    receivePacket(channel, peerListPacket(
      'PEER_LIST_RESPONSE',
      { requestId, peers: candidates },
      'other-peer'
    ));
    expect(received).toEqual([]);

    receivePacket(channel, peerListPacket('PEER_LIST_RESPONSE', { requestId, peers: candidates }));
    expect(received).toEqual([{ sourcePeerId: 'peer-b', peerIds: [candidates[0]] }]);
    manager.closeConnection();
  });

  it('cleans up pending requests after timeout and ignores late responses', async () => {
    vi.useFakeTimers();
    const received: string[][] = [];
    const manager = createManager({
      peerListExchange: {
        getConnectedPeerIds: () => [],
        onPeerList: (_sourcePeerId, peerIds) => received.push([...peerIds])
      }
    });
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ capabilities: [PEER_GOSSIP_CAPABILITY] }));
    await flushMicrotasks();
    const request = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .find((packet) => packet.type === 'PEER_LIST_REQUEST')!;

    await vi.advanceTimersByTimeAsync(PEER_LIST_RESPONSE_TIMEOUT_MS);
    receivePacket(channel, peerListPacket('PEER_LIST_RESPONSE', {
      requestId: request.payload.requestId,
      peers: [peerFingerprint(3)]
    }));

    expect(received).toEqual([]);
    manager.closeConnection();
    vi.useRealTimers();
  });

  it('cleans up pending requests when the connection closes', async () => {
    const received: string[][] = [];
    const manager = createManager({
      peerListExchange: {
        getConnectedPeerIds: () => [],
        onPeerList: (_sourcePeerId, peerIds) => received.push([...peerIds])
      }
    });
    const channel = await openDataChannel(manager);
    receivePacket(channel, helloPacket({ capabilities: [PEER_GOSSIP_CAPABILITY] }));
    await flushMicrotasks();
    const request = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .find((packet) => packet.type === 'PEER_LIST_REQUEST')!;

    channel.close();
    receivePacket(channel, peerListPacket('PEER_LIST_RESPONSE', {
      requestId: request.payload.requestId,
      peers: [peerFingerprint(3)]
    }));

    expect(received).toEqual([]);
    expect(manager.supportsCapability(PEER_GOSSIP_CAPABILITY)).toBe(false);
    manager.closeConnection();
  });

  it('ignores malformed requests and oversized responses without closing the channel', async () => {
    const manager = createManager();
    const channel = await openDataChannel(manager);
    receivePacket(channel, peerListPacket('PEER_LIST_REQUEST', { requestId: ' '.repeat(5) }));
    receivePacket(channel, helloPacket({ capabilities: [PEER_GOSSIP_CAPABILITY] }));
    await flushMicrotasks();
    const request = channel.send.mock.calls
      .map(([data]) => JSON.parse(data) as MyceliumPacket)
      .find((packet) => packet.type === 'PEER_LIST_REQUEST')!;
    receivePacket(channel, peerListPacket('PEER_LIST_RESPONSE', {
      requestId: request.payload.requestId,
      peers: Array.from({ length: MAX_PEER_LIST_SIZE + 1 }, (_, index) => peerFingerprint(index + 20))
    }));

    expect(manager.isDataChannelOpen()).toBe(true);
    expect(channel.send.mock.calls.map(([data]) => JSON.parse(data).type))
      .not.toContain('PEER_LIST_RESPONSE');
    manager.closeConnection();
  });
});

describe('PeerConnectionManager lifecycle', () => {
  it('uses the configured Metered ICE servers when creating peer connections', () => {
    const meteredServers: RTCIceServer[] = [
      { urls: 'stun:metered.example:80' },
      { urls: 'turn:metered.example:443?transport=tcp', username: 'temporary-user', credential: 'temporary-password' }
    ];
    configureIceServers(meteredServers);

    createManager();

    expect(FakePeerConnection.instances[0].configuration.iceServers).toEqual(meteredServers);
  });

  it('logs all checked ICE pairs on failure and the selected pair when connected', async () => {
    const events: string[] = [];
    const manager = createManager({ onEvent: (peerId, event) => events.push(`${peerId} ${event}`) });
    const connection = FakePeerConnection.instances[0];
    connection.stats = new Map([
      ['local-1', { id: 'local-1', type: 'local-candidate', foundation: 'local-foundation', candidateType: 'host', protocol: 'udp', address: '192.0.2.1', port: 5000, relatedAddress: '10.0.0.1', relatedPort: 5000 }],
      ['remote-1', { id: 'remote-1', type: 'remote-candidate', foundation: 'remote-foundation', candidateType: 'host', protocol: 'udp', address: '198.51.100.1', port: 6000 }],
      ['pair-1', { id: 'pair-1', type: 'candidate-pair', localCandidateId: 'local-1', remoteCandidateId: 'remote-1', state: 'succeeded', nominated: true, selected: true, priority: 100, currentRoundTripTime: 0.025 }],
      ['pair-2', { id: 'pair-2', type: 'candidate-pair', localCandidateId: 'local-1', remoteCandidateId: 'remote-1', state: 'failed', nominated: false, priority: 50, requestsSent: 4, requestsReceived: 2, responsesSent: 1, responsesReceived: 0, error: 'timeout', errorCode: 701 }]
    ]);

    connection.iceConnectionState = 'checking';
    connection.oniceconnectionstatechange?.();
    await Promise.resolve();
    expect(events.some((event) => event.includes('ICE stats snapshot state=checking candidatePairs=2'))).toBe(true);
    expect(events.some((event) => event.includes('ICE stats state=checking') && event.includes('id=pair-1') && event.includes('localCandidateId=local-1') && event.includes('remoteCandidateId=remote-1') && event.includes('priority=100'))).toBe(true);
    expect(events.some((event) => event.includes('ICE stats state=checking') && event.includes('id=pair-2') && event.includes('state=failed'))).toBe(true);

    connection.iceConnectionState = 'connected';
    connection.oniceconnectionstatechange?.();
    await Promise.resolve();
    expect(events.some((event) => event.includes('ICE stats snapshot state=connected candidatePairs=2'))).toBe(true);
    expect(events.some((event) => event.includes('ICE stats state=connected selected candidate pair id=pair-1') && event.includes('192.0.2.1:5000') && event.includes('198.51.100.1:6000') && event.includes('foundation=local-foundation') && event.includes('rtt=0.025s'))).toBe(true);

    connection.iceConnectionState = 'disconnected';
    connection.oniceconnectionstatechange?.();
    await Promise.resolve();
    expect(events.some((event) => event.includes('ICE stats snapshot state=disconnected candidatePairs=2'))).toBe(true);

    connection.iceConnectionState = 'failed';
    connection.oniceconnectionstatechange?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.some((event) => event.includes('ICE stats snapshot state=failed candidatePairs=2'))).toBe(true);
    expect(events.some((event) => event.includes('ICE stats state=failed selected candidate pair id=pair-1 state=succeeded'))).toBe(true);
    expect(events.some((event) => event.includes('ICE stats state=failed candidate pair id=pair-2 state=failed') && event.includes('nominated=false') && event.includes('requestsSent=4') && event.includes('requestsReceived=2') && event.includes('responsesSent=1') && event.includes('error=timeout(701)'))).toBe(true);
  });

  it('logs queued and successful remote ICE candidate application', async () => {
    const events: string[] = [];
    const manager = createManager({ onEvent: (peerId, event) => events.push(`${peerId} ${event}`) });
    const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    const socket = fakeSocket() as WebSocket & { send: ReturnType<typeof vi.fn> };
    await manager.createOffer('peer-b', socket);
    const localConnectionId = manager.getConnectionId();
    await manager.handleSignal({ type: 'ice-candidate', from: 'peer-b', to: 'peer-a', payload: { negotiationId: manager.getActiveNegotiationId(), candidate } }, socket);
    expect(events.some((event) => event.includes('ICE addIceCandidate queued') && event.includes('type=host') && event.includes('address=192.168.1.20') && event.includes('port=54321') && event.includes('queued=true'))).toBe(true);

    const connection = FakePeerConnection.instances[0];
    connection.remoteDescription = { type: 'answer', sdp: 'answer' };
    await manager.handleSignal({ type: 'ice-candidate', from: 'peer-b', to: 'peer-a', payload: { negotiationId: manager.getActiveNegotiationId(), candidate } }, socket);
    expect(events.some((event) => event.includes('ICE addIceCandidate succeeded') && event.includes('type=host') && event.includes('queued=false'))).toBe(true);
  });

  it('ignores signalling messages from a stale connection generation', async () => {
    const events: string[] = [];
    const manager = createManager({ onEvent: (peerId, event) => events.push(`${peerId} ${event}`) });
    const socket = fakeSocket();
    await manager.createOffer('peer-b', socket);
    const activeId = manager.getConnectionId();
    const staleId = `${activeId}-stale`;
    const connection = FakePeerConnection.instances[0];
    const setRemoteDescription = vi.spyOn(connection, 'setRemoteDescription');
    await manager.handleSignal({ type: 'answer', from: 'peer-b', to: 'peer-a', payload: { type: 'answer', sdp: 'stale', negotiationId: staleId } }, socket);
    await manager.handleSignal({ type: 'ice-candidate', from: 'peer-b', to: 'peer-a', payload: { negotiationId: staleId, candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.21 54322 typ host' } } }, socket);
    expect(setRemoteDescription).not.toHaveBeenCalled();
    expect(events.some((event) => event.includes('ignored stale answer') && event.includes(staleId))).toBe(true);
    expect(events.some((event) => event.includes('ignored stale ICE') && event.includes(staleId))).toBe(true);
  });

  it('shares the offerer negotiation ID across peers with different local connection IDs', async () => {
    const offerer = createManager();
    const answerer = createManager({ localId: 'peer-b' });
    const socket = fakeSocket() as WebSocket & { send: ReturnType<typeof vi.fn> };
    await offerer.createOffer('peer-b', socket);
    expect(offerer.didInitiateConnection()).toBe(true);
    const offer = JSON.parse(socket.send.mock.calls[0][0]) as PeerSignalMessage;
    await answerer.handleSignal({ ...offer, from: 'peer-a', to: 'peer-b' }, socket);

    expect(answerer.didInitiateConnection()).toBe(false);
    expect(offerer.getConnectionId()).not.toBe(answerer.getConnectionId());
    expect(offerer.getActiveNegotiationId()).toBe(offer.payload.negotiationId);
    expect(answerer.getActiveNegotiationId()).toBe(offer.payload.negotiationId);
    const answer = JSON.parse(socket.send.mock.calls[1][0]) as PeerSignalMessage;
    expect(answer.type).toBe('answer');
    expect(answer.payload.negotiationId).toBe(offer.payload.negotiationId);
    expect(answer.payload.connectionId).toBeUndefined();
  });

  it('resolves simultaneous offers deterministically and rejects ICE from the abandoned negotiation', async () => {
    const aEvents: string[] = [];
    const bEvents: string[] = [];
    const a = createManager({ onEvent: (peerId, event) => aEvents.push(`${peerId} ${event}`) });
    const b = createManager({ localId: 'peer-b', onEvent: (peerId, event) => bEvents.push(`${peerId} ${event}`) });
    const aSocket = fakeSocket() as WebSocket & { send: ReturnType<typeof vi.fn> };
    const bSocket = fakeSocket() as WebSocket & { send: ReturnType<typeof vi.fn> };
    const aOfferSocket = fakeSocket() as WebSocket & { send: ReturnType<typeof vi.fn> };
    const bOfferSocket = fakeSocket() as WebSocket & { send: ReturnType<typeof vi.fn> };
    await a.createOffer('peer-b', aSocket);
    await b.createOffer('peer-a', bSocket);
    const aOffer = JSON.parse(aSocket.send.mock.calls[0][0]) as PeerSignalMessage;
    const bOffer = JSON.parse(bSocket.send.mock.calls[0][0]) as PeerSignalMessage;
    const aBefore = FakePeerConnection.instances[0];
    const bBefore = FakePeerConnection.instances[1];
    const aSetRemote = vi.spyOn(aBefore, 'setRemoteDescription');
    const bSetRemote = vi.spyOn(bBefore, 'setRemoteDescription');

    await a.handleSignal({ ...bOffer, from: 'peer-b', to: 'peer-a' }, aOfferSocket);
    await b.handleSignal({ ...aOffer, from: 'peer-a', to: 'peer-b' }, bOfferSocket);
    const bAnswer = JSON.parse(bOfferSocket.send.mock.calls[0][0]) as PeerSignalMessage;
    await a.handleSignal({ ...bAnswer, from: 'peer-b', to: 'peer-a' }, aOfferSocket);

    expect(aSetRemote).toHaveBeenCalledOnce();
    expect(bSetRemote).toHaveBeenCalledOnce();
    expect(bAnswer.payload.negotiationId).toBe(aOffer.payload.negotiationId);
    expect(a.getActiveNegotiationId()).toBe(aOffer.payload.negotiationId);
    expect(b.getActiveNegotiationId()).toBe(aOffer.payload.negotiationId);
    expect(aBefore.signalingState).toBe('stable');
    expect(bBefore.signalingState).toBe('stable');

    const addIce = vi.spyOn(bBefore, 'addIceCandidate');
    await b.handleSignal({ type: 'ice-candidate', from: 'peer-a', to: 'peer-b', payload: { negotiationId: bOffer.payload.negotiationId, candidate: { candidate: 'candidate:stale 1 udp 1 192.168.1.2 5000 typ host' } } }, bOfferSocket);
    expect(addIce).not.toHaveBeenCalled();

    expect(a.getConnectionId()).not.toBe(b.getConnectionId());
    expect(aEvents.some((event) => event.includes('glare collision: impolite peer ignored'))).toBe(true);
    expect(bEvents.some((event) => event.includes('glare collision: polite peer rolling back'))).toBe(true);
  });

  it('does not create another channel for repeated offers', async () => {
    const manager = createManager();
    const socket = fakeSocket();

    await manager.createOffer('peer-b', socket);
    await manager.createOffer('peer-b', socket);

    expect(FakePeerConnection.createDataChannelCalls).toBe(1);
  });

  it('recovers a non-polite glare collision after the local offer becomes stale', async () => {
    vi.useFakeTimers();
    const manager = createManager();
    const socket = fakeSocket();

    await manager.createOffer('peer-b', socket);
    await manager.handleSignal(signal('offer'), socket);
    expect(FakePeerConnection.createDataChannelCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(10001);
    await manager.createOffer('peer-b', socket);

    expect(FakePeerConnection.createDataChannelCalls).toBe(2);
    vi.useRealTimers();
  });

  it('replaces a stale connecting channel once signalling is stable', async () => {
    const manager = createManager();
    const socket = fakeSocket();
    const peerConnection = FakePeerConnection.instances[0];

    await manager.createOffer('peer-b', socket);
    await peerConnection.setLocalDescription({ type: 'rollback' });
    await manager.createOffer('peer-b', socket);

    expect(FakePeerConnection.createDataChannelCalls).toBe(2);
  });

  it('lets the answerer accept the incoming chat channel without creating one', async () => {
    const manager = createManager();
    const peerConnection = FakePeerConnection.instances[0];

    await manager.handleSignal(signal('offer'), fakeSocket());
    expect(FakePeerConnection.createDataChannelCalls).toBe(0);

    const channel = new FakeDataChannel(0);
    peerConnection.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent);
    channel.readyState = 'open';
    channel.onopen?.();

    expect(manager.getDataChannelState()).toBe('open');
  });

  it('opens the normal offer-answer data channel path without creating a duplicate', async () => {
    const manager = createManager();
    const peerConnection = FakePeerConnection.instances[0];
    const socket = fakeSocket();

    await manager.createOffer('peer-b', socket);
    await manager.handleSignal(signal('answer'), socket);
    const channel = peerConnection.lastDataChannel!;
    channel.readyState = 'open';
    channel.onopen?.();
    await manager.createOffer('peer-b', socket);

    expect(manager.getDataChannelState()).toBe('open');
    expect(FakePeerConnection.createDataChannelCalls).toBe(1);
  });

  it('sends canonical object packets and ignores removed legacy post payloads', async () => {
    const receivedObjects: DistributedObject[] = [];
    const receivedBatches: DistributedObject[][] = [];
    const manager = createManager({
      onObject: (_peerId, object) => receivedObjects.push(object),
      onObjectsBatch: (_peerId, objects) => receivedBatches.push(objects)
    });
    const peerConnection = FakePeerConnection.instances[0];
    const socket = fakeSocket();
    await manager.createOffer('peer-b', socket);
    await manager.handleSignal(signal('answer'), socket);
    const channel = peerConnection.lastDataChannel!;
    channel.readyState = 'open';
    channel.onopen?.();

    const object = {
      object_id: 'a'.repeat(64),
      object_type: 'mycelium.post',
      author: 'author',
      created_at: '2026-08-25T00:00:00.000Z',
      payload: { content: 'wire object' },
      replication_policy: {},
      signature: 'object-signature'
    } as DistributedObject;
    manager.sendObject(object);
    manager.sendObjectsBatch([object]);
    const directObjectPacket = {
      protocol: 'mycelium',
      version: 1,
      id: 'direct-object-packet',
      type: 'OBJECT_STORE',
      timestamp: '2026-10-05T12:00:00.000Z',
      sender: 'peer-a',
      recipient: 'peer-b',
      payload: { object },
      signature: 'packet-signature'
    } as ObjectPacket;
    manager.sendObjectPacket(directObjectPacket);
    await Promise.resolve();

    expect(channel.send).toHaveBeenCalledWith(JSON.stringify(directObjectPacket));
    const sentTypes = channel.send.mock.calls.map(([payload]) => JSON.parse(payload).type);
    expect(sentTypes).toContain('OBJECT_STORE');
    expect(sentTypes).toContain('OBJECT_BATCH');
    expect(sentTypes).not.toContain('POST');
    expect(sentTypes).not.toContain('POST_BATCH');

    channel.onmessage?.({ data: JSON.stringify({ type: 'signed-post', post: object }) } as MessageEvent);
    channel.onmessage?.({ data: JSON.stringify({ type: 'posts-batch', posts: [object] }) } as MessageEvent);
    channel.onmessage?.({ data: JSON.stringify({ type: 'request-posts', since: null }) } as MessageEvent);
    expect(receivedObjects).toEqual([]);
    expect(receivedBatches).toEqual([]);
  });

  it('silently ignores inbound legacy MESSAGE packets without calling persistence handlers', () => {
    const receivedObjects: DistributedObject[] = [];
    const events: string[] = [];
    const manager = createManager({
      onObject: (_peerId, object) => receivedObjects.push(object),
      onEvent: (_peerId, event) => events.push(event)
    });
    events.length = 0;

    expect(() => (manager as any).handleMyceliumPacket({
      protocol: 'mycelium',
      version: 1,
      id: 'legacy-message',
      type: 'MESSAGE',
      timestamp: '2026-10-06T00:00:00.000Z',
      sender: 'peer-b',
      recipient: 'peer-a',
      payload: { message: { text: 'legacy plaintext' } },
      signature: 'signature'
    })).not.toThrow();

    expect(receivedObjects).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rejects object packet sends when the channel is not open or send throws', async () => {
    const manager = createManager();
    const peerConnection = FakePeerConnection.instances[0];
    const objectPacket = { type: 'OBJECT_STORE' } as ObjectPacket;

    await expect(async () => manager.sendObjectPacket(objectPacket)).rejects.toThrow('Object packet send failed');

    await manager.createOffer('peer-b', fakeSocket());
    await manager.handleSignal(signal('answer'), fakeSocket());
    const channel = peerConnection.lastDataChannel!;
    channel.readyState = 'open';
    channel.onopen?.();
    channel.send.mockImplementationOnce(() => {
      throw new Error('channel failure');
    });

    expect(() => manager.sendObjectPacket(objectPacket)).toThrow('Object packet send failed');
  });

  it('keeps an answerer waiting for ondatachannel after signalling returns to stable', async () => {
    const manager = createManager();
    const peerConnection = FakePeerConnection.instances[0];

    await manager.handleSignal(signal('offer'), fakeSocket());
    expect(peerConnection.signalingState).toBe('stable');
    expect(manager.isNegotiating()).toBe(true);

    await manager.createOffer('peer-b', fakeSocket());
    expect(FakePeerConnection.createDataChannelCalls).toBe(0);
  });

  it('ignores an answer received after the connection is stable', async () => {
    const manager = createManager();
    const peerConnection = FakePeerConnection.instances[0];

    await expect(manager.handleSignal(signal('answer'), fakeSocket())).resolves.toBeUndefined();
    expect(peerConnection.remoteDescription).toBeNull();
  });

  it.each([
    ['new', 'new', 'stable'],
    ['connecting', 'connecting', 'stable'],
    ['answerer with remote offer', 'new', 'have-remote-offer']
  ] as const)('does not mark %s manager for replacement while it is active or negotiating', async (_name, connectionState, signalingState) => {
    const manager = createManager();
    const peerConnection = FakePeerConnection.instances[0];
    peerConnection.connectionState = connectionState;
    peerConnection.signalingState = signalingState;

    expect(manager.needsReplacement()).toBe(false);
    expect(manager.isNegotiating()).toBe(signalingState === 'have-remote-offer' || connectionState === 'connecting');
  });

  it.each(['failed', 'closed'] as const)('marks a %s manager for replacement', (connectionState) => {
    const manager = createManager();
    const peerConnection = FakePeerConnection.instances[0];
    peerConnection.connectionState = connectionState;

    expect(manager.needsReplacement()).toBe(true);
  });

  it('serializes concurrent signalling messages for one manager', async () => {
    const manager = createManager();

    await Promise.all([
      manager.handleSignal(signal('offer', 'peer-b'), fakeSocket()),
      manager.handleSignal(signal('offer', 'peer-c'), fakeSocket())
    ]);

    expect(FakePeerConnection.maxActiveRemoteDescriptionCalls).toBe(1);
  });

  it('closes a manager before removing it from the registry', () => {
    const manager = createManager();
    const managers = { 'peer-b': manager };
    const connection = FakePeerConnection.instances[0];

    expect(closeAndRemovePeerManager(managers, 'peer-b', manager)).toBe(true);
    expect(connection.connectionState).toBe('closed');
    expect(managers['peer-b']).toBeUndefined();
  });
});
