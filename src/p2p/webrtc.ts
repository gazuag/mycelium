import type { PeerSignalMessage, SignalMessage } from './signalling';
import type { ConnectionState, PeerMetadata } from '../types';
import { buildPacket, createPacketId, isMyceliumPacket, type PacketSigner } from './protocol';
import type { DistributedObject, ObjectPacket } from '../object-layer/types';

const TURN_URL = import.meta.env.VITE_TURN_URL || 'turn:openrelay.metered.ca:80';
const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || 'openrelayproject';
const TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL || 'openrelayproject';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: [TURN_URL, 'turn:openrelay.metered.ca:443?transport=tcp'], username: TURN_USERNAME, credential: TURN_CREDENTIAL }
];
const PING_INTERVAL_MS = 30000;
const OFFER_RECOVERY_TIMEOUT_MS = 10000;
let nextManagerId = 1;
let nextConnectionId = 1;

export class PeerConnectionManager {
  private peerConnection: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private localId: string;
  private remoteId: string | null = null;
  private pendingIceCandidates: Array<{ negotiationId: string; candidate: RTCIceCandidateInit | null }> = [];
  private makingOffer = false;
  private polite = false;
  private onState: (peerId: string, state: ConnectionState) => void;
  private onData: (peerId: string, message: string) => void;
  private onObject: (peerId: string, object: DistributedObject) => void;
  private onMetadata: (peerId: string, metadata: PeerMetadata) => void;
  private onRequestPosts: (peerId: string, since?: string | null, limit?: number) => void;
  private onObjectsBatch: (peerId: string, objects: DistributedObject[]) => void;
  private onSignal: (message: SignalMessage) => void;
  private onOpen: (peerId: string) => void;
  private onClose: (peerId: string) => void;
  private onEvent: (peerId: string, event: string) => void;
  private onProfileRequest: (peerId: string) => void;
  private onMessageAck: (peerId: string, messageId: string) => void;
  private onObjectPacket?: (peerId: string, packet: ObjectPacket) => void;
  private packetSigner?: PacketSigner;
  private helloSent = false;
  private remoteSupportsMyp = false;
  private pingIntervalId: number | null = null;
  private pendingMessageAcks = new Map<string, { text: string; sentAt: string }>();
  private capabilities: string[];
  private softwareVersion: string;
  private readonly managerId = `manager-${nextManagerId++}`;
  private localConnectionId = '';
  private activeNegotiationId: string | null = null;
  private connectionCreatedAt = 0;
  private connectionEstablishedAt = 0;
  private isOfferer = false;
  private signalProcessing: Promise<void> = Promise.resolve();
  private destroyed = false;
  private awaitingIncomingChannel = false;
  private offerRecoveryTimerId: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(
    localId: string,
    onState: (peerId: string, state: ConnectionState) => void,
    onData: (peerId: string, message: string) => void,
    onSignal: (message: SignalMessage) => void,
    onObject: (peerId: string, object: DistributedObject) => void,
    onMetadata: (peerId: string, metadata: PeerMetadata) => void,
    onRequestPosts: (peerId: string, since?: string | null, limit?: number) => void,
    onObjectsBatch: (peerId: string, objects: DistributedObject[]) => void,
    onOpen: (peerId: string) => void,
    onClose: (peerId: string) => void,
    onEvent: (peerId: string, event: string) => void,
    onProfileRequest: (peerId: string) => void,
    onMessageAck: (peerId: string, messageId: string) => void,
    packetSigner?: PacketSigner,
    capabilities: string[] = ['profiles', 'posts', 'messages', 'relay-v1'],
    softwareVersion = 'mycelium-web/0.1',
    onObjectPacket?: (peerId: string, packet: ObjectPacket) => void
  ) {
    this.localId = localId;
    this.onState = onState;
    this.onData = onData;
    this.onObject = onObject;
    this.onMetadata = onMetadata;
    this.onRequestPosts = onRequestPosts;
    this.onObjectsBatch = onObjectsBatch;
    this.onSignal = onSignal;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onEvent = onEvent;
    this.onProfileRequest = onProfileRequest;
    this.onMessageAck = onMessageAck;
    this.packetSigner = packetSigner;
    this.onObjectPacket = onObjectPacket;
    this.capabilities = capabilities;
    this.softwareVersion = softwareVersion;
    this.peerConnection = this.createConnection();
  }

