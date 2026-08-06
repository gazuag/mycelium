import { useEffect, useMemo, useRef, useState } from 'react';
import { generateIdentityKeyPair, deriveFingerprint, exportPrivateKey, exportPublicKey, sha256 } from './crypto/identity';
import { connectToSignalling, SignalMessage } from './p2p/signalling';
import { PeerConnectionManager } from './p2p/webrtc';
import { loadIdentity, saveIdentity, loadContacts, saveContact, deleteContact, saveProfile, loadProfile, savePost, loadPosts, saveDiscoveryInteraction, loadDiscoveryInteractions, saveMessageQueue, loadMessageQueue, deleteMessageQueue } from './storage/idb';
import { createSignedPost, verifySignedPost } from './crypto/signed';
import { publishPost, fetchDiscovery } from './services/discovery';
import { AppHeader } from './components/AppHeader';
import { TabBar } from './components/TabBar';
import { HomePage } from './pages/HomePage';
import { PeoplePage } from './pages/PeoplePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { ChatPage } from './pages/ChatPage';
import { ProfilePage } from './pages/ProfilePage';
import { MyProfilePage } from './pages/MyProfilePage';
import type { ConnectionState, Contact, PeerMetadata, SignedPost, StoredPost, QueuedMessage } from './types';

interface IdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id: string;
  nickname?: string;
  bio?: string;
}

type AppPage = 'home' | 'people' | 'discover' | 'profile' | 'myprofile' | 'chat';

