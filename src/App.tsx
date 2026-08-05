import { useEffect, useMemo, useRef, useState } from 'react';
import { generateIdentityKeyPair, deriveFingerprint, exportPrivateKey, exportPublicKey } from './crypto/identity';
import { connectToSignalling, SignalMessage } from './p2p/signalling';
import { PeerConnectionManager } from './p2p/webrtc';
import { loadIdentity, saveIdentity } from './storage/idb';
import type { ConnectionState } from './types';

interface IdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id: string;
}

function App() {
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const peerManagerRef = useRef<PeerConnectionManager | null>(null);
  const signallingSocketRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>('idle');
  const [signallingStatus, setSignallingStatus] = useState('idle');
  const [remoteId, setRemoteId] = useState('');
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (entry: string) => {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}: ${entry}`]);
  };

  const statusLabel = useMemo(() => {
    switch (connectionStatus) {
      case 'signalling':
        return 'Signalling';
      case 'connecting':
        return 'Connecting';
      case 'connected':
        return 'Connected';
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Idle';
    }
  }, [connectionStatus]);

  useEffect(() => {
    async function bootstrap() {
      const stored = await loadIdentity();
      if (stored) {
        const id = stored.id ?? (await deriveFingerprint(stored.publicKey));
        const loadedIdentity = { ...stored, id };
        setIdentity(loadedIdentity);
      }
    }
    bootstrap();
  }, []);

  useEffect(() => {
    if (!identity?.id) return;

    const manager = new PeerConnectionManager(
      identity.id,
      setConnectionStatus,
      (incoming) => {
        setChat((prev) => [...prev, `Peer: ${incoming}`]);
      },
      (signal) => {
        const socket = signallingSocketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(signal));
        }
      },
      (event) => {
        addLog(event);
      }
    );

    peerManagerRef.current = manager;

    const socket = connectToSignalling(
      identity.id,
      (message: SignalMessage) => {
        manager.handleSignal(message, socket);
      },
      (status) => {
        setSignallingStatus(status);
        addLog(`Signalling server status: ${status}`);
      }
    );
    signallingSocketRef.current = socket;
  }, [identity]);

  async function handleCreateIdentity() {
    const keys = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(keys.publicKey);
    const privateKey = await exportPrivateKey(keys.privateKey);
    const identityId = await deriveFingerprint(publicKey);
    await saveIdentity({ key: 'local', publicKey, privateKey, id: identityId });
    setIdentity({ key: 'local', publicKey, privateKey, id: identityId });
  }

  async function handleExportIdentity() {
    if (!identity) return;
    const blob = new Blob([JSON.stringify(identity)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mycelium-identity-backup.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function handleStartCall() {
    const manager = peerManagerRef.current;
    const socket = signallingSocketRef.current;
    if (!manager || !socket || !remoteId) return;
    addLog(`Starting call to ${remoteId}`);
    setChat((prev) => [...prev, 'System: Starting call...']);
    manager.createOffer(remoteId, socket);
  }

  function handleSendMessage() {
    const manager = peerManagerRef.current;
    if (!manager || !message.trim()) return;
    addLog(`Sending message: ${message.trim()}`);
    manager.sendMessage(message.trim());
    setChat((prev) => [...prev, `You: ${message.trim()}`]);
    setMessage('');
  }

  return (
    <div className="app-shell">
      <div className="card header">
        <h1>Mycelium P2P Social</h1>
        <p className="note">Phase 1 prototype: local identity + WebRTC messaging through a signalling server.</p>
        <div className="status-row">
          <div className="status-badge">
            <span>Connection:</span>
            <strong>{statusLabel}</strong>
          </div>
          <div className="status-badge secondary">
            <span>Signalling:</span>
            <strong>{signallingStatus}</strong>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Identity</h2>
        {identity ? (
          <>
            <p><strong>Local ID:</strong> {identity.id}</p>
            <p><strong>Fingerprint:</strong> {identity.id}</p>
            <button className="btn" onClick={handleExportIdentity}>Export identity backup</button>
            <p className="note">Your private key stays on this device. Losing it means losing this identity.</p>
          </>
        ) : (
          <>
            <p>No local identity found.</p>
            <button className="btn" onClick={handleCreateIdentity}>Create local identity</button>
          </>
        )}
      </div>

      <div className="card">
        <h2>Peer connection</h2>
        <div className="row">
          <input
            value={remoteId}
            onChange={(event) => setRemoteId(event.target.value)}
            placeholder="Remote peer ID"
          />
          <button className="btn secondary" onClick={handleStartCall} disabled={!identity?.id || !remoteId}>Connect</button>
        </div>
        <p className="note">Use the remote peer's local ID to connect. The signalling server only passes offer/answer and ICE candidates.</p>
        <p className="note">If the call starts, watch the connection log for offer/answer/ICE events, then wait for status to become <strong>Connected</strong>.</p>
      </div>

      <div className="card">
        <h2>Chat</h2>
        <div>
          {chat.map((entry, index) => (
            <p key={index}>{entry}</p>
          ))}
        </div>
        <div className="row">
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={connectionStatus === 'connected' ? 'Type a message' : 'Waiting for connection...'}
            disabled={connectionStatus !== 'connected'}
          />
          <button className="btn" onClick={handleSendMessage} disabled={connectionStatus !== 'connected'}>Send</button>
        </div>
        <p className="note">The chat box is enabled only when the connection state becomes <strong>Connected</strong>.</p>
      </div>

      <div className="card">
        <h2>Connection log</h2>
        <div className="log-box">
          {logs.slice(-15).map((entry, index) => (
            <p key={index}>{entry}</p>
          ))}
        </div>
        <p className="note">Latest signalling and WebRTC events are shown here.</p>
      </div>
    </div>
  );
}

export default App;