  private createConnection() {
    this.localConnectionId = `connection-${nextConnectionId++}`;
    this.connectionCreatedAt = Date.now();
    this.connectionEstablishedAt = 0;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.onEvent('<unknown>', `${this.connectionLabel()} RTCPeerConnection created iceServers=${ICE_SERVERS.map((server) => server.urls).join(',')}`);

    pc.onicecandidate = (event) => {
      const peerId = this.remoteId ?? '<unknown>';
      const negotiationId = this.activeNegotiationId ?? '<none>';
      if (event.candidate) {
        const candidateType = getCandidateType(event.candidate.candidate);
        const info = describeCandidate(event.candidate.candidate, event.candidate);
        this.onEvent(peerId, `${this.connectionLabel()} Local ICE candidate ready connectionId=${this.localConnectionId} negotiationId=${negotiationId} type=${candidateType} protocol=${event.candidate.protocol ?? 'unknown'} address=${event.candidate.address ?? '<hidden>'} port=${event.candidate.port ?? '<unknown>'} ${info} elapsed=${this.connectionElapsed()}`);
      } else {
        this.onEvent(peerId, `${this.connectionLabel()} Local ICE candidate gathering complete connectionId=${this.localConnectionId} negotiationId=${negotiationId} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} elapsed=${this.connectionElapsed()}`);
      }
      if (event.candidate && this.remoteId) {
        this.onEvent(peerId, `${this.connectionLabel()} sending local ICE candidate via signalling connectionId=${this.localConnectionId} negotiationId=${negotiationId} ${describeCandidate(event.candidate.candidate, event.candidate)}`);
        this.onSignal({
          type: 'ice-candidate',
          from: this.localId,
          to: this.remoteId,
          payload: { negotiationId, candidate: event.candidate.toJSON() }
        });
      } else if (!event.candidate && this.remoteId) {
        this.onEvent(peerId, `${this.connectionLabel()} sending end-of-candidates marker via signalling connectionId=${this.localConnectionId} negotiationId=${negotiationId}`);
        this.onSignal({
          type: 'ice-candidate',
          from: this.localId,
          to: this.remoteId,
          payload: { negotiationId, candidate: null }
        });
      }
    };

    pc.onicecandidateerror = (event) => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `${this.connectionLabel()} ICE candidate error connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} url=${event.url ?? '<unknown>'} code=${event.errorCode} text=${event.errorText || '<none>'} elapsed=${this.connectionElapsed()}`);
    };

    pc.oniceconnectionstatechange = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `${this.connectionLabel()} ICE connection state changed connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(pc)} elapsed=${this.connectionElapsed()}`);
      if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        void this.logCandidatePairs(pc, peerId, pc.iceConnectionState);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `${this.connectionLabel()} PeerConnection state changed connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${state} signaling=${pc.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(pc)} elapsed=${this.connectionElapsed()}`);
      if (state === 'connected') {
        if (!this.connectionEstablishedAt) this.connectionEstablishedAt = Date.now();
        void this.logCandidatePairs(pc, peerId, pc.iceConnectionState);
        this.onState(peerId, 'connected');
      } else if (state === 'connecting') {
        this.onState(peerId, 'connecting');
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.onState(peerId, 'disconnected');
        if (state === 'failed' || state === 'closed') {
          // ICE rarely recovers from 'failed'; tear down so the next attempt builds a fresh RTCPeerConnection.
          this.stopPingLoop();
          this.helloSent = false;
          if (this.remoteId) {
            this.onClose(this.remoteId);
          }
        }
      }
    };

    pc.onsignalingstatechange = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `${this.connectionLabel()} Signaling state changed connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(pc)}`);
    };

    pc.onicegatheringstatechange = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `${this.connectionLabel()} ICE gathering state changed connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(pc)} elapsed=${this.connectionElapsed()}`);
    };

    pc.ondatachannel = (event) => {
      this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} ondatachannel connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} label=${event.channel.label} id=${event.channel.id ?? '<unknown>'} readyState=${event.channel.readyState} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState}`);
      if (this.isOfferer && this.dataChannel && this.dataChannel !== event.channel) {
        this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} ignoring duplicate data channel connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} label=${event.channel.label} id=${event.channel.id ?? '<unknown>'}`);
        event.channel.close();
        return;
      }
      if (this.dataChannel && this.dataChannel !== event.channel) {
        this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} replacing previous data channel with incoming channel connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} oldLabel=${this.dataChannel.label} oldId=${this.dataChannel.id ?? '<unknown>'} newLabel=${event.channel.label} newId=${event.channel.id ?? '<unknown>'}`);
        this.dataChannel.close();
      }
      this.awaitingIncomingChannel = false;
      this.attachDataChannel(event.channel);
    };

    return pc;
  }

  private async logCandidatePairs(pc: RTCPeerConnection, peerId: string, iceState: RTCIceConnectionState) {
    try {
      const stats = await pc.getStats();
      const pairs: CandidatePairStats[] = [];
      const candidates = new Map<string, CandidateStats>();
      stats.forEach((report) => {
        if (report.type === 'candidate-pair') {
          pairs.push({ ...report, ...(report as CandidatePairStats) } as CandidatePairStats);
        }
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates.set(report.id, report as CandidateStats);
        }
      });
      if (pairs.length === 0) {
        this.onEvent(peerId, `${this.connectionLabel()} ICE stats snapshot state=${iceState} candidatePairs=0 connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(pc)} selectedPairUnavailable=true`);
        return;
      }
      this.onEvent(peerId, `${this.connectionLabel()} ICE stats snapshot state=${iceState} candidatePairs=${pairs.length} connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(pc)}`);
      for (const pair of pairs) {
        const local = candidates.get(pair.localCandidateId);
        const remote = candidates.get(pair.remoteCandidateId);
        const selected = pair.selected === true || (pair.state === 'succeeded' && pair.nominated === true);
        const rtt = pair.currentRoundTripTime === undefined && pair.totalRoundTripTime === undefined
          ? ''
          : ` rtt=${pair.currentRoundTripTime === undefined ? '?' : `${pair.currentRoundTripTime}s`} totalRtt=${pair.totalRoundTripTime === undefined ? '?' : `${pair.totalRoundTripTime}s`}`;
        const requestCounts = ` requestsSent=${pair.requestsSent ?? '?'} requestsReceived=${pair.requestsReceived ?? '?'} responsesSent=${pair.responsesSent ?? '?'} responsesReceived=${pair.responsesReceived ?? '?'}`;
        const priority = ` priority=${pair.priority ?? '?'}`;
        this.onEvent(peerId, `${this.connectionLabel()} ICE stats state=${iceState} ${selected ? 'selected ' : ''}candidate pair id=${pair.id ?? '<unknown>'} state=${pair.state} nominated=${pair.nominated === true} selected=${selected}${priority} localCandidateId=${pair.localCandidateId} remoteCandidateId=${pair.remoteCandidateId} local=${formatCandidate(local)} remote=${formatCandidate(remote)}${rtt}${requestCounts}${formatPairError(pair)} connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${pc.iceGatheringState} iceConnection=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(pc)}`);
      }
    } catch (error) {
      this.onEvent(peerId, `${this.connectionLabel()} ICE stats unavailable connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private attachDataChannel(channel: RTCDataChannel) {
    const peerId = this.remoteId ?? '<unknown>';
    this.onEvent(peerId, `${this.connectionLabel()} data channel attached label=${channel.label} id=${channel.id ?? '<unknown>'}`);
    this.dataChannel = channel;
    this.dataChannel.onopen = () => {
      if (this.dataChannel !== channel) {
        this.onEvent(peerId, `${this.connectionLabel()} ignoring stale data channel open label=${channel.label} id=${channel.id ?? '<unknown>'}`);
        channel.close();
        return;
      }
      this.onEvent(peerId, `${this.connectionLabel()} Data channel opened label=${channel.label} id=${channel.id ?? '<unknown>'}`);
      this.clearOfferRecoveryTimer();
      this.onState(peerId, 'connected');
      this.sendHello();
      void this.sendPacket('PROFILE_REQUEST', {});
      this.startPingLoop();
      this.onOpen(peerId);
    };
    this.dataChannel.onclose = () => {
      if (this.dataChannel !== channel) {
        this.onEvent(peerId, `${this.connectionLabel()} ignoring stale data channel close label=${channel.label} id=${channel.id ?? '<unknown>'}`);
        return;
      }
      this.onEvent(peerId, `${this.connectionLabel()} Data channel closed label=${channel.label} id=${channel.id ?? '<unknown>'}`);
      this.stopPingLoop();
      this.onState(peerId, 'disconnected');
      this.onClose(peerId);
    };
    this.dataChannel.onmessage = (event) => {
      if (this.dataChannel !== channel) return;
      const data = event.data;
      const peerId = this.remoteId ?? '<unknown>';
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (isMyceliumPacket(parsed)) {
            this.remoteSupportsMyp = true;
            this.handleMyceliumPacket(parsed);
            return;
          }
          if (parsed?.type === 'chat' && typeof parsed.text === 'string') {
            if (typeof parsed.id === 'string') {
              this.sendData({ type: 'chat-ack', messageId: parsed.id });
            }
            this.onData(peerId, parsed.text);
            return;
          }
          if (parsed?.type === 'chat-ack' && typeof parsed.messageId === 'string') {
            this.onMessageAck(peerId, parsed.messageId);
            return;
          }
          if (parsed?.type === 'metadata' && parsed.metadata) {
            this.onMetadata(peerId, parsed.metadata);
            return;
          }
        } catch {
          // Fall back to raw text if parsing fails
        }
      }
      this.onData(peerId, String(data));
    };
  }

  private handleMyceliumPacket(packet: any) {
    const peerId = this.remoteId ?? packet.sender ?? '<unknown>';
    switch (packet.type) {
      case 'OBJECT_STORE': {
        const object = packet.payload?.object;
        if (object && typeof object === 'object' && !Array.isArray(object)) {
          this.onObject(peerId, object as DistributedObject);
        }
        return;
      }
      case 'OBJECT_BATCH': {
        const objects = packet.payload?.objects;
        if (Array.isArray(objects)) {
          this.onObjectsBatch(peerId, objects as DistributedObject[]);
        }
        return;
      }
      case 'FIND':
      case 'FIND_RESPONSE': {
        this.onObjectPacket?.(peerId, packet as ObjectPacket);
        return;
      }
      case 'HELLO': {
        const nickname = typeof packet.payload?.nickname === 'string' ? packet.payload.nickname : peerId;
        const supported = Array.isArray(packet.payload?.capabilities) ? packet.payload.capabilities.join(', ') : 'none';
        this.onEvent(peerId, `HELLO received from ${nickname} capabilities=[${supported}]`);
        return;
      }
      case 'PING': {
        void this.sendPacket('PONG', {
          pingId: packet.payload?.pingId ?? packet.id,
          sentAt: packet.payload?.sentAt ?? packet.timestamp
        });
        return;
      }
      case 'PONG': {
        this.onEvent(peerId, `${this.connectionLabel()} PONG received for ping ${String(packet.payload?.pingId ?? 'unknown')}`);
        return;
      }
      case 'MESSAGE': {
        const messageObj = packet.payload?.message as { id?: string; ciphertext?: string; text?: string } | undefined;
        const text = typeof messageObj?.text === 'string'
          ? messageObj.text
          : typeof messageObj?.ciphertext === 'string'
            ? messageObj.ciphertext
            : '';

        if (text) {
          this.onData(peerId, text);
        }

        void this.sendPacket('MESSAGE_ACK', {
          messageId: messageObj?.id ?? packet.id,
          deliveredAt: new Date().toISOString()
        });
        return;
      }
      case 'MESSAGE_ACK': {
        const messageId = typeof packet.payload?.messageId === 'string' ? packet.payload.messageId : null;
        if (messageId && this.pendingMessageAcks.has(messageId)) {
          this.pendingMessageAcks.delete(messageId);
          this.onEvent(peerId, `Message ${messageId} acknowledged`);
          this.onMessageAck(peerId, messageId);
        }
        return;
      }
      case 'PROFILE_REQUEST': {
        this.onProfileRequest(peerId);
        return;
      }
      case 'PROFILE_RESPONSE':
      case 'PROFILE_UPDATE': {
        const metadata = packet.payload?.profile ?? packet.payload?.metadata;
        if (metadata && typeof metadata === 'object') {
          this.onMetadata(peerId, metadata as PeerMetadata);
        }
        return;
      }
      case 'POST_REQUEST': {
        this.onRequestPosts(
          peerId,
          typeof packet.payload?.since === 'string' ? packet.payload.since : null,
          Number(packet.payload?.limit ?? 100)
        );
        return;
      }
      case 'GOODBYE': {
        this.onEvent(peerId, 'GOODBYE received');
        return;
      }
      default: {
        this.onEvent(peerId, `Unknown packet type ${String(packet.type)}`);
      }
    }
  }

  private sendData(payload: unknown) {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(payload));
    }
  }

  public isDataChannelOpen() {
    return this.dataChannel?.readyState === 'open';
  }

  public getDataChannelState() {
    return this.dataChannel?.readyState ?? 'missing';
  }

  public getConnectionId() {
    return this.localConnectionId;
  }

  public getActiveNegotiationId() {
    return this.activeNegotiationId;
  }

  public isNegotiating() {
    return this.makingOffer
      || this.peerConnection.signalingState === 'have-local-offer'
      || this.peerConnection.signalingState === 'have-remote-offer'
      || this.peerConnection.connectionState === 'connecting'
      || this.peerConnection.iceConnectionState === 'checking'
      || this.awaitingIncomingChannel;
  }

  public needsReplacement() {
    return this.destroyed
      || this.peerConnection.connectionState === 'failed'
      || this.peerConnection.connectionState === 'closed'
      || this.peerConnection.iceConnectionState === 'failed'
      || this.peerConnection.iceConnectionState === 'closed';
  }

  private async sendPacket(type: Parameters<typeof buildPacket>[2], payload: Record<string, unknown>) {
    if (!this.remoteId) return;
    const packet = await buildPacket(this.localId, this.remoteId, type, payload, this.packetSigner);
    this.sendData(packet);
  }

  public sendObjectPacket(packet: ObjectPacket) {
    this.sendData(packet);
  }

  private sendLegacyPayload(type: string, payload: Record<string, unknown>) {
    this.sendData({ type, ...payload });
  }

  private sendHello() {
    if (this.helloSent) return;
    this.helloSent = true;
    void this.sendPacket('HELLO', {
      nodeId: this.localId,
      nickname: this.localId.slice(0, 12),
      softwareVersion: this.softwareVersion,
      protocolVersion: 1,
      capabilities: this.capabilities
    });
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingIntervalId = window.setInterval(() => {
      const pingId = createPacketId();
      this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} sending PING ${pingId}`);
      void this.sendPacket('PING', {
        pingId,
        sentAt: new Date().toISOString()
      });
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop() {
    if (this.pingIntervalId !== null) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
  }

  public sendChatMessage(text: string) {
    if (this.remoteSupportsMyp) {
      const messageId = createPacketId();
      this.pendingMessageAcks.set(messageId, {
        text,
        sentAt: new Date().toISOString()
      });
      void this.sendPacket('MESSAGE', {
        message: {
          id: messageId,
          from: this.localId,
          to: this.remoteId,
          created: new Date().toISOString(),
          ciphertext: text,
          text,
          signature: 'unsigned-v1'
        }
      });
      return messageId;
    }

    const messageId = createPacketId();
    this.pendingMessageAcks.set(messageId, {
      text,
      sentAt: new Date().toISOString()
    });
    this.sendData({ type: 'chat', id: messageId, text });
    return messageId;
  }

  public sendObject(object: DistributedObject) {
    void this.sendPacket('OBJECT_STORE', { object });
  }

  public sendMetadata(metadata: PeerMetadata) {
    if (this.remoteSupportsMyp) {
      void this.sendPacket('PROFILE_UPDATE', { profile: metadata });
      return;
    }
    this.sendLegacyPayload('metadata', { metadata });
  }

  public requestProfile() {
    if (!this.remoteId) return;
    void this.sendPacket('PROFILE_REQUEST', {});
  }

  public sendRequestPosts(since: string | null = null, limit = 100) {
    void this.sendPacket('POST_REQUEST', { since, limit });
  }

  public sendObjectsBatch(objects: DistributedObject[]) {
    void this.sendPacket('OBJECT_BATCH', { objects });
  }

  public async createOffer(remoteId: string, signallingSocket: WebSocket) {
    this.onEvent(remoteId, `${this.connectionLabel()} createOffer called state=${this.peerConnection.connectionState} signaling=${this.peerConnection.signalingState} channel=${this.dataChannel?.label ?? '<none>'}:${this.dataChannel?.id ?? '<none>'}`);
    this.onEvent(remoteId, `${this.connectionLabel()} offer/reconnect inspection replacing=${this.needsReplacement()} negotiating=${this.isNegotiating()} ice=${this.peerConnection.iceConnectionState}`);
    this.remoteId = remoteId;
    if (this.destroyed) {
      this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: manager is destroyed`);
      return;
    }
    if (this.peerConnection.connectionState === 'connected') {
      this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: connectionState=connected and renegotiation is not required`);
      return;
    }
    if (this.dataChannel?.readyState === 'open') {
      this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: primary data channel already exists`);
      return;
    }
    if (this.dataChannel && this.peerConnection.signalingState === 'stable') {
      this.onEvent(remoteId, `${this.connectionLabel()} discarding stale data channel state=${this.dataChannel.readyState} before recovery`);
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.makingOffer) {
      this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: makingOffer=true`);
      return;
    }
      if (this.awaitingIncomingChannel) {
        this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: waiting for the answerer's incoming data channel`);
        return;
      } else if (this.peerConnection.signalingState === 'have-local-offer') {
      this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: signalingState=have-local-offer; an answer is outstanding`);
      return;
    }
    if (this.peerConnection.connectionState === 'connecting') {
      this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: connectionState=connecting`);
      return;
    }
    if (this.peerConnection.signalingState !== 'stable') {
      this.onEvent(remoteId, `${this.connectionLabel()} createOffer skipped: signalingState=${this.peerConnection.signalingState}`);
      return;
    }
    this.isOfferer = true;
    this.activeNegotiationId = createPacketId();
    this.polite = this.localId > remoteId;
    this.makingOffer = true;
    try {
      this.onState(remoteId, 'signalling');
      this.onEvent(remoteId, `Creating offer for ${remoteId}`);
      this.onEvent(remoteId, `${this.connectionLabel()} createDataChannel label=chat`);
      const channel = this.peerConnection.createDataChannel('chat');
      this.attachDataChannel(channel);

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.startOfferRecoveryTimer(remoteId);
      this.onEvent(remoteId, `Sending offer to ${remoteId}`);

      this.sendSignal(signallingSocket, {
        type: 'offer',
        from: this.localId,
        to: remoteId,
        payload: { ...offer, negotiationId: this.activeNegotiationId }
      });
    } finally {
      this.makingOffer = false;
    }
  }

  private async addIceCandidate(candidate: RTCIceCandidateInit | null, negotiationId: string) {
    const details = parseCandidate(candidate?.candidate ?? '');
    const peerId = this.remoteId ?? '<unknown>';
    const candidateSummary = describeCandidate(candidate?.candidate ?? '', candidate ?? undefined);
    this.onEvent(peerId, `${this.connectionLabel()} Remote ICE candidate received connectionId=${this.localConnectionId} negotiationId=${negotiationId} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} candidate=${candidateSummary} remoteDescriptionPresent=${Boolean(this.peerConnection.remoteDescription)} iceGathering=${this.peerConnection.iceGatheringState} iceConnection=${this.peerConnection.iceConnectionState} connection=${this.peerConnection.connectionState} signaling=${this.peerConnection.signalingState}`);
    if (this.peerConnection.remoteDescription) {
      try {
        await this.peerConnection.addIceCandidate(candidate);
        this.onEvent(peerId, `${this.connectionLabel()} ICE addIceCandidate succeeded connectionId=${this.localConnectionId} negotiationId=${negotiationId} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} candidate=${candidateSummary} queued=false`);
      } catch (error) {
        this.onEvent(peerId, `${this.connectionLabel()} ICE addIceCandidate failed connectionId=${this.localConnectionId} negotiationId=${negotiationId} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} candidate=${candidateSummary} queued=false error=${formatError(error)}`);
        throw error;
      }
    } else {
      this.pendingIceCandidates.push({ negotiationId, candidate });
      this.onEvent(peerId, `${this.connectionLabel()} ICE addIceCandidate queued connectionId=${this.localConnectionId} negotiationId=${negotiationId} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} candidate=${candidateSummary} queued=true reason=remote-description-pending pendingCount=${this.pendingIceCandidates.length}`);
    }
  }

  private async flushPendingIceCandidates() {
    const pending = this.pendingIceCandidates.filter((entry) => entry.negotiationId === this.activeNegotiationId);
    this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} flushing pending ICE candidates connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} matched=${pending.length} totalQueued=${this.pendingIceCandidates.length} remoteDescriptionPresent=${Boolean(this.peerConnection.remoteDescription)} signaling=${this.peerConnection.signalingState}`);
    this.pendingIceCandidates = [];
    for (const entry of pending) {
      const candidate = entry.candidate;
      const details = parseCandidate(candidate?.candidate ?? '');
      const peerId = this.remoteId ?? '<unknown>';
      const candidateSummary = describeCandidate(candidate?.candidate ?? '', candidate ?? undefined);
      try {
        await this.peerConnection.addIceCandidate(candidate);
        this.onEvent(peerId, `${this.connectionLabel()} ICE addIceCandidate succeeded connectionId=${this.localConnectionId} negotiationId=${entry.negotiationId} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} candidate=${candidateSummary} queued=true`);
      } catch (error) {
        this.onEvent(peerId, `${this.connectionLabel()} ICE addIceCandidate failed connectionId=${this.localConnectionId} negotiationId=${entry.negotiationId} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} candidate=${candidateSummary} queued=true error=${formatError(error)}`);
        throw error;
      }
    }
  }

  public handleSignal(message: PeerSignalMessage, signallingSocket: WebSocket) {
    const queued = this.signalProcessing.then(() => this.processSignal(message, signallingSocket));
    this.signalProcessing = queued.catch(() => undefined);
    return queued;
  }

  private async processSignal(message: PeerSignalMessage, signallingSocket: WebSocket) {
    if (message.to !== this.localId) return;
    if (this.destroyed) {
      this.onEvent(message.from, `${this.connectionLabel()} ignored signal: manager is destroyed`);
      return;
    }

    this.remoteId = message.from;
    this.polite = this.localId > message.from;
    const receivedNegotiationId = typeof message.payload?.negotiationId === 'string' ? message.payload.negotiationId : null;
    this.onEvent(message.from, `${this.connectionLabel()} signalling received type=${message.type} localConnectionId=${this.localConnectionId} negotiationId=${receivedNegotiationId ?? '<missing>'} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} signaling=${this.peerConnection.signalingState} ice=${this.peerConnection.iceConnectionState} connection=${this.peerConnection.connectionState}`);
    if (!receivedNegotiationId) {
      this.onEvent(message.from, `${this.connectionLabel()} signalling ignored: missing negotiationId type=${message.type}`);
      return;
    }
    // Only transition to 'signalling' when not already connected; ICE candidates arrive continuously
    if (this.peerConnection.connectionState !== 'connected') {
      this.onState(message.from, 'signalling');
    }

    if (message.type === 'offer') {
      const offerCollision = this.makingOffer || this.peerConnection.signalingState !== 'stable';
      if (offerCollision) {
        if (!this.polite) {
          this.onEvent(message.from, `${this.connectionLabel()} glare collision: impolite peer ignored offer negotiationId=${receivedNegotiationId} active=${this.activeNegotiationId ?? '<none>'}`);
          return;
        }
        // Polite peer yields: roll back our own in-flight offer so we can accept theirs instead.
        this.onEvent(message.from, `${this.connectionLabel()} glare collision: polite peer rolling back local negotiationId=${this.activeNegotiationId ?? '<none>'} to accept remote negotiationId=${receivedNegotiationId}`);
        await this.peerConnection.setLocalDescription({ type: 'rollback' });
        if (this.dataChannel) {
          this.onEvent(message.from, `${this.connectionLabel()} closing locally-created channel after yielding offer collision`);
          this.dataChannel.close();
          this.dataChannel = null;
        }
      }

      this.onEvent(message.from, `Received offer from ${message.from} connectionId=${this.localConnectionId} negotiationId=${receivedNegotiationId}`);
      this.activeNegotiationId = receivedNegotiationId;
      this.isOfferer = false;
      this.awaitingIncomingChannel = true;
      await this.peerConnection.setRemoteDescription(stripNegotiationId(message.payload) as unknown as RTCSessionDescriptionInit);
      await this.flushPendingIceCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      this.onEvent(message.from, `Sending answer to ${message.from} connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'}`);
      this.sendSignal(signallingSocket, {
        type: 'answer',
        from: this.localId,
        to: message.from,
        payload: { ...answer, negotiationId: this.activeNegotiationId }
      });
    } else if (message.type === 'answer') {
      if (receivedNegotiationId !== this.activeNegotiationId) {
        this.onEvent(message.from, `${this.connectionLabel()} signalling ignored stale answer negotiationId=${receivedNegotiationId} active=${this.activeNegotiationId ?? '<none>'}`);
        return;
      }
      if (this.peerConnection.signalingState !== 'have-local-offer') {
        this.onEvent(message.from, `${this.connectionLabel()} ignoring stale answer in signalingState=${this.peerConnection.signalingState}`);
        return;
      }
      this.onEvent(message.from, `Received answer from ${message.from} connectionId=${this.localConnectionId} negotiationId=${receivedNegotiationId}`);
      try {
        await this.peerConnection.setRemoteDescription(stripNegotiationId(message.payload) as unknown as RTCSessionDescriptionInit);
        await this.flushPendingIceCandidates();
        this.clearOfferRecoveryTimer();
      } catch (error) {
        this.onEvent(message.from, `${this.connectionLabel()} failed to apply answer: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (message.type === 'ice-candidate') {
      if (receivedNegotiationId !== this.activeNegotiationId) {
        this.onEvent(message.from, `${this.connectionLabel()} signalling ignored stale ICE negotiationId=${receivedNegotiationId} active=${this.activeNegotiationId ?? '<none>'} candidate=${describeCandidate(message.payload?.candidate === null ? '' : String((message.payload as { candidate?: RTCIceCandidateInit | null })?.candidate?.candidate ?? ''))}`);
        return;
      }
      const candidate = message.payload?.candidate === null ? null : message.payload?.candidate as RTCIceCandidateInit;
      const candidateSummary = describeCandidate(candidate?.candidate ?? '', candidate ?? undefined);
      this.onEvent(message.from, `${this.connectionLabel()} Received ICE candidate from ${message.from} connectionId=${this.localConnectionId} negotiationId=${receivedNegotiationId} activeNegotiationId=${this.activeNegotiationId ?? '<none>'} candidate=${candidateSummary} remoteDescriptionPresent=${Boolean(this.peerConnection.remoteDescription)} signaling=${this.peerConnection.signalingState}`);
      await this.addIceCandidate(candidate, receivedNegotiationId);
    }
  }

  private sendSignal(socket: WebSocket, message: SignalMessage) {
    socket.send(JSON.stringify(message));
  }

  public sendMessage(text: string) {
    this.sendChatMessage(text);
  }

  public closeConnection() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} closeConnection called connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} iceGathering=${this.peerConnection.iceGatheringState} iceConnection=${this.peerConnection.iceConnectionState} connection=${this.peerConnection.connectionState} signaling=${this.peerConnection.signalingState} dataChannel=${this.dataChannel?.readyState ?? 'none'} ${describeSctp(this.peerConnection)}`);
    const channel = this.dataChannel;
    this.dataChannel = null;
    if (channel && channel.readyState !== 'closed') {
      this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} closing data channel in closeConnection connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} label=${channel.label} id=${channel.id ?? '<unknown>'}`);
      channel.close();
    }
    if (this.peerConnection && this.peerConnection.connectionState !== 'closed') {
      this.onEvent(this.remoteId ?? '<unknown>', `${this.connectionLabel()} closing peer connection in closeConnection connectionId=${this.localConnectionId} negotiationId=${this.activeNegotiationId ?? '<none>'} state=${this.peerConnection.connectionState}`);
      this.peerConnection.close();
    }
    this.stopPingLoop();
    this.clearOfferRecoveryTimer();
    this.pendingIceCandidates = [];
    this.activeNegotiationId = null;
  }

  private startOfferRecoveryTimer(peerId: string) {
    this.clearOfferRecoveryTimer();
    this.offerRecoveryTimerId = globalThis.setTimeout(() => {
      this.offerRecoveryTimerId = null;
      if (this.destroyed || this.dataChannel?.readyState === 'open' || this.peerConnection.signalingState !== 'have-local-offer') return;
      this.onEvent(peerId, `${this.connectionLabel()} abandoning stale local offer and connecting data channel after ${OFFER_RECOVERY_TIMEOUT_MS}ms`);
      void this.peerConnection.setLocalDescription({ type: 'rollback' }).then(() => {
        if (this.dataChannel) {
          this.dataChannel.close();
          this.dataChannel = null;
        }
      }).catch((error) => {
        this.onEvent(peerId, `${this.connectionLabel()} failed to roll back stale local offer: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, OFFER_RECOVERY_TIMEOUT_MS);
  }

  private clearOfferRecoveryTimer() {
    if (this.offerRecoveryTimerId !== null) {
      globalThis.clearTimeout(this.offerRecoveryTimerId);
      this.offerRecoveryTimerId = null;
    }
  }

  private connectionLabel() {
    return `${this.managerId}/${this.localConnectionId}`;
  }

  private connectionElapsed() {
    const start = this.connectionEstablishedAt || this.connectionCreatedAt;
    return `${Date.now() - start}ms`;
  }
}