function App() {
  const peerManagersRef = useRef<Record<string, PeerConnectionManager>>({});
  const signallingSocketRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>('idle');
  const [signallingStatus, setSignallingStatus] = useState('idle');
  const [remoteId, setRemoteId] = useState('');
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [dataChannelOpen, setDataChannelOpen] = useState(false);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [directChats, setDirectChats] = useState<Record<string, string[]>>({});
  const [messageQueue, setMessageQueue] = useState<Record<string, QueuedMessage[]>>({});
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [posts, setPosts] = useState<StoredPost[]>([]);
  const [discoveryPosts, setDiscoveryPosts] = useState<StoredPost[]>([]);
  const [newPostContent, setNewPostContent] = useState('');
  const [newPostTags, setNewPostTags] = useState('');
  const [currentPage, setCurrentPage] = useState<'home' | 'people' | 'discover' | 'profile' | 'myprofile' | 'chat'>('home');
  const [headerCollapsed, setHeaderCollapsed] = useState(() => localStorage.getItem('headerCollapsed') === 'true');
  const [scrollPositions, setScrollPositions] = useState<Record<string, number>>({});
  const [profilePeerId, setProfilePeerId] = useState<string | null>(null);

  const selectedContact = selectedContactId ? contacts.find((c) => c.fingerprint === selectedContactId) : undefined;
  const profileContact = profilePeerId ? contacts.find((c) => c.fingerprint === profilePeerId) : undefined;
  const chatInputEnabled = selectedContactId !== null;
  const selectedContactOnline = selectedContact?.online ?? false;
  const selectedContactConnected = selectedContact?.connected ?? false;
  const selectedContactQueued = selectedContact?.queuedMessages ?? 0;
  const selectedContactUnread = selectedContact?.unreadMessages ?? 0;
  const homeFeedPosts = posts
    .filter((post) => !hiddenPostIds.has(post.id))
    .filter((post) => post.author === identity?.id || contacts.some((contact) => contact.fingerprint === post.author && contact.followed))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const discoveryFeedPosts = discoveryPosts
    .filter((post) => !hiddenPostIds.has(post.id))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const myPosts = posts
    .filter((post) => post.author === identity?.id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const profilePosts = profilePeerId
    ? posts.filter((post) => post.author === profilePeerId).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    : [];
  const profileLikedPosts = posts
    .filter((post) => post.reaction === 'like' && post.author !== profilePeerId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

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

  const chatEnabled = selectedContactId !== null && selectedContactConnected && dataChannelOpen;

  const setContactState = async (peerId: string, updates: Partial<Contact>, persist = false) => {
    setContacts((prev) => prev.map((contact) => (contact.fingerprint === peerId ? { ...contact, ...updates } : contact)));
    if (persist) {
      const contact = contacts.find((c) => c.fingerprint === peerId);
      if (contact) {
        await saveContact({ ...contact, ...updates });
      }
    }
  };

  const updateContactState = (peerId: string, updates: Partial<Contact>) => {
    setContacts((prev) => prev.map((contact) => (contact.fingerprint === peerId ? { ...contact, ...updates } : contact)));
  };

  const updateContactStateAndPersist = (peerId: string, updates: Partial<Contact>) => {
    setContacts((prev) => {
      const next = prev.map((contact) => (contact.fingerprint === peerId ? { ...contact, ...updates } : contact));
      const updated = next.find((contact) => contact.fingerprint === peerId);
      if (updated) {
        saveContact(updated);
      }
      return next;
    });
  };

  const getLocalDisplayName = () => identity?.id.slice(0, 12) ?? 'Me';

  const buildPeerMetadata = (peerId: string) => ({
    author: identity?.id ?? '',
    displayName: getLocalDisplayName(),
    following: contacts.find((c) => c.fingerprint === peerId)?.followed ?? false,
    timestamp: new Date().toISOString(),
    bio: `Peer ${identity?.id?.slice(0, 12) ?? 'unknown'}`,
    tags: []
  });

  const handlePeerMetadata = (peerId: string, metadata: any) => {
    setContacts((prev) => {
      const existing = prev.find((contact) => contact.fingerprint === peerId);
      if (existing) {
        const updated = {
          ...existing,
          displayName: metadata.displayName,
          follower: metadata.following
        };
        saveContact(updated);
        return prev.map((contact) => (contact.fingerprint === peerId ? updated : contact));
      }
      const newContact: Contact = {
        publicKey: peerId,
        fingerprint: peerId,
        displayName: metadata.displayName,
        addedAt: new Date().toISOString(),
        followed: false,
        follower: metadata.following,
        online: true,
        connected: true,
        unreadMessages: 0,
        queuedMessages: 0
      };
      saveContact(newContact);
      return [...prev, newContact];
    });
    addLog(`Received profile from ${peerId}: ${metadata.displayName} following=${metadata.following}`);
  };

  const saveDirectMessage = (peerId: string, messageText: string, fromPeer = true) => {
    setDirectChats((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), fromPeer ? `Peer: ${messageText}` : `You: ${messageText}`]
    }));
  };

  const addKnownPeer = async (peerId: string) => {
    if (!peerId || peerId === identity?.id) return;
    const existing = contacts.find((c) => c.fingerprint === peerId);
    if (existing) return;
    const contact: Contact = {
      publicKey: peerId,
      fingerprint: peerId,
      addedAt: new Date().toISOString(),
      followed: false,
      follower: false,
      online: false,
      connected: false,
      unreadMessages: 0,
      queuedMessages: 0
    };
    await saveContact(contact);
    setContacts((prev) => [...prev, contact]);
  };

  const refreshMessageQueue = async () => {
    const queued = await loadMessageQueue();
    const queueMap: Record<string, QueuedMessage[]> = queued.reduce((acc, message) => {
      acc[message.recipient] = [...(acc[message.recipient] || []), message];
      return acc;
    }, {} as Record<string, QueuedMessage[]>);
    setMessageQueue(queueMap);
    setContacts((prev) => prev.map((contact) => ({
      ...contact,
      queuedMessages: queueMap[contact.fingerprint]?.length ?? 0
    })));
  };

  const queuePeerMessage = async (peerId: string, text: string) => {
    const queuedMessage: QueuedMessage = {
      id: `${peerId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      timestamp: new Date().toISOString(),
      status: 'queued'
    };
    await saveMessageQueue({
      ...queuedMessage,
      recipient: peerId
    });
    setMessageQueue((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), queuedMessage]
    }));
    updateContactState(peerId, { queuedMessages: (contacts.find((c) => c.fingerprint === peerId)?.queuedMessages || 0) + 1 });
  };

  const flushQueuedMessages = async (peerId: string) => {
    const manager = peerManagersRef.current[peerId];
    if (!manager || !messageQueue[peerId]?.length) return;

    const queued = messageQueue[peerId];
    for (const queuedMessage of queued) {
      manager.sendChatMessage(queuedMessage.text);
      await deleteMessageQueue(queuedMessage.id);
      saveDirectMessage(peerId, queuedMessage.text, false);
    }

    setMessageQueue((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    updateContactState(peerId, { queuedMessages: 0 });
    addLog(`Delivered ${queued.length} queued messages to ${peerId}`);
  };

  const ensurePeerManager = (peerId: string) => {
    if (peerManagersRef.current[peerId]) {
      return peerManagersRef.current[peerId];
    }
    if (!identity) return null;

    const manager = new PeerConnectionManager(
      identity.id,
      (peer, state) => {
        setConnectionStatus(state);
        updateContactState(peer, { connected: state === 'connected', lastConnectionStatus: state });
        if (state !== 'connected') {
          setDataChannelOpen(false);
        }
      },
      (peer, incoming) => {
        saveDirectMessage(peer, incoming, true);
        if (peer !== selectedContactId) {
          updateContactState(peer, { unreadMessages: (contacts.find((c) => c.fingerprint === peer)?.unreadMessages || 0) + 1 });
        }
      },
      (signal) => {
        const socket = signallingSocketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(signal));
        }
      },
      async (peer: string, post: SignedPost) => {
        const valid = await verifySignedPost(post);
        const stored: StoredPost = {
          ...post,
          source: 'peer',
          receivedAt: new Date().toISOString(),
          valid
        };
        await savePost(stored);
        setPosts((prev) => [stored, ...prev.filter((existing) => existing.id !== stored.id)]);
        addLog(`Received ${valid ? 'verified' : 'invalid'} post from ${peer}`);
      },
      (peer: string, metadata: PeerMetadata) => {
        handlePeerMetadata(peer, metadata);
      },
      async (peer: string) => {
        const outgoingPosts = posts.map((stored) => ({
          protocol: stored.protocol,
          version: stored.version,
          type: stored.type,
          id: stored.id,
          author: stored.author,
          timestamp: stored.timestamp,
          content: stored.content,
          tags: stored.tags,
          reaction: stored.reaction,
          repostOf: stored.repostOf,
          originalAuthor: stored.originalAuthor,
          signature: stored.signature
        }));
        peerManagersRef.current[peer]?.sendPostsBatch(outgoingPosts);
      },
      async (peer: string, posts: SignedPost[]) => {
        const newStoredPosts: StoredPost[] = [];
        for (const post of posts) {
          const valid = await verifySignedPost(post);
          const stored: StoredPost = {
            ...post,
            source: 'peer',
            receivedAt: new Date().toISOString(),
            valid
          };
          await savePost(stored);
          newStoredPosts.push(stored);
        }
        setPosts((prev) => [...newStoredPosts, ...prev.filter((existing) => !newStoredPosts.some((p) => p.id === existing.id))]);
        addLog(`Synchronized ${posts.length} posts from ${peer}`);
      },
      async (peer: string) => {
        setDataChannelOpen(true);
        setActivePeerId(peer);
        updateContactState(peer, { connected: true });
        const manager = peerManagersRef.current[peer];
        if (manager) {
          manager.sendMetadata(buildPeerMetadata(peer));
          manager.sendRequestPosts();
        }
        await flushQueuedMessages(peer);
      },
      (peer: string) => {
        if (selectedContactId === peer) {
          setDataChannelOpen(false);
          setActivePeerId(null);
        }
        updateContactState(peer, { connected: false, lastConnectionStatus: 'disconnected' });
      },
      (peer: string, event: string) => {
        addLog(`Peer ${peer}: ${event}`);
      }
    );

    peerManagersRef.current[peerId] = manager;
    return manager;
  };

  const handlePeerList = async (peers: string[]) => {
    await Promise.all(peers.map((peerId) => addKnownPeer(peerId)));

    setContacts((prev) =>
      prev.map((contact) => ({
        ...contact,
        online: peers.includes(contact.fingerprint)
      }))
    );

    const socket = signallingSocketRef.current;
    peers.forEach((peerId) => {
      if (!peerId || peerId === identity?.id) return;
      const contact = contacts.find((c) => c.fingerprint === peerId);
      const manager = ensurePeerManager(peerId);
      if (socket && socket.readyState === WebSocket.OPEN && manager && !contact?.connected) {
        manager.createOffer(peerId, socket);
      }
    });

    for (const peerId of peers) {
      if (messageQueue[peerId]?.length) {
        await flushQueuedMessages(peerId);
      }
    }
  };

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
      await refreshMessageQueue();
    }
    loadLocalData();
  }, []);

  useEffect(() => {
    if (!identity?.id) return;

    const socket = connectToSignalling(
      identity.id,
      async (message: SignalMessage) => {
        if (message.type === 'peer-list') {
          handlePeerList(message.peers);
          return;
        }

        if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
          const manager = ensurePeerManager(message.from);
          if (manager) {
            await manager.handleSignal(message, socket);
          }
        }
      },
      (status) => {
        setSignallingStatus(status);
        addLog(`Signalling server status: ${status}`);
      }
    );

    signallingSocketRef.current = socket;
    return () => {
      socket.close();
    };
  }, [identity]);

  useEffect(() => {
    if (!identity?.id) return;
    const interval = window.setInterval(() => {
      const socket = signallingSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      contacts.forEach((contact) => {
        if (!contact.fingerprint || contact.fingerprint === identity.id) return;

        const manager = ensurePeerManager(contact.fingerprint);
        if (contact.online && !contact.connected && contact.lastConnectionStatus !== 'signalling' && contact.lastConnectionStatus !== 'connecting') {
          if (manager) {
            manager.createOffer(contact.fingerprint, socket);
          }
        }

        if (contact.connected && manager) {
          manager.sendMetadata(buildPeerMetadata(contact.fingerprint));
        }
      });
    }, 15000);

    return () => window.clearInterval(interval);
  }, [contacts, identity]);

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

    Object.entries(peerManagersRef.current).forEach(([peerId, manager]) => {
      const contact = contacts.find((c) => c.fingerprint === peerId);
      if (contact?.followed && contact.connected && manager) {
        manager.sendSignedPost(stored);
        addLog(`Shared post with connected followed peer ${peerId}`);
      }
    });

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
    await addKnownPeer(post.author);
    await savePost(stored);
    setPosts((prev) => [stored, ...prev.filter((existing) => existing.id !== stored.id)]);
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
    const socket = signallingSocketRef.current;
    const normalizedRemoteId = remoteId.trim();
    if (!socket || !normalizedRemoteId) return;
    const manager = ensurePeerManager(normalizedRemoteId);
    if (!manager) return;
    setRemoteId(normalizedRemoteId);
    setSelectedContactId(normalizedRemoteId);
    addLog(`Starting call to ${normalizedRemoteId}`);
    manager.createOffer(normalizedRemoteId, socket);
  }

  function handleSelectContact(peerId: string) {
    setSelectedContactId(peerId);
    addLog(`Selected contact ${peerId}`);
    updateContactState(peerId, { unreadMessages: 0 });
  }

  async function handleSendDirectMessage() {
    if (!selectedContactId || !message.trim()) return;
    const peerId = selectedContactId;
    const trimmedMessage = message.trim();
    const manager = peerManagersRef.current[peerId];

    saveDirectMessage(peerId, trimmedMessage, false);

    if (manager && selectedContactConnected && dataChannelOpen) {
      manager.sendChatMessage(trimmedMessage);
      addLog(`Sent direct message to ${peerId}`);
    } else {
      await queuePeerMessage(peerId, trimmedMessage);
      addLog(`Queued direct message for ${peerId}`);
    }

    if (selectedContactId === peerId) {
      updateContactState(peerId, { unreadMessages: 0 });
    }

    setMessage('');
  }

  function handleSendPostToPeer(post: StoredPost) {
    if (!selectedContactId) return;
    const manager = peerManagersRef.current[selectedContactId];
    if (!manager || selectedContactId !== activePeerId) return;
    manager.sendSignedPost(post);
    addLog(`Sent post ${post.id} to peer ${selectedContactId}`);
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
        <h2>Connections</h2>
        <div>
          {contacts.map((c) => (
            <div key={c.fingerprint} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ minWidth: 0 }}>
                <div><strong>{c.displayName ?? c.fingerprint}</strong></div>
                <div className="note">{c.fingerprint}</div>
                <div className="note">
                  {c.followed ? 'Following' : 'Not following'} · {c.follower ? 'Follower' : 'Not follower'} · {c.online ? 'Online' : 'Offline'} · {c.connected ? 'Connected' : 'Disconnected'}
                  {c.unreadMessages ? ` · ${c.unreadMessages} new` : ''}
                  {c.queuedMessages ? ` · ${c.queuedMessages} queued` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                <button className="btn secondary" onClick={() => handleToggleFollow(c.publicKey)}>{c.followed ? 'Unfollow' : 'Follow'}</button>
                <button className="btn secondary" onClick={() => handleSelectContact(c.fingerprint)}>
                  DM{c.unreadMessages ? ` (${c.unreadMessages})` : ''}
                </button>
                <button className="btn secondary" onClick={() => {
                  if (window.confirm(`Remove peer ${c.fingerprint}? This will forget connection history.`)) {
                    handleRemoveContact(c.publicKey);
                  }
                }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
        <p className="note">The Connections section includes all peers you've added or discovered. Followed peers are auto-connected when online, and offline DMs queue until delivery.</p>
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

      {selectedContactId && selectedContact && (
        <div className="card">
          <h3>Chat with {selectedContact.displayName ?? selectedContact.fingerprint}</h3>
          <p className="note">
            Status: {selectedContact.connected ? 'Connected' : selectedContact.online ? 'Online' : 'Offline'} ·
            {selectedContact.followed ? ' You follow them' : ' You do not follow them'} ·
            {selectedContact.follower ? ' Follows you' : ' Does not follow you'}
          </p>
          <div>
            {(directChats[selectedContactId] || []).map((entry, index) => (
              <p key={index}>{entry}</p>
            ))}
          </div>
          <div className="row">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={selectedContactId ? 'Type a message' : 'Select a contact first'}
              disabled={!selectedContactId}
            />
            <button className="btn" onClick={handleSendDirectMessage} disabled={!chatInputEnabled || !message.trim()}>Send</button>
          </div>
          <p className="note">Message will queue when the peer is offline or not connected, then deliver automatically when the data channel opens.</p>
        </div>
      )}

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
