import { useEffect, useMemo, useRef, useState } from 'react';
import { generateIdentityKeyPair, deriveFingerprint, exportPrivateKey, exportPublicKey, sha256, signString } from './crypto/identity';
import { connectToSignalling, resolveSignalServerUrl, SignalMessage } from './p2p/signalling';
import { PeerConnectionManager } from './p2p/webrtc';
import { loadIdentity, saveIdentity, deleteIdentity, loadContacts, saveContact, deleteContact, savePost, loadPosts, saveDiscoveryInteraction, loadDiscoveryInteractions, saveMessageQueue, loadMessageQueue, deleteMessageQueue, saveDirectChatMessage, loadDirectChatMessages, clearDirectChatMessages, updateDirectChatMessageStatus } from './storage/idb';
import { createSignedPost, verifySignedPost } from './crypto/signed';
import { publishPost, fetchDiscovery, handleDiscoveryResult } from './services/discovery';
import { AppHeader } from './components/AppHeader';
import { TabBar } from './components/TabBar';
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { PeoplePage } from './pages/PeoplePage';
import { ProfilePage } from './pages/ProfilePage';
import { MyProfilePage } from './pages/MyProfilePage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { LandingPage } from './pages/LandingPage';
import { canonicalize } from './p2p/protocol';
import type { ConnectionState, Contact, PeerMetadata, SignedPost, StoredPost, QueuedMessage } from './types';

interface IdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id: string;
}

type PageKey = 'home' | 'people' | 'discover' | 'profile' | 'myProfile' | 'chat' | 'settings';

interface ChatEntry {
  id?: string;
  text: string;
  isMine: boolean;
  timestamp: string;
  deliveryStatus?: 'queued' | 'sent';
}

interface FeedMixSettings {
  followedAuthors: number;
  followedLikes: number;
  discoveryRandom: number;
}

const DEFAULT_FEED_MIX: FeedMixSettings = {
  followedAuthors: 60,
  followedLikes: 30,
  discoveryRandom: 10
};

function dedupeContactsByFingerprint(items: Contact[]) {
  const mergedByFingerprint = new Map<string, Contact>();

  for (const contact of items) {
    const existing = mergedByFingerprint.get(contact.fingerprint);
    if (!existing) {
      mergedByFingerprint.set(contact.fingerprint, contact);
      continue;
    }

    mergedByFingerprint.set(contact.fingerprint, {
      ...existing,
      ...contact,
      displayName: contact.displayName ?? existing.displayName,
      profile: contact.profile ?? existing.profile,
      addedAt: existing.addedAt < contact.addedAt ? existing.addedAt : contact.addedAt,
      unreadMessages: Math.max(existing.unreadMessages ?? 0, contact.unreadMessages ?? 0),
      queuedMessages: Math.max(existing.queuedMessages ?? 0, contact.queuedMessages ?? 0),
      online: contact.online ?? existing.online,
      connected: contact.connected ?? existing.connected
    });
  }

  return Array.from(mergedByFingerprint.values());
}

function isValidPeerFingerprint(value: string) {
  return /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/i.test(value.trim());
}