type CandidatePairStats = {
  id?: string;
  localCandidateId: string;
  remoteCandidateId: string;
  state: string;
  priority?: number;
  protocol?: string;
  nominated?: boolean;
  selected?: boolean;
  currentRoundTripTime?: number;
  totalRoundTripTime?: number;
  requestsSent?: number;
  requestsReceived?: number;
  responsesSent?: number;
  responsesReceived?: number;
  bytesSent?: number;
  bytesReceived?: number;
  lastPacketSentTimestamp?: number;
  lastPacketReceivedTimestamp?: number;
  error?: string;
  errorCode?: number;
};

type CandidateStats = {
  foundation?: string;
  candidateType?: string;
  protocol?: string;
  address?: string;
  ip?: string;
  port?: number;
  relatedAddress?: string;
  relatedPort?: number;
};

function getCandidateType(candidate: string) {
  return parseCandidate(candidate).type;
}

function parseCandidate(candidate: string) {
  const parts = candidate.trim().split(/\s+/);
  const typeIndex = parts.indexOf('typ');
  const address = parts[4] ?? '<unknown>';
  const port = parts[5] ?? '<unknown>';
  return {
    type: typeIndex >= 0 ? parts[typeIndex + 1] ?? 'unknown' : 'unknown',
    protocol: parts[2]?.toLowerCase() ?? 'unknown',
    address,
    port
  };
}

