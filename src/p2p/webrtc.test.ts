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
  async getStats() { return this.stats; }
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
  return { type, from, to: 'peer-a', payload: { type, sdp: type, negotiationId: 'negotiation-test' } } as PeerSignalMessage;
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
  it('logs all checked ICE pairs on failure and the selected pair when connected', async () => {
    const events: string[] = [];
    const manager = new PeerConnectionManager(
      'peer-a', noop, noop, noop, noop, noop, noop, noop, noop, noop, (peerId, event) => events.push(`${peerId} ${event}`), noop, noop,
      undefined, undefined, undefined, undefined
    );
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
    const manager = new PeerConnectionManager(
      'peer-a', noop, noop, noop, noop, noop, noop, noop, noop, noop, (peerId, event) => events.push(`${peerId} ${event}`), noop, noop,
      undefined, undefined, undefined, undefined
    );
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
    const manager = new PeerConnectionManager(
      'peer-a', noop, noop, noop, noop, noop, noop, noop, noop, noop, (peerId, event) => events.push(`${peerId} ${event}`), noop, noop,
      undefined, undefined, undefined, undefined
    );
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
    const offerer = new PeerConnectionManager(
      'peer-a', noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
      undefined, undefined, undefined, undefined
    );
    const answerer = new PeerConnectionManager(
      'peer-b', noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
      undefined, undefined, undefined, undefined
    );
    const socket = fakeSocket() as WebSocket & { send: ReturnType<typeof vi.fn> };
    await offerer.createOffer('peer-b', socket);
    const offer = JSON.parse(socket.send.mock.calls[0][0]) as PeerSignalMessage;
    await answerer.handleSignal({ ...offer, from: 'peer-a', to: 'peer-b' }, socket);

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
    const a = new PeerConnectionManager(
      'peer-a', noop, noop, noop, noop, noop, noop, noop, noop, noop, (peerId, event) => aEvents.push(`${peerId} ${event}`), noop, noop,
      undefined, undefined, undefined, undefined
    );
    const b = new PeerConnectionManager(
      'peer-b', noop, noop, noop, noop, noop, noop, noop, noop, noop, (peerId, event) => bEvents.push(`${peerId} ${event}`), noop, noop,
      undefined, undefined, undefined, undefined
    );
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
