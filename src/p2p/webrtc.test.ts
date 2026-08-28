import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ObjectPacket } from '../object-layer/types';
import type { PeerSignalMessage } from './signalling';
import { PeerConnectionManager } from './webrtc';
import { closeAndRemovePeerManager } from './peer-manager-registry';

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

  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onicecandidateerror: ((event: RTCPeerConnectionIceErrorEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  constructor() {
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
  async getStats() { return new Map(); }
  close() {
    this.connectionState = 'closed';
  }
}

const noop = () => {};
const fakeSocket = () => ({ send: vi.fn() } as unknown as WebSocket);

function createManager() {
  return new PeerConnectionManager(
    'peer-a', noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
    undefined, undefined, undefined, undefined
  );
}

function signal(type: PeerSignalMessage['type'], from = 'peer-b'): PeerSignalMessage {
  return { type, from, to: 'peer-a', payload: { type, sdp: type } } as PeerSignalMessage;
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakePeerConnection.activeRemoteDescriptionCalls = 0;
  FakePeerConnection.maxActiveRemoteDescriptionCalls = 0;
  FakePeerConnection.createDataChannelCalls = 0;
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: FakePeerConnection, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: { setInterval, clearInterval, setTimeout, clearTimeout }, configurable: true });
});

describe('PeerConnectionManager lifecycle', () => {
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