function formatCandidate(candidate: CandidateStats | undefined) {
  const address = candidate?.address ?? candidate?.ip ?? '<unknown>';
  const port = candidate?.port === undefined ? '<unknown>' : String(candidate.port);
  const related = candidate?.relatedAddress === undefined && candidate?.relatedPort === undefined
    ? ''
    : ` related=${candidate.relatedAddress ?? '<unknown>'}:${candidate.relatedPort ?? '<unknown>'}`;
  return `${candidate?.candidateType ?? 'unknown'}:${candidate?.protocol ?? 'unknown'}@${address}:${port} foundation=${candidate?.foundation ?? 'unknown'}${related}`;
}

function describeCandidate(candidateLine: string, candidate?: RTCIceCandidateInit | CandidateStats) {
  if (!candidateLine) {
    return 'candidate=<end-of-candidates>';
  }
  const parsed = parseCandidate(candidateLine);
  if (typeof candidate === 'object' && 'candidate' in candidate && typeof candidate.candidate === 'string') {
    return `candidate=${candidate.candidate} type=${parsed.type} protocol=${parsed.protocol} address=${parsed.address} port=${parsed.port}`;
  }
  if (typeof candidate === 'object' && 'address' in candidate && 'port' in candidate) {
    const stats = candidate as CandidateStats & { candidate?: string };
    return `candidate=${stats.candidate ?? '<unknown>'} type=${stats.candidateType ?? parsed.type} protocol=${stats.protocol ?? parsed.protocol} address=${stats.address ?? parsed.address} port=${stats.port ?? parsed.port}`;
  }
  return `candidate=${candidateLine} type=${parsed.type} protocol=${parsed.protocol} address=${parsed.address} port=${parsed.port}`;
}

function describeSctp(pc: RTCPeerConnection) {
  const sctp = (pc as RTCPeerConnection & { sctp?: { state?: string; transport?: unknown } }).sctp;
  if (!sctp) return 'sctp=absent';
  return `sctp=state=${sctp.state ?? 'unknown'} transport=${sctp.transport ? 'present' : 'absent'}`;
}

function formatPairError(pair: CandidatePairStats) {
  if (pair.error === undefined && pair.errorCode === undefined) return '';
  return ` error=${pair.error ?? 'unknown'}${pair.errorCode === undefined ? '' : `(${pair.errorCode})`}`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stripNegotiationId(payload: Record<string, unknown>): Record<string, unknown> {
  const { negotiationId: _negotiationId, ...description } = payload;
  return description;
}
