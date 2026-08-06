import type { SignalMessage } from './signalling';
import type { ConnectionState, PeerMetadata, SignedPost } from '../types';
import { buildPacket, createPacketId, isMyceliumPacket, type PacketSigner } from './protocol';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const PING_INTERVAL_MS = 30000;

export class PeerConnectionManager {
  private peerConnection: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private localId: string;
  private remoteId: string | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private polite = false;
  private onState: (peerId: string, state: ConnectionState) => void;
  private onData: (peerId: string, message: string) => void;
  private onPost: (peerId: string, post: SignedPost) => void;
  private onMetadata: (peerId: string, metadata: PeerMetadata) => void;
  private onRequestPosts: (peerId: string) => void;
  private onPostsBatch: (peerId: string, posts: SignedPost[]) => void;
  private onSignal: (message: SignalMessage) => void;
  private onOpen: (peerId: string) => void;
  private onClose: (peerId: string) => void;
  private onEvent: (peerId: string, event: string) => void;
  private packetSigner?: PacketSigner;
  private helloSent = false;
  private remoteSupportsMyp = false;
  private pingIntervalId: number | null = null;
  private pendingMessageAcks = new Map<string, { text: string; sentAt: string }>();
  private capabilities: string[];
  private softwareVersion: string;

  constructor(
    localId: string,
    onState: (peerId: string, state: ConnectionState) => void,
    onData: (peerId: string, message: string) => void,
    onSignal: (message: SignalMessage) => void,
    onPost: (peerId: string, post: SignedPost) => void,
    onMetadata: (peerId: string, metadata: PeerMetadata) => void,
    onRequestPosts: (peerId: string) => void,
    onPostsBatch: (peerId: string, posts: SignedPost[]) => void,
    onOpen: (peerId: string) => void,
    onClose: (peerId: string) => void,
    onEvent: (peerId: string, event: string) => void,
    packetSigner?: PacketSigner,
    capabilities: string[] = ['profiles', 'posts', 'messages', 'relay-v1'],
    softwareVersion = 'mycelium-web/0.1'
  ) {
    this.localId = localId;
    this.onState = onState;
    this.onData = onData;
    this.onPost = onPost;
    this.onMetadata = onMetadata;
    this.onRequestPosts = onRequestPosts;
    this.onPostsBatch = onPostsBatch;
    this.onSignal = onSignal;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onEvent = onEvent;
    this.packetSigner = packetSigner;
    this.capabilities = capabilities;
    this.softwareVersion = softwareVersion;
    this.peerConnection = this.createConnection();
  }

