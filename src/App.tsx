import { useEffect, useMemo, useRef, useState } from 'react';
import { generateIdentityKeyPair, deriveFingerprint, exportPrivateKey, exportPublicKey, sha256 } from './crypto/identity';
import { connectToSignalling, SignalMessage } from './p2p/signalling';
import { PeerConnectionManager } from './p2p/webrtc';
import { loadIdentity, saveIdentity, loadContacts, saveContact, deleteContact, savePost, loadPosts, saveDiscoveryInteraction, loadDiscoveryInteractions, saveMessageQueue, loadMessageQueue, deleteMessageQueue } from './storage/idb';
import { createSignedPost, verifySignedPost } from './crypto/signed';
import { publishPost, fetchDiscovery } from './services/discovery';
import { AppHeader } from './components/AppHeader';
import { TabBar } from './components/TabBar';
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { PeoplePage } from './pages/PeoplePage';
import { ProfilePage } from './pages/ProfilePage';
import { MyProfilePage } from './pages/MyProfilePage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import type { ConnectionState, Contact, PeerMetadata, SignedPost, StoredPost, QueuedMessage } from './types';

interface IdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id: string;
}

type PageKey = 'home' | 'people' | 'discover' | 'profile' | 'myProfile' | 'chat' | 'settings';

