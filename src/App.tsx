import { useEffect, useMemo, useRef, useState } from 'react';
import { generateIdentityKeyPair, deriveFingerprint, exportPrivateKey, exportPublicKey, sha256 } from './crypto/identity';
import { connectToSignalling, SignalMessage } from './p2p/signalling';
import { PeerConnectionManager } from './p2p/webrtc';
import { loadIdentity, saveIdentity, loadContacts, saveContact, deleteContact, savePost, loadPosts, saveDiscoveryInteraction } from './storage/idb';
import { createSignedPost, verifySignedPost } from './crypto/signed';
import { publishPost, fetchDiscovery } from './services/discovery';
import type { ConnectionState, Contact, SignedPost, StoredPost } from './types';

interface IdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id: string;
}

function App() {
  const peerManagerRef = useRef<PeerConnectionManager | null>(null);
  const signallingSocketRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>('idle');
  const [signallingStatus, setSignallingStatus] = useState('idle');
  const [remoteId, setRemoteId] = useState('');
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [posts, setPosts] = useState<StoredPost[]>([]);
  const [discoveryPosts, setDiscoveryPosts] = useState<StoredPost[]>([]);
  const [newPostContent, setNewPostContent] = useState('');
  const [newPostTags, setNewPostTags] = useState('');
  const [currentPeerId, setCurrentPeerId] = useState<string | null>(null);

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
    async function loadLocalData() {
      const cs = await loadContacts();
      setContacts(cs || []);
      const ps = await loadPosts();
      setPosts(ps || []);
    }
    loadLocalData();
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
      async (post) => {
        const valid = await verifySignedPost(post);
        const stored: StoredPost = {
          ...post,
          source: 'peer',
          receivedAt: new Date().toISOString(),
          valid
        };
        await savePost(stored);
        setPosts((prev) => [stored, ...prev]);
        addLog(`Received ${valid ? 'verified' : 'invalid'} post from peer`);
      },
      (event) => {
        addLog(event);
      }
    );

    peerManagerRef.current = manager;

    const socket = connectToSignalling(
      identity.id,
      (message: SignalMessage) => {
        if (message.from && message.from !== identity.id) {
          setCurrentPeerId(message.from);
        }
        manager.handleSignal(message, socket);
      },
      (status) => {
        setSignallingStatus(status);
        addLog(`Signalling server status: ${status}`);
      }
    );
    signallingSocketRef.current = socket;
  }, [identity]);

  async function handleAddContactFromKey(publicKey: string, displayName?: string) {
    const fingerprint = await deriveFingerprint(publicKey);
    const contact: Contact = {
      publicKey,
      fingerprint,
      displayName,
      addedAt: new Date().toISOString(),
      followed: false
    };
    await saveContact(contact);
    setContacts((prev) => [...prev.filter((c) => c.publicKey !== publicKey), contact]);
    addLog(`Added contact ${fingerprint}`);
  }

  async function handleToggleFollow(publicKey: string) {
    const existing = contacts.find((c) => c.publicKey === publicKey);
    if (!existing) return;
    const updated = { ...existing, followed: !existing.followed };
    await saveContact(updated);
    setContacts((prev) => prev.map((c) => (c.publicKey === publicKey ? updated : c)));
    addLog(`${updated.followed ? 'Following' : 'Unfollowed'} ${updated.fingerprint}`);
  }

  async function handleRemoveContact(publicKey: string) {
    await deleteContact(publicKey);
    setContacts((prev) => prev.filter((c) => c.publicKey !== publicKey));
    addLog(`Removed contact`);
  }

  async function handleCreatePost(publishToDiscovery = false) {
    if (!identity) return;
    const id = await sha256(identity.publicKey + Date.now().toString());
    const tags = newPostTags.split(',').map((t) => t.trim()).filter(Boolean);
    const signed = await createSignedPost(id, identity.publicKey, identity.privateKey, newPostContent, tags);
    const stored: StoredPost = {
      ...signed,
      source: 'local',
      receivedAt: new Date().toISOString(),
      valid: true
    };
    await savePost(stored);
    setPosts((prev) => [stored, ...prev]);
    addLog('Created local post');
    setNewPostContent('');
    setNewPostTags('');

    const connectedPeer = currentPeerId && connectionStatus === 'connected';
    const peerFollowed = currentPeerId
      ? contacts.some((c) => c.fingerprint === currentPeerId && c.followed)
      : false;
    if (connectedPeer && peerFollowed) {
      peerManagerRef.current?.sendSignedPost(stored);
      addLog('Shared post with connected followed peer');
    }

    if (publishToDiscovery) {
      try {
        await publishPost(signed);
        addLog('Published post to discovery');
      } catch (err: any) {
        addLog(`Discovery publish failed: ${err.message}`);
      }
    }
  }

  async function handleFetchDiscovery() {
    try {
      const items = await fetchDiscovery(20);
      const verifiedPosts = await Promise.all(
        items.map(async (post) => ({
          ...post,
          source: 'discovery' as const,
          receivedAt: new Date().toISOString(),
          valid: await verifySignedPost(post)
        }))
      );
      setDiscoveryPosts(verifiedPosts);
      addLog(`Fetched ${verifiedPosts.length} discovery posts`);
    } catch (err: any) {
      addLog(`Discovery fetch failed: ${err.message}`);
    }
  }

  async function handleSaveDiscoveryPost(post: SignedPost) {
    const valid = await verifySignedPost(post);
    const stored: StoredPost = {
      ...post,
      source: 'discovery',
      receivedAt: new Date().toISOString(),
      valid
    };
    await savePost(stored);
    setPosts((prev) => [stored, ...prev]);
    await saveDiscoveryInteraction({ id: post.id, type: 'saved', timestamp: new Date().toISOString() });
    addLog(`Saved discovery post locally (${valid ? 'verified' : 'invalid'})`);
  }

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
    setCurrentPeerId(remoteId);
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

  function handleSendPostToPeer(post: StoredPost) {
    const manager = peerManagerRef.current;
    if (!manager || connectionStatus !== 'connected') return;
    manager.sendSignedPost(post);
    addLog(`Sent post ${post.id} to connected peer`);
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
        <h2>Contacts</h2>
        <div>
          {contacts.map((c) => (
            <div key={c.fingerprint} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
              <div>
                <div><strong>{c.displayName ?? c.fingerprint}</strong></div>
                <div className="note">{c.fingerprint}</div>
              </div>
              <div>
                <button className="btn secondary" onClick={() => handleToggleFollow(c.publicKey)}>{c.followed ? 'Unfollow' : 'Follow'}</button>
                <button className="btn secondary" onClick={() => { setRemoteId(c.fingerprint); addLog(`Prepared to connect to ${c.fingerprint}`); }}>Connect</button>
                <button className="btn secondary" onClick={() => handleRemoveContact(c.publicKey)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
        <p className="note">Add contacts by public key or from discovery results.</p>
      </div>

      <div className="card">
        <h2>Create Post</h2>
        <textarea value={newPostContent} onChange={(e) => setNewPostContent(e.target.value)} placeholder="Write a post..." />
        <input value={newPostTags} onChange={(e) => setNewPostTags(e.target.value)} placeholder="tags (comma separated)" />
        <div className="row">
          <button className="btn" onClick={() => handleCreatePost(false)}>Save locally</button>
          <button className="btn" onClick={() => handleCreatePost(true)}>Publish to discovery</button>
        </div>
      </div>

      <div className="card">
        <h2>Discovery</h2>
        <div className="row">
          <button className="btn" onClick={handleFetchDiscovery}>Fetch discovery posts</button>
        </div>
        <div>
          {discoveryPosts.map((p) => (
            <div key={p.id} style={{ border: '1px solid rgba(255,255,255,0.06)', padding: '0.5rem', marginTop: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                <div><strong>{p.author.slice(0, 16)}</strong> <span className="note">{new Date(p.timestamp).toLocaleString()}</span></div>
                <span className={`note ${p.valid === false ? 'invalid' : 'verified'}`}>{p.valid === false ? 'Invalid' : 'Verified'}</span>
              </div>
              <div>{p.content}</div>
              <div className="note">{p.tags.join(', ')}</div>
              <div className="row">
                <button className="btn secondary" onClick={() => handleAddContactFromKey(p.author)}>Add contact</button>
                <button className="btn secondary" onClick={() => handleToggleFollow(p.author)}>Follow</button>
                <button className="btn secondary" onClick={() => handleSaveDiscoveryPost(p)}>Save</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Local feed</h2>
        {posts.length === 0 ? (
          <p>No posts yet.</p>
        ) : (
          <div>
            {posts.map((p) => (
              <div key={p.id} style={{ border: '1px solid rgba(255,255,255,0.06)', padding: '0.5rem', marginTop: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <div><strong>{p.source === 'local' ? 'You' : p.author.slice(0, 16)}</strong> <span className="note">{new Date(p.receivedAt).toLocaleString()}</span></div>
                  <span className={`note ${p.valid === false ? 'invalid' : 'verified'}`}>{p.valid === false ? 'Invalid' : 'Verified'}</span>
                </div>
                <div>{p.content}</div>
                <div className="note">{p.tags.join(', ')}</div>
                {connectionStatus === 'connected' && (
                  <div className="row">
                    <button className="btn secondary" onClick={() => handleSendPostToPeer(p)}>Send to peer</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
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