  private createConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (event.candidate && this.remoteId) {
        this.onEvent(this.remoteId, `Local ICE candidate ready for ${this.remoteId}`);
        this.onSignal({
          type: 'ice-candidate',
          from: this.localId,
          to: this.remoteId,
          payload: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `PeerConnection state: ${state}`);
      if (state === 'connected') {
        this.onState(peerId, 'connected');
      } else if (state === 'connecting') {
        this.onState(peerId, 'connecting');
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.onState(peerId, 'disconnected');
      }
    };

    pc.onsignalingstatechange = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `Signaling state: ${pc.signalingState}`);
    };

    pc.onicegatheringstatechange = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, `ICE gathering state: ${pc.iceGatheringState}`);
    };

    pc.ondatachannel = (event) => {
      this.attachDataChannel(event.channel);
    };

    return pc;
  }

  private attachDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    this.dataChannel.onopen = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, 'Data channel opened');
      this.onState(peerId, 'connected');
      this.sendHello();
      this.startPingLoop();
      this.onOpen(peerId);
    };
    this.dataChannel.onclose = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, 'Data channel closed');
      this.stopPingLoop();
      this.onState(peerId, 'disconnected');
      this.onClose(peerId);
    };
    this.dataChannel.onmessage = (event) => {
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
            this.onData(peerId, parsed.text);
            return;
          }
          if (parsed?.type === 'signed-post' && parsed.post) {
            this.onPost(peerId, parsed.post);
            return;
          }
          if (parsed?.type === 'metadata' && parsed.metadata) {
            this.onMetadata(peerId, parsed.metadata);
            return;
          }
          if (parsed?.type === 'request-posts') {
            this.onRequestPosts(peerId);
            return;
          }
          if (parsed?.type === 'posts-batch' && Array.isArray(parsed.posts)) {
            this.onPostsBatch(peerId, parsed.posts);
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
        this.onEvent(peerId, `PONG received for ping ${String(packet.payload?.pingId ?? 'unknown')}`);
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
        }
        return;
      }
      case 'PROFILE_REQUEST': {
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
        this.onRequestPosts(peerId);
        return;
      }
      case 'POST_BATCH': {
        const posts = packet.payload?.posts;
        if (Array.isArray(posts)) {
          this.onPostsBatch(peerId, posts as SignedPost[]);
        }
        return;
      }
      case 'POST': {
        const post = packet.payload?.post;
        if (post) {
          this.onPost(peerId, post as SignedPost);
        }
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

  private async sendPacket(type: Parameters<typeof buildPacket>[2], payload: Record<string, unknown>) {
    if (!this.remoteId) return;
    const packet = await buildPacket(this.localId, this.remoteId, type, payload, this.packetSigner);
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
      void this.sendPacket('PING', {
        pingId: createPacketId(),
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
      return;
    }
    this.sendLegacyPayload('chat', { text });
  }

  public sendSignedPost(post: SignedPost) {
    if (this.remoteSupportsMyp) {
      void this.sendPacket('POST', { post });
      return;
    }
    this.sendLegacyPayload('signed-post', { post });
  }

  public sendMetadata(metadata: PeerMetadata) {
    if (this.remoteSupportsMyp) {
      void this.sendPacket('PROFILE_UPDATE', { profile: metadata });
      return;
    }
    this.sendLegacyPayload('metadata', { metadata });
  }

  public sendRequestPosts() {
    if (this.remoteSupportsMyp) {
      void this.sendPacket('POST_REQUEST', {
        since: null,
        limit: 100
      });
      return;
    }
    this.sendLegacyPayload('request-posts', {});
  }

  public sendPostsBatch(posts: SignedPost[]) {
    if (this.remoteSupportsMyp) {
      void this.sendPacket('POST_BATCH', { posts });
      return;
    }
    this.sendLegacyPayload('posts-batch', { posts });
  }

  public async createOffer(remoteId: string, signallingSocket: WebSocket) {
    this.remoteId = remoteId;
    this.polite = this.localId > remoteId;
    this.makingOffer = true;
    this.onState(remoteId, 'signalling');
    this.onEvent(remoteId, `Creating offer for ${remoteId}`);
    const channel = this.peerConnection.createDataChannel('chat');
    this.attachDataChannel(channel);

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.makingOffer = false;
    this.onEvent(remoteId, `Sending offer to ${remoteId}`);

    this.sendSignal(signallingSocket, {
      type: 'offer',
      from: this.localId,
      to: remoteId,
      payload: offer
    });
  }

  private async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.peerConnection.remoteDescription) {
      await this.peerConnection.addIceCandidate(candidate);
    } else {
      this.pendingIceCandidates.push(candidate);
    }
  }

  private async flushPendingIceCandidates() {
    for (const candidate of this.pendingIceCandidates) {
      await this.peerConnection.addIceCandidate(candidate);
    }
    this.pendingIceCandidates = [];
  }

  public async handleSignal(message: SignalMessage, signallingSocket: WebSocket) {
    if (message.type === 'peer-list') return;
    if (message.to !== this.localId) return;

    this.remoteId = message.from;
    this.polite = this.localId > message.from;
    this.onState(message.from, 'signalling');

    if (message.type === 'offer') {
      const offerCollision = this.makingOffer || this.peerConnection.signalingState !== 'stable';
      if (offerCollision && !this.polite) {
        this.onEvent(message.from, 'Ignoring incoming offer due to glare collision');
        return;
      }

      this.onEvent(message.from, `Received offer from ${message.from}`);
      await this.peerConnection.setRemoteDescription(message.payload);
      await this.flushPendingIceCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      this.onEvent(message.from, `Sending answer to ${message.from}`);
      this.sendSignal(signallingSocket, {
        type: 'answer',
        from: this.localId,
        to: message.from,
        payload: answer
      });
    } else if (message.type === 'answer') {
      this.onEvent(message.from, `Received answer from ${message.from}`);
      await this.peerConnection.setRemoteDescription(message.payload);
      await this.flushPendingIceCandidates();
    } else if (message.type === 'ice-candidate') {
      this.onEvent(message.from, `Received ICE candidate from ${message.from}`);
      await this.addIceCandidate(message.payload);
    }
  }

  private sendSignal(socket: WebSocket, message: SignalMessage) {
    socket.send(JSON.stringify(message));
  }

  public sendMessage(text: string) {
    this.sendChatMessage(text);
  }
}