interface ChatEntry {
  text: string;
  isMine: boolean;
  timestamp: string;
}

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
  const [directChats, setDirectChats] = useState<Record<string, ChatEntry[]>>({});
  const [messageQueue, setMessageQueue] = useState<Record<string, QueuedMessage[]>>({});
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [posts, setPosts] = useState<StoredPost[]>([]);
  const [page, setPage] = useState<PageKey>('home');
  const [profileContactId, setProfileContactId] = useState<string | null>(null);
  const [chatContactId, setChatContactId] = useState<string | null>(null);
  const [collapsedHeader, setCollapsedHeader] = useState<boolean>(() => localStorage.getItem('myceliumHeaderCollapsed') === 'true');
  const [hiddenPostIds, setHiddenPostIds] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('hiddenPosts') || '[]')));
  const [hiddenDiscoveryIds, setHiddenDiscoveryIds] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('hiddenDiscovery') || '[]')));
  const [myProfile, setMyProfile] = useState({ displayName: '', bio: '' });
  const [messageDraft, setMessageDraft] = useState('');
  const [pageScrollPositions, setPageScrollPositions] = useState<Record<PageKey, number>>({
    home: 0,
    people: 0,
    discover: 0,
    profile: 0,
    myProfile: 0,
    chat: 0,
    settings: 0
  });
  const [discoveryPosts, setDiscoveryPosts] = useState<StoredPost[]>([]);
  const [newPostContent, setNewPostContent] = useState('');
  const [newPostTags, setNewPostTags] = useState('');

  const selectedContact = selectedContactId ? contacts.find((c) => c.fingerprint === selectedContactId) : undefined;
  const chatInputEnabled = selectedContactId !== null;
  const selectedContactOnline = selectedContact?.online ?? false;
  const selectedContactConnected = selectedContact?.connected ?? false;
  const selectedContactQueued = selectedContact?.queuedMessages ?? 0;
  const selectedContactUnread = selectedContact?.unreadMessages ?? 0;

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
  const pageContact = profileContactId ? contacts.find((c) => c.fingerprint === profileContactId) : undefined;
  const chatContact = chatContactId ? contacts.find((c) => c.fingerprint === chatContactId) : undefined;

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
    const chatEntry: ChatEntry = {
      text: messageText,
      isMine: !fromPeer,
      timestamp: new Date().toISOString()
    };
    setDirectChats((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), chatEntry]
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

  const handleHidePost = (postId: string) => {
    setHiddenPostIds((prev) => {
      const next = new Set(prev);
      next.add(postId);
      localStorage.setItem('hiddenPosts', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  const handleHideDiscoveryPost = (postId: string) => {
    setHiddenDiscoveryIds((prev) => {
      const next = new Set(prev);
      next.add(postId);
      localStorage.setItem('hiddenDiscovery', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  const handleLikePost = async (postId: string) => {
    setPosts((prev) => prev.map((post) => (post.id === postId ? { ...post, reaction: 'like' } : post)));
  };

  const handleDislikePost = async (postId: string) => {
    setPosts((prev) => prev.map((post) => (post.id === postId ? { ...post, reaction: 'dislike' } : post)));
  };

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

  const visibleHomePosts = posts
    .filter((post) => !hiddenPostIds.has(post.id))
    .filter((post) => post.author === identity?.id || contacts.some((c) => c.fingerprint === post.author && c.followed))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const visibleDiscoveryPosts = discoveryPosts.filter((post) => !hiddenDiscoveryIds.has(post.id));

  const profilePosts = profileContactId
    ? posts.filter((post) => post.author === profileContactId).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    : [];

  const likedProfilePosts = profileContactId
    ? posts.filter((post) => post.author === profileContactId && post.reaction === 'like').sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    : [];

  const currentChatMessages = chatContactId ? directChats[chatContactId] || [] : [];

  function handlePageChange(nextPage: PageKey) {
    const pageContainer = document.getElementById('page-content');
    if (pageContainer) {
      setPageScrollPositions((prev) => ({ ...prev, [page]: pageContainer.scrollTop }));
    }
    setPage(nextPage);
  }

  const handleToggleHeader = () => {
    setCollapsedHeader((prev) => {
      localStorage.setItem('myceliumHeaderCollapsed', JSON.stringify(!prev));
      return !prev;
    });
  };

  useEffect(() => {
    const pageContainer = document.getElementById('page-content');
    if (pageContainer) {
      pageContainer.scrollTop = pageScrollPositions[page] || 0;
    }
  }, [page, pageScrollPositions]);

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
    setSelectedContactId(peerId);    setChatContactId(peerId);
    setPage('chat');    addLog(`Selected contact ${peerId}`);
    updateContactState(peerId, { unreadMessages: 0 });
  }

  async function handleSendDirectMessage() {
    if (!chatContactId || !message.trim()) return;
    const peerId = chatContactId;
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

    updateContactState(peerId, { unreadMessages: 0 });
    setMessage('');
  }

  function handleSendPostToPeer(post: StoredPost) {
    if (!selectedContactId) return;
    const manager = peerManagersRef.current[selectedContactId];
    if (!manager || selectedContactId !== activePeerId) return;
    manager.sendSignedPost(post);
    addLog(`Sent post ${post.id} to peer ${selectedContactId}`);
  }

  const connectedPeersCount = contacts.filter((contact) => contact.connected).length;
  const syncStatus = signallingStatus === 'connected' ? 'synced' : signallingStatus;
  const activeProfileContact = profileContactId ? contacts.find((c) => c.fingerprint === profileContactId) : undefined;
  const activeChatContact = chatContactId ? contacts.find((c) => c.fingerprint === chatContactId) : undefined;

  return (
    <div className="app-shell">
      <AppHeader
        collapsed={collapsedHeader}
        onToggleCollapse={handleToggleHeader}
        connectionStatus={connectionStatus}
        signallingStatus={signallingStatus}
        connectedPeers={connectedPeersCount}
        syncStatus={syncStatus}
        myFingerprint={identity?.id}
        onOpenMyProfile={() => setPage('myProfile')}
        onOpenSettings={() => setPage('settings')}
        onRefreshDiscovery={handleFetchDiscovery}
      />

      <main id="page-content" className="page-content">
        {page === 'home' && (
          <HomePage
            posts={visibleHomePosts}
            contacts={contacts}
            onAuthorClick={(peerId) => { setProfileContactId(peerId); setPage('profile'); }}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onReply={() => {}}
            onHide={handleHidePost}
          />
        )}

        {page === 'people' && (
          <PeoplePage
            contacts={contacts}
            onViewProfile={(peerId) => { setProfileContactId(peerId); setPage('profile'); }}
            onMessage={(peerId) => { setChatContactId(peerId); setPage('chat'); }}
            onToggleFollow={handleToggleFollow}
          />
        )}

        {page === 'discover' && (
          <DiscoverPage
            discoveryPosts={visibleDiscoveryPosts}
            onAuthorClick={(peerId) => { setProfileContactId(peerId); setPage('profile'); }}
            onAddContact={handleAddContactFromKey}
            onFollow={handleToggleFollow}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onHide={handleHideDiscoveryPost}
            onSave={handleSaveDiscoveryPost}
          />
        )}

        {page === 'profile' && activeProfileContact && (
          <ProfilePage
            contact={activeProfileContact}
            posts={profilePosts}
            likedPosts={likedProfilePosts}
            onFollowToggle={() => handleToggleFollow(activeProfileContact.publicKey)}
            onBlock={() => undefined}
            onMessage={() => { setChatContactId(activeProfileContact.fingerprint); setPage('chat'); }}
            onAuthorClick={(peerId) => { setProfileContactId(peerId); setPage('profile'); }}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
          />
        )}

        {page === 'myProfile' && (
          <MyProfilePage
            identityId={identity?.id ?? ''}
            publicKey={identity?.publicKey ?? ''}
            contacts={contacts}
            posts={posts}
            nickname={myProfile.displayName}
            bio={myProfile.bio}
            onNicknameChange={(value) => setMyProfile((prev) => ({ ...prev, displayName: value }))}
            onBioChange={(value) => setMyProfile((prev) => ({ ...prev, bio: value }))}
            onSaveProfile={() => {
              localStorage.setItem('myProfile', JSON.stringify(myProfile));
            }}
            onExportIdentity={handleExportIdentity}
            onImportIdentity={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'application/json';
              input.onchange = async (event) => {
                const file = (event.target as HTMLInputElement).files?.[0];
                if (!file) return;
                const text = await file.text();
                try {
                  const imported = JSON.parse(text);
                  if (imported?.publicKey && imported?.privateKey && imported?.id) {
                    await saveIdentity(imported);
                    setIdentity(imported);
                  }
                } catch (error) {
                  addLog('Import failed');
                }
              };
              input.click();
            }}
          />
        )}

        {page === 'chat' && activeChatContact && (
          <ChatPage
            contact={activeChatContact}
            messages={currentChatMessages}
            messageDraft={message}
            onMessageChange={setMessage}
            onSendMessage={handleSendDirectMessage}
            connectionText={activeChatContact.connected ? 'Connected' : activeChatContact.online ? 'Online' : 'Offline'}
          />
        )}

        {page === 'settings' && (
          <SettingsPage
            onResetApp={() => {
              setHiddenPostIds(new Set());
              setHiddenDiscoveryIds(new Set());
              setCollapsedHeader(false);
              localStorage.removeItem('hiddenPosts');
              localStorage.removeItem('hiddenDiscovery');
              localStorage.removeItem('myceliumHeaderCollapsed');
            }}
          />
        )}
      </main>

      <TabBar active={page === 'home' || page === 'people' || page === 'discover' ? page : 'home'} onChange={handlePageChange} />
    </div>
  );
}

export default App;