function App() {
  const peerManagersRef = useRef<Record<string, PeerConnectionManager>>({});
  const signallingSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const suppressReconnectRef = useRef(false);
  const contactsRef = useRef<Contact[]>([]);
  const messageQueueRef = useRef<Record<string, QueuedMessage[]>>({});
  const outboundAckTimersRef = useRef<Record<string, number>>({});
  const pageRef = useRef<PageKey>('home');
  const chatContactIdRef = useRef<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>('idle');
  const [signallingStatus, setSignallingStatus] = useState('idle');
  const [signallingReconnectTick, setSignallingReconnectTick] = useState(0);
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
  const [myProfile, setMyProfile] = useState({
    displayName: '',
    bio: '',
    feedMix: DEFAULT_FEED_MIX
  });
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
  const selectedContactIdRef = useRef<string | null>(null);
  const myProfileRef = useRef({ displayName: '', bio: '', feedMix: DEFAULT_FEED_MIX });
  const identityRef = useRef<IdentityRecord | null>(null);

  useEffect(() => {
    selectedContactIdRef.current = selectedContactId;
  }, [selectedContactId]);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    chatContactIdRef.current = chatContactId;
  }, [chatContactId]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  useEffect(() => {
    myProfileRef.current = myProfile;
  }, [myProfile]);

  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  const selectedContact = selectedContactId ? contacts.find((c) => c.fingerprint === selectedContactId) : undefined;

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

  const signalEndpoint = useMemo(() => resolveSignalServerUrl(), []);
  const discoveryEndpoint = signalEndpoint;

  const chatEnabled = selectedContactId !== null && selectedContact?.connected === true && dataChannelOpen;
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

  const getLocalDisplayName = () => myProfile.displayName.trim() || identity?.id.slice(0, 12) || 'Me';

  const buildPeerMetadata = (peerId: string) => {
    const p = myProfileRef.current;
    const id = identityRef.current;
    return {
      author: id?.id ?? '',
      displayName: p.displayName.trim() || id?.id.slice(0, 12) || 'Me',
      following: contactsRef.current.find((c) => c.fingerprint === peerId)?.followed ?? false,
      timestamp: new Date().toISOString(),
      bio: p.bio.trim() || `Peer ${id?.id?.slice(0, 12) ?? 'unknown'}`,
      tags: []
    };
  };

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

  const saveDirectMessage = (peerId: string, messageText: string, fromPeer = true, deliveryStatus?: 'queued' | 'sent', messageIdOverride?: string) => {
    const timestamp = new Date().toISOString();
    const messageId = messageIdOverride ?? `${peerId}-${timestamp}-${Math.random().toString(16).slice(2)}`;
    const chatEntry: ChatEntry = {
      id: messageId,
      text: messageText,
      isMine: !fromPeer,
      timestamp,
      deliveryStatus
    };

    void saveDirectChatMessage({
      id: messageId,
      peerId,
      text: chatEntry.text,
      timestamp,
      isMine: chatEntry.isMine,
      deliveryStatus
    });

    setDirectChats((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), chatEntry]
    }));

    return messageId;
  };

  const markDirectMessageDelivered = (peerId: string, messageId: string, deliveryStatus: 'queued' | 'sent') => {
    setDirectChats((prev) => ({
      ...prev,
      [peerId]: (prev[peerId] || []).map((entry) => (entry.id === messageId ? { ...entry, deliveryStatus } : entry))
    }));
  };

  const addKnownPeer = async (peerId: string) => {
    if (!peerId || peerId === identity?.id) return;
    if (!isValidPeerFingerprint(peerId)) {
      addLog(`Ignoring invalid peer id from network: ${peerId}`);
      return;
    }
    const existing = contactsRef.current.find((c) => c.fingerprint === peerId);
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
    setContacts((prev) => dedupeContactsByFingerprint([...prev, contact]));
  };

  const refreshMessageQueue = async () => {
    const queued = await loadMessageQueue();
    const queueMap: Record<string, QueuedMessage[]> = queued.reduce((acc, message) => {
      acc[message.recipient] = [...(acc[message.recipient] || []), message];
      return acc;
    }, {} as Record<string, QueuedMessage[]>);
    messageQueueRef.current = queueMap;
    setMessageQueue(queueMap);
    setContacts((prev) => prev.map((contact) => ({
      ...contact,
      queuedMessages: queueMap[contact.fingerprint]?.length ?? 0
    })));
  };

  const queuePeerMessage = async (peerId: string, text: string, chatMessageId?: string) => {
    const queuedMessageId = `${peerId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const queuedMessage: QueuedMessage = {
      id: queuedMessageId,
      recipient: peerId,
      text,
      timestamp: new Date().toISOString(),
      status: 'queued',
      chatMessageId
    };
    await saveMessageQueue(queuedMessage);
    const nextQueue = {
      ...(messageQueueRef.current ?? {}),
      [peerId]: [...(messageQueueRef.current?.[peerId] || []), queuedMessage]
    };
    messageQueueRef.current = nextQueue;
    setMessageQueue(nextQueue);
    updateContactState(peerId, { queuedMessages: (contacts.find((c) => c.fingerprint === peerId)?.queuedMessages || 0) + 1 });
    addLog(`Queued direct message for ${peerId}: ${text.slice(0, 80)}`);
    return queuedMessageId;
  };

  const flushQueuedMessages = async (peerId: string) => {
    const manager = peerManagersRef.current[peerId];
    const queued = messageQueueRef.current[peerId] ?? [];
    if (!manager) {
      addLog(`Queue flush skipped for ${peerId}: no peer manager`);
      return;
    }
    if (!queued.length) {
      addLog(`Queue flush skipped for ${peerId}: no queued messages`);
      return;
    }
    if (!manager.isDataChannelOpen()) {
      addLog(`Queue flush skipped for ${peerId}: data channel state=${manager.getDataChannelState()}`);
      return;
    }

    addLog(`Flushing ${queued.length} queued messages to ${peerId}`);
    for (const queuedMessage of queued) {
      manager.sendChatMessage(queuedMessage.text);
      await deleteMessageQueue(queuedMessage.id);
      if (queuedMessage.chatMessageId) {
        await updateDirectChatMessageStatus(queuedMessage.chatMessageId, 'sent');
        markDirectMessageDelivered(peerId, queuedMessage.chatMessageId, 'sent');
      }
      addLog(`Queued message sent to ${peerId}: ${queuedMessage.text.slice(0, 80)}`);
    }

    const nextQueue = { ...(messageQueueRef.current ?? {}) };
    delete nextQueue[peerId];
    messageQueueRef.current = nextQueue;
    setMessageQueue(nextQueue);
    updateContactState(peerId, { queuedMessages: 0 });
    addLog(`Delivered ${queued.length} queued messages to ${peerId}`);
  };

  const ensurePeerManager = (peerId: string) => {
    const existing = peerManagersRef.current[peerId];
    if (existing) {
      const state = existing.getDataChannelState();
      if (state === 'open' || state === 'connecting') {
        return existing;
      }
      delete peerManagersRef.current[peerId];
    }
    if (!identity) return null;

    const packetSigner = async (packet: {
      protocol: 'mycelium';
      version: 1;
      id: string;
      type: string;
      timestamp: string;
      sender: string;
      recipient: string | null;
      payload: Record<string, unknown>;
    }) => signString(identity.privateKey, canonicalize(packet));

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
        if (!isValidPeerFingerprint(peer)) {
          addLog(`Ignoring direct message from invalid peer id: ${peer}`);
          return;
        }

        addLog(`Direct message received from ${peer}: ${incoming.slice(0, 80)}`);
        saveDirectMessage(peer, incoming, true);
        const chatIsOpenForPeer = pageRef.current === 'chat' && chatContactIdRef.current === peer;
        if (!chatIsOpenForPeer) {
          setContacts((prev) => prev.map((contact) => (
            contact.fingerprint === peer
              ? { ...contact, unreadMessages: (contact.unreadMessages || 0) + 1 }
              : contact
          )));
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
        if (!isValidPeerFingerprint(peer)) {
          addLog(`Ignoring profile metadata from invalid peer id: ${peer}`);
          return;
        }
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
        addLog(`Peer ${peer} data channel open`);
        const manager = peerManagersRef.current[peer];
        if (manager) {
          manager.sendMetadata(buildPeerMetadata(peer));
          manager.sendRequestPosts();
        }
        await flushQueuedMessages(peer);
      },
      (peer: string) => {
        // Remove dead manager so reconnect creates a fresh RTCPeerConnection
        delete peerManagersRef.current[peer];
        if (selectedContactIdRef.current === peer) {
          setDataChannelOpen(false);
          setActivePeerId(null);
        }
        updateContactState(peer, { connected: false, lastConnectionStatus: 'disconnected' });
      },
      (peer: string, event: string) => {
        addLog(`Peer ${peer}: ${event}`);
      },
      (peer: string) => {
        // Respond to PROFILE_REQUEST with our current profile
        const manager = peerManagersRef.current[peer];
        if (manager) {
          manager.sendMetadata(buildPeerMetadata(peer));
          addLog(`Sent profile to ${peer} (on request)`);
        }
      },
      async (peer: string, messageId: string) => {
        const timerId = outboundAckTimersRef.current[messageId];
        if (timerId) {
          window.clearTimeout(timerId);
          delete outboundAckTimersRef.current[messageId];
        }
        await updateDirectChatMessageStatus(messageId, 'sent');
        markDirectMessageDelivered(peer, messageId, 'sent');
      },
      packetSigner
    );

    peerManagersRef.current[peerId] = manager;
    return manager;
  };

  const registerMessageAckTimeout = (peerId: string, messageId: string, text: string) => {
    if (outboundAckTimersRef.current[messageId]) {
      window.clearTimeout(outboundAckTimersRef.current[messageId]);
    }

    outboundAckTimersRef.current[messageId] = window.setTimeout(async () => {
      const alreadyQueued = messageQueueRef.current[peerId]?.some((entry) => entry.chatMessageId === messageId);
      if (alreadyQueued) {
        return;
      }

      await queuePeerMessage(peerId, text, messageId);
      await updateDirectChatMessageStatus(messageId, 'queued');
      markDirectMessageDelivered(peerId, messageId, 'queued');
      const socket = signallingSocketRef.current;
      const manager = peerManagersRef.current[peerId] ?? ensurePeerManager(peerId);
      if (socket && socket.readyState === WebSocket.OPEN && manager) {
        manager.createOffer(peerId, socket);
      }
    }, 5000);
  };

  const handlePeerList = async (peers: string[]) => {
    const validPeers = peers.filter((peerId) => isValidPeerFingerprint(peerId));
    const invalidPeers = peers.filter((peerId) => !isValidPeerFingerprint(peerId));
    if (invalidPeers.length) {
      addLog(`Ignoring ${invalidPeers.length} invalid peer ids from peer-list`);
    }

    await Promise.all(validPeers.map((peerId) => addKnownPeer(peerId)));

    setContacts((prev) =>
      dedupeContactsByFingerprint(prev).map((contact) => ({
        ...contact,
        online: validPeers.includes(contact.fingerprint)
      }))
    );

    const socket = signallingSocketRef.current;
    validPeers.forEach((peerId) => {
      if (!peerId || peerId === identity?.id) return;
      const contact = contactsRef.current.find((c) => c.fingerprint === peerId);
      const manager = ensurePeerManager(peerId);
      if (socket && socket.readyState === WebSocket.OPEN && manager && !contact?.connected) {
        manager.createOffer(peerId, socket);
      }
    });

    for (const peerId of validPeers) {
      if (messageQueueRef.current[peerId]?.length) {
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
      const rawProfile = localStorage.getItem('myProfile');
      if (rawProfile) {
        try {
          const parsed = JSON.parse(rawProfile);
          if (typeof parsed.displayName === 'string' || typeof parsed.bio === 'string' || parsed.feedMix) {
            const parsedFeedMix = parsed.feedMix && typeof parsed.feedMix === 'object'
              ? {
                  followedAuthors: Number(parsed.feedMix.followedAuthors ?? DEFAULT_FEED_MIX.followedAuthors),
                  followedLikes: Number(parsed.feedMix.followedLikes ?? DEFAULT_FEED_MIX.followedLikes),
                  discoveryRandom: Number(parsed.feedMix.discoveryRandom ?? DEFAULT_FEED_MIX.discoveryRandom)
                }
              : DEFAULT_FEED_MIX;
            setMyProfile({
              displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
              bio: typeof parsed.bio === 'string' ? parsed.bio : '',
              feedMix: {
                followedAuthors: Math.max(0, parsedFeedMix.followedAuthors),
                followedLikes: Math.max(0, parsedFeedMix.followedLikes),
                discoveryRandom: Math.max(0, parsedFeedMix.discoveryRandom)
              }
            });
          }
        } catch {
          addLog('Saved profile settings could not be parsed; using defaults.');
        }
      }
    }
    bootstrap();
  }, []);

  useEffect(() => {
    async function loadLocalData() {
      const cs = await loadContacts();
      setContacts(dedupeContactsByFingerprint(cs || []));
      const ps = await loadPosts();
      setPosts(ps || []);
      const loadedDirectMessages = await loadDirectChatMessages();
      const groupedDirectMessages = loadedDirectMessages.reduce((acc, message) => {
        acc[message.peerId] = [
          ...(acc[message.peerId] || []),
          {
            text: message.text,
            timestamp: message.timestamp,
            isMine: message.isMine,
            deliveryStatus: message.deliveryStatus
          }
        ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        return acc;
      }, {} as Record<string, ChatEntry[]>);
      setDirectChats(groupedDirectMessages);
      await refreshMessageQueue();
    }
    loadLocalData();
  }, []);

  useEffect(() => {
    const deduped = dedupeContactsByFingerprint(contacts);
    if (deduped.length === contacts.length) return;

    addLog(`Deduplicated ${contacts.length - deduped.length} duplicate contacts`);
    setContacts(deduped);

    void (async () => {
      const seenFingerprints = new Set<string>();
      for (const contact of contacts) {
        if (seenFingerprints.has(contact.fingerprint)) {
          await deleteContact(contact.publicKey);
          continue;
        }
        seenFingerprints.add(contact.fingerprint);
      }

      for (const contact of deduped) {
        await saveContact(contact);
      }
    })();
  }, [contacts]);

  useEffect(() => {
    const invalidContacts = contacts.filter((contact) => !isValidPeerFingerprint(contact.fingerprint));
    if (!invalidContacts.length) return;

    addLog(`Removing ${invalidContacts.length} invalid contacts from local state`);
    setContacts((prev) => prev.filter((contact) => isValidPeerFingerprint(contact.fingerprint)));

    void (async () => {
      for (const contact of invalidContacts) {
        await deleteContact(contact.publicKey);
      }
    })();
  }, [contacts]);

  useEffect(() => {
    if (!identity?.id) return;

    suppressReconnectRef.current = false;
    const signalUrl = resolveSignalServerUrl();
    addLog(`Connecting to signalling endpoint: ${signalUrl}`);

    const socket = connectToSignalling(
      identity.id,
      async (message: SignalMessage) => {
        if (message.type === 'peer-list') {
          handlePeerList(message.peers);
          return;
        }

        if (message.type === 'discovery-result') {
          handleDiscoveryResult(message.packet);
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
        if (status === 'connected' && reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        if (!suppressReconnectRef.current && (status === 'error' || status === 'closed') && reconnectTimerRef.current === null) {
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            setSignallingReconnectTick((prev) => prev + 1);
            addLog('Retrying signalling connection');
          }, 3000);
        }
      }
    );

    signallingSocketRef.current = socket;
    return () => {
      suppressReconnectRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.close();
    };
  }, [identity, signallingReconnectTick]);

  useEffect(() => {
    if (!identity?.id) return;
    const interval = window.setInterval(() => {
      const socket = signallingSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      dedupeContactsByFingerprint(contactsRef.current).forEach((contact) => {
        if (!contact.fingerprint || contact.fingerprint === identity.id) return;
        const hasQueuedMessages = (messageQueueRef.current[contact.fingerprint]?.length ?? 0) > 0;

        if ((contact.online || hasQueuedMessages) && !contact.connected && contact.lastConnectionStatus !== 'signalling' && contact.lastConnectionStatus !== 'connecting') {
          const manager = ensurePeerManager(contact.fingerprint);
          if (manager) {
            addLog(`Reconnect attempt to ${contact.fingerprint}`);
            manager.createOffer(contact.fingerprint, socket);
          }
        }
      });
    }, 30000);

    return () => window.clearInterval(interval);
  }, [identity]);

  useEffect(() => {
    if (!identity?.id) return;
    void handleFetchDiscovery();
  }, [identity?.id]);

  useEffect(() => {
    if (page !== 'discover' || discoveryPosts.length > 0) return;
    void handleFetchDiscovery();
  }, [page, discoveryPosts.length]);

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

  async function handleAddPeerByAddress(address: string) {
    if (!identity) return;
    const normalized = address.trim();
    if (!normalized) return;

    let fingerprint = normalized;
    let publicKey = normalized;

    if (!normalized.includes(':') && !normalized.startsWith('myc:') && normalized.length > 40) {
      try {
        fingerprint = await deriveFingerprint(normalized);
      } catch {
        fingerprint = normalized;
      }
    }

    const existing = contacts.find((contact) => contact.fingerprint === fingerprint || contact.publicKey === publicKey);
    const contact: Contact = {
      publicKey,
      fingerprint,
      displayName: existing?.displayName,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      followed: existing?.followed ?? false,
      follower: existing?.follower,
      online: existing?.online ?? false,
      connected: existing?.connected ?? false,
      unreadMessages: existing?.unreadMessages ?? 0,
      queuedMessages: existing?.queuedMessages ?? 0,
      lastConnectionStatus: existing?.lastConnectionStatus,
      lastSeen: existing?.lastSeen,
      profile: existing?.profile
    };

    await saveContact(contact);
    setContacts((prev) => {
      const filtered = prev.filter((entry) => entry.fingerprint !== fingerprint);
      return dedupeContactsByFingerprint([...filtered, contact]);
    });

    addLog(`Added peer address ${fingerprint}`);

    const socket = signallingSocketRef.current;
    const manager = ensurePeerManager(fingerprint);
    if (socket && socket.readyState === WebSocket.OPEN && manager) {
      manager.createOffer(fingerprint, socket);
      addLog(`Attempting connection to ${fingerprint}`);
    } else {
      addLog('Peer added. Waiting for signalling connection to connect.');
    }
  }

  async function handleToggleFollow(publicKey: string) {
    const existing = contactsRef.current.find((c) => c.publicKey === publicKey);
    if (!existing) return;
    const updated = { ...existing, followed: !existing.followed };
    await saveContact(updated);
    setContacts((prev) => dedupeContactsByFingerprint(prev.map((c) => (c.publicKey === publicKey ? updated : c))));
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
    const content = newPostContent.trim();
    if (!content) return;
    const id = await sha256(identity.publicKey + Date.now().toString());
    const tags = newPostTags.split(',').map((t) => t.trim()).filter(Boolean);
    const signed = await createSignedPost(id, identity.publicKey, identity.privateKey, content, tags);
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
      const socket = signallingSocketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          await publishPost(signed, socket);
          addLog('Published post to discovery');
        } catch (err: any) {
          addLog(`Discovery publish failed: ${err.message}`);
        }
      } else {
        addLog('Discovery publish skipped: not connected to signalling server');
      }
    }
  }

  const visibleDiscoveryPosts = discoveryPosts.filter((post) => !hiddenDiscoveryIds.has(post.id));

  const discoverFeedPosts = useMemo(() => {
    return [...visibleDiscoveryPosts].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [visibleDiscoveryPosts]);

  const visibleHomePosts = useMemo(() => {
    const followedSet = new Set(
      contacts
        .filter((contact) => contact.followed)
        .map((contact) => contact.fingerprint)
    );

    const authoredByFollowed = posts
      .filter((post) => !hiddenPostIds.has(post.id))
      .filter((post) => followedSet.has(post.author))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const likeEventsByFollowed = posts
      .filter((post) => !hiddenPostIds.has(post.id))
      .filter((post) => followedSet.has(post.author) && post.reaction === 'like')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const allKnownPosts = [...posts, ...visibleDiscoveryPosts];
    const likedByFollowed = likeEventsByFollowed.map((likeEvent) => {
      if (!likeEvent.repostOf) return likeEvent;
      return allKnownPosts.find((candidate) => candidate.id === likeEvent.repostOf) ?? likeEvent;
    });

    const randomDiscovery = [...visibleDiscoveryPosts];
    for (let i = randomDiscovery.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [randomDiscovery[i], randomDiscovery[j]] = [randomDiscovery[j], randomDiscovery[i]];
    }

    const totalRatio = Math.max(1, myProfile.feedMix.followedAuthors + myProfile.feedMix.followedLikes + myProfile.feedMix.discoveryRandom);
    const totalItems = 30;

    const authoredQuota = Math.floor((totalItems * myProfile.feedMix.followedAuthors) / totalRatio);
    const likedQuota = Math.floor((totalItems * myProfile.feedMix.followedLikes) / totalRatio);
    const discoveryQuota = Math.max(0, totalItems - authoredQuota - likedQuota);

    const selected: StoredPost[] = [];
    const seen = new Set<string>();

    const take = (source: StoredPost[], maxItems: number) => {
      let remaining = maxItems;
      for (const item of source) {
        if (selected.length >= totalItems || remaining <= 0) break;
        if (seen.has(item.id)) continue;
        selected.push(item);
        seen.add(item.id);
        remaining -= 1;
      }
    };

    take(authoredByFollowed, authoredQuota);
    take(likedByFollowed, likedQuota);
    take(randomDiscovery, discoveryQuota);

    const fallback = [...authoredByFollowed, ...likedByFollowed, ...randomDiscovery]
      .filter((item) => !seen.has(item.id))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    for (const item of fallback) {
      if (selected.length >= totalItems) break;
      selected.push(item);
      seen.add(item.id);
    }

    return selected.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [posts, visibleDiscoveryPosts, hiddenPostIds, contacts, myProfile.feedMix]);

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
    const socket = signallingSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      addLog('Discovery fetch skipped: not connected to signalling server');
      return;
    }
    addLog('Refreshing discovery posts');
    try {
      const items = await fetchDiscovery(socket, 20);
      const verifiedPosts = await Promise.all(items.map(async (post) => {
        try {
          const valid = await verifySignedPost(post);
          return {
            ...post,
            source: 'discovery' as const,
            receivedAt: new Date().toISOString(),
            valid
          };
        } catch {
          return {
            ...post,
            source: 'discovery' as const,
            receivedAt: new Date().toISOString(),
            valid: false
          };
        }
      }));
      setDiscoveryPosts(verifiedPosts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      addLog(`Fetched ${verifiedPosts.length} discovery posts`);
    } catch (err: any) {
      const message = err?.message || String(err);
      addLog(`Discovery fetch failed (${signalEndpoint}): ${message}`);
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

  async function handleImportIdentity() {
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
          addLog('Identity imported successfully');
        } else {
          addLog('Identity import failed: invalid file format');
        }
      } catch {
        addLog('Identity import failed: invalid JSON');
      }
    };
    input.click();
  }

  async function handleClearIdentity() {
    const confirmed = window.confirm(
      'Warning: clearing this identity logs you out on this browser. Export your identity backup first, or you may lose access permanently. Continue?'
    );
    if (!confirmed) return;

    await deleteIdentity();
    await clearDirectChatMessages();
    signallingSocketRef.current?.close();
    peerManagersRef.current = {};
    setIdentity(null);
    setContacts([]);
    setPosts([]);
    setDiscoveryPosts([]);
    setDirectChats({});
    setMessageQueue({});
    setSelectedContactId(null);
    setChatContactId(null);
    setActivePeerId(null);
    setConnectionStatus('idle');
    setSignallingStatus('idle');
    setPage('home');
  }

  function handleStartCall() {
    const socket = signallingSocketRef.current;
    const normalizedRemoteId = remoteId.trim();
    if (!socket || !normalizedRemoteId) return;
    const manager = ensurePeerManager(normalizedRemoteId);
    if (!manager) return;
    setRemoteId(normalizedRemoteId);
    setSelectedContactId(normalizedRemoteId);
    setChatContactId(normalizedRemoteId);
    addLog(`Starting call to ${normalizedRemoteId}`);
    manager.createOffer(normalizedRemoteId, socket);
  }

  function handleSelectContact(peerId: string) {
    setSelectedContactId(peerId);
    setChatContactId(peerId);
    setPage('chat');
    addLog(`Selected contact ${peerId}`);
    updateContactState(peerId, { unreadMessages: 0 });

    const socket = signallingSocketRef.current;
    const manager = ensurePeerManager(peerId);
    const targetContact = contacts.find((contact) => contact.fingerprint === peerId);
    if (socket && socket.readyState === WebSocket.OPEN && manager && !targetContact?.connected) {
      manager.createOffer(peerId, socket);
      addLog(`Opening chat and connecting to ${peerId}`);
    }
  }

  useEffect(() => {
    const handleShutdown = () => {
      Object.values(peerManagersRef.current).forEach((manager) => manager.closeConnection());
      Object.values(outboundAckTimersRef.current).forEach((timerId) => window.clearTimeout(timerId));
      outboundAckTimersRef.current = {};
    };

    window.addEventListener('beforeunload', handleShutdown);
    window.addEventListener('pagehide', handleShutdown);

    return () => {
      window.removeEventListener('beforeunload', handleShutdown);
      window.removeEventListener('pagehide', handleShutdown);
      handleShutdown();
    };
  }, []);

  async function handleSendDirectMessage() {
    addLog(`Direct message button pressed: chatContact=${chatContactId ?? 'none'} draftLength=${message.trim().length}`);
    if (!chatContactId) {
      addLog('Direct message aborted: no active chat contact');
      return;
    }
    if (!message.trim()) {
      addLog('Direct message aborted: empty draft');
      return;
    }
    const peerId = chatContactId;
    const trimmedMessage = message.trim();
    const manager = peerManagersRef.current[peerId];
    const targetContact = contacts.find((contact) => contact.fingerprint === peerId);
    const channelState = manager?.getDataChannelState() ?? 'missing';
    const canSendImmediately = Boolean(
      manager &&
      targetContact?.connected &&
      manager.isDataChannelOpen()
    );

    addLog(
      `Direct message send attempt to ${peerId}: connected=${targetContact?.connected ? 'yes' : 'no'} activePeer=${activePeerId ?? 'none'} channel=${channelState}`
    );

    if (canSendImmediately && manager) {
      const messageId = saveDirectMessage(peerId, trimmedMessage, false, 'sent');
      manager.sendChatMessage(trimmedMessage);
      registerMessageAckTimeout(peerId, messageId, trimmedMessage);
      addLog(`Sent direct message to ${peerId}`);
    } else {
      const messageId = saveDirectMessage(peerId, trimmedMessage, false, 'queued');
      const queuedMessageId = await queuePeerMessage(peerId, trimmedMessage, messageId);
      await saveMessageQueue({
        id: queuedMessageId,
        recipient: peerId,
        text: trimmedMessage,
        timestamp: new Date().toISOString(),
        status: 'queued',
        chatMessageId: messageId
      });
      const socket = signallingSocketRef.current;
      const lazyManager = manager ?? ensurePeerManager(peerId);
      if (socket && socket.readyState === WebSocket.OPEN && lazyManager) {
        lazyManager.createOffer(peerId, socket);
        addLog(`Queued message and requested data channel to ${peerId}`);
      }
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

  if (!identity) {
    return (
      <LandingPage
        onCreateIdentity={handleCreateIdentity}
        onImportIdentity={handleImportIdentity}
      />
    );
  }

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
      />

      <main id="page-content" className={`page-content${page === 'chat' ? ' chat-active' : ''}`}>
        {page === 'home' && (
          <HomePage
            posts={visibleHomePosts}
            contacts={contacts}
            postText={newPostContent}
            onPostTextChange={setNewPostContent}
            onSubmitPost={handleCreatePost}
            onRefreshPosts={handleFetchDiscovery}
            canCreatePost={Boolean(identity)}
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
            onMessage={handleSelectContact}
            onToggleFollow={handleToggleFollow}
            onAddPeerAddress={handleAddPeerByAddress}
          />
        )}

        {page === 'discover' && (
          <DiscoverPage
            discoveryPosts={discoverFeedPosts}
            onRefreshDiscovery={handleFetchDiscovery}
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
            onMessage={() => handleSelectContact(activeProfileContact.fingerprint)}
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
            followedAuthorsRatio={myProfile.feedMix.followedAuthors}
            followedLikesRatio={myProfile.feedMix.followedLikes}
            discoveryRatio={myProfile.feedMix.discoveryRandom}
            onNicknameChange={(value) => setMyProfile((prev) => ({ ...prev, displayName: value }))}
            onBioChange={(value) => setMyProfile((prev) => ({ ...prev, bio: value }))}
            onFollowedAuthorsRatioChange={(value) => setMyProfile((prev) => ({
              ...prev,
              feedMix: { ...prev.feedMix, followedAuthors: Math.max(0, value) }
            }))}
            onFollowedLikesRatioChange={(value) => setMyProfile((prev) => ({
              ...prev,
              feedMix: { ...prev.feedMix, followedLikes: Math.max(0, value) }
            }))}
            onDiscoveryRatioChange={(value) => setMyProfile((prev) => ({
              ...prev,
              feedMix: { ...prev.feedMix, discoveryRandom: Math.max(0, value) }
            }))}
            onSaveProfile={() => {
              localStorage.setItem('myProfile', JSON.stringify(myProfile));
              addLog('Profile saved locally');
              contacts.forEach((contact) => {
                if (!contact.connected) return;
                peerManagersRef.current[contact.fingerprint]?.sendMetadata(buildPeerMetadata(contact.fingerprint));
              });
            }}
            onExportIdentity={handleExportIdentity}
            onImportIdentity={handleImportIdentity}
            onCreateIdentity={handleCreateIdentity}
            onClearIdentity={handleClearIdentity}
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
            logs={logs}
            onClearLogs={() => setLogs([])}
            signalEndpoint={signalEndpoint}
            discoveryEndpoint={discoveryEndpoint}
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
