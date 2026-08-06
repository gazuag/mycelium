import type { SignalMessage } from './signalling';
import type { ConnectionState, SignedPost } from '../types';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

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
  private onRequestPosts: (peerId: string) => void;
  private onPostsBatch: (peerId: string, posts: SignedPost[]) => void;
  private onSignal: (message: SignalMessage) => void;
  private onOpen: (peerId: string) => void;
  private onClose: (peerId: string) => void;
  private onEvent: (peerId: string, event: string) => void;

  constructor(
    localId: string,
    onState: (peerId: string, state: ConnectionState) => void,
    onData: (peerId: string, message: string) => void,
    onSignal: (message: SignalMessage) => void,
    onPost: (peerId: string, post: SignedPost) => void,
    onRequestPosts: (peerId: string) => void,
    onPostsBatch: (peerId: string, posts: SignedPost[]) => void,
    onOpen: (peerId: string) => void,
    onClose: (peerId: string) => void,
    onEvent: (peerId: string, event: string) => void
  ) {
    this.localId = localId;
    this.onState = onState;
    this.onData = onData;
    this.onPost = onPost;
    this.onRequestPosts = onRequestPosts;
    this.onPostsBatch = onPostsBatch;
    this.onSignal = onSignal;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onEvent = onEvent;
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
      this.onOpen(peerId);
    };
    this.dataChannel.onclose = () => {
      const peerId = this.remoteId ?? '<unknown>';
      this.onEvent(peerId, 'Data channel closed');
      this.onState(peerId, 'disconnected');
      this.onClose(peerId);
    };
    this.dataChannel.onmessage = (event) => {
      const data = event.data;
      const peerId = this.remoteId ?? '<unknown>';
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.type === 'chat' && typeof parsed.text === 'string') {
            this.onData(peerId, parsed.text);
            return;
          }
          if (parsed?.type === 'signed-post' && parsed.post) {
            this.onPost(peerId, parsed.post);
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

  private sendData(payload: unknown) {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(payload));
    }
  }

  public sendChatMessage(text: string) {
    this.sendData({ type: 'chat', text });
  }

  public sendSignedPost(post: SignedPost) {
    this.sendData({ type: 'signed-post', post });
  }

  public sendRequestPosts() {
    this.sendData({ type: 'request-posts' });
  }

  public sendPostsBatch(posts: SignedPost[]) {
    this.sendData({ type: 'posts-batch', posts });
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
