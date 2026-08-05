import type { SignalMessage } from './signalling';
import type { ConnectionState } from '../types';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export class PeerConnectionManager {
  private peerConnection: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private localId: string;
  private remoteId: string | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private polite = false;
  private onState: (state: ConnectionState) => void;
  private onData: (message: string) => void;
  private onSignal: (message: SignalMessage) => void;

  constructor(
    localId: string,
    onState: (state: ConnectionState) => void,
    onData: (message: string) => void,
    onSignal: (message: SignalMessage) => void
  ) {
    this.localId = localId;
    this.onState = onState;
    this.onData = onData;
    this.onSignal = onSignal;
    this.peerConnection = this.createConnection();
  }

  private createConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (event.candidate && this.remoteId) {
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
      if (state === 'connected') {
        this.onState('connected');
      } else if (state === 'connecting') {
        this.onState('connecting');
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.onState('disconnected');
      }
    };

    pc.ondatachannel = (event) => {
      this.attachDataChannel(event.channel);
    };

    return pc;
  }

  private attachDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    this.dataChannel.onopen = () => {
      this.onState('connected');
    };
    this.dataChannel.onclose = () => {
      this.onState('disconnected');
    };
    this.dataChannel.onmessage = (event) => {
      this.onData(event.data);
    };
  }

  public async createOffer(remoteId: string, signallingSocket: WebSocket) {
    this.remoteId = remoteId;
    this.polite = this.localId > remoteId;
    this.makingOffer = true;
    this.onState('signalling');
    const channel = this.peerConnection.createDataChannel('chat');
    this.attachDataChannel(channel);

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.makingOffer = false;

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
    if (message.to !== this.localId) return;

    this.remoteId = message.from;
    this.polite = this.localId > message.from;
    this.onState('signalling');

    if (message.type === 'offer') {
      const offerCollision = this.makingOffer || this.peerConnection.signalingState !== 'stable';
      if (offerCollision && !this.polite) {
        console.warn('Ignoring incoming offer due to glare collision');
        return;
      }

      await this.peerConnection.setRemoteDescription(message.payload);
      await this.flushPendingIceCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      this.sendSignal(signallingSocket, {
        type: 'answer',
        from: this.localId,
        to: message.from,
        payload: answer
      });
    } else if (message.type === 'answer') {
      await this.peerConnection.setRemoteDescription(message.payload);
      await this.flushPendingIceCandidates();
    } else if (message.type === 'ice-candidate') {
      await this.addIceCandidate(message.payload);
    }
  }

  private sendSignal(socket: WebSocket, message: SignalMessage) {
    socket.send(JSON.stringify(message));
  }

  public sendMessage(text: string) {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(text);
    }
  }
}
