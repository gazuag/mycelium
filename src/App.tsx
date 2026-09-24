import { useEffect, useMemo, useRef, useState } from 'react';
import { generateIdentityKeyPair, deriveFingerprint, exportPrivateKey, exportPublicKey, sha256, signString } from './crypto/identity';
import { connectToSignalling, resolveSignalServerUrl, SignalMessage } from './p2p/signalling';
import { PeerConnectionManager } from './p2p/webrtc';
import { closeAndRemovePeerManager } from './p2p/peer-manager-registry';
import { PeerConnectionObjectTransport } from './p2p/object-transport';
import { loadIdentity, saveIdentity, deleteIdentity, loadContacts, saveContact, deleteContact, saveDiscoveryInteraction, loadDiscoveryInteractions, saveMessageQueue, loadMessageQueue, deleteMessageQueue, saveDirectChatMessage, loadDirectChatMessages, clearDirectChatMessages, clearAllLocalData, updateDirectChatMessageStatus, saveProfile, loadProfile, deleteDirectChatMessage } from './storage/idb';
import { fetchDiscovery, handleDiscoveryResult, publishObject } from './services/discovery';
import { AppHeader } from './components/AppHeader';
import { TabBar } from './components/TabBar';
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { PeoplePage } from './pages/PeoplePage';
import { ProfilePage } from './pages/ProfilePage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { LandingPage } from './pages/LandingPage';
import { BlockedPeerList } from './components/BlockedPeerList';
import { HiddenPostList } from './components/HiddenPostList';
import { CollapsibleSection } from './components/CollapsibleSection';
import { canonicalize, type PacketSigner } from './p2p/protocol';
import { buildFindPacket, buildFindResponseObjectsPacket, buildFindResponsePacket, buildObjectBatchPacket, buildObjectStorePacket, buildTimeRangeFindPacket, createLocalPostView, createObjectIdentity, createReplyObjectPayload, createSignedObject, createSignedRecommendationObject, filterObjectsByFindQuery, findObject, findObjects, FindAggregation, getFindObjectIds, hydratePostViews, IndexedDbLocalPostMetadataStore, IndexedDbObjectStore, IndexedDbRecommendationSequenceStore, localPostMetadata, mergeLocalPostViews, queryFeedObjectsForPeer, RecommendationIndex, receiveObjectPacket, respondToFindPacket, selectFindPeers, selectFollowedPosts, sendReplyToAuthor, shouldRetainFindRequestRoute, upsertLocalPostView, validateFindResponseObjects, validateObject, type DistributedObject, type LocalPostMetadataStore, type LocalPostView, type ObjectPacket, type ObjectStore, type PostObject, type RecommendationSummary } from './object-layer';
import { fingerprintToHumanName } from './utils/fingerprintNames';
import { acknowledgeMessage, registerMessageAckTimeout as scheduleMessageAckTimeout } from './services/message-ack';
import type { ConnectionState, Contact, PeerMetadata, QueuedMessage } from './types';

interface IdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id: string;
}

export type LogCategory = 'pingPong' | 'discovery' | 'chat' | 'postRequests' | 'objectStorage' | 'ice' | 'general';
export interface LogEntry {
  text: string;
  category: LogCategory;
}

function classifyLogEntry(entry: string): LogCategory {
  if (/\b(PING|PONG|ping loop|keep.?alive)\b/i.test(entry)) return 'pingPong';
  if (/\bDISCOVERY\b|discovery/i.test(entry)) return 'discovery';
  if (/\bICE\b|candidate pair|candidate-pair/i.test(entry)) return 'ice';
  if (/\b(OBJECT|FIND|generic object)\b|PHASE ?[67]/i.test(entry)) return 'objectStorage';
  if (/\b(chat|message|messages)\b/i.test(entry)) return 'chat';
  if (/\b(post|posts|feed|recommendation|home updates)\b/i.test(entry)) return 'postRequests';
  return 'general';
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
  followedLikes: 40,
  discoveryRandom: 0
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
  const postViewsRef = useRef<LocalPostView[]>([]);
  const messageQueueRef = useRef<Record<string, QueuedMessage[]>>({});
  const outboundAckTimersRef = useRef<Record<string, number>>({});
  const outboundChatMessageIdsRef = useRef<Record<string, string>>({});
  const recentOutboundMessageKeysRef = useRef<Record<string, Set<string>>>({});
  const pageRef = useRef<PageKey>('home');
  const chatContactIdRef = useRef<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>('idle');
  const [signallingStatus, setSignallingStatus] = useState('idle');
  const [connectedPeerIds, setConnectedPeerIds] = useState<string[]>([]);
  const [signallingReconnectTick, setSignallingReconnectTick] = useState(0);
  const [remoteId, setRemoteId] = useState('');
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [dataChannelOpen, setDataChannelOpen] = useState(false);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [directChats, setDirectChats] = useState<Record<string, ChatEntry[]>>({});
  const [messageQueue, setMessageQueue] = useState<Record<string, QueuedMessage[]>>({});
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [postViews, setPostViews] = useState<LocalPostView[]>([]);
  const [page, setPage] = useState<PageKey>('home');
  const [profileContactId, setProfileContactId] = useState<string | null>(null);
  const [chatContactId, setChatContactId] = useState<string | null>(null);
  const [collapsedHeader, setCollapsedHeader] = useState<boolean>(() => localStorage.getItem('myceliumHeaderCollapsed') === 'true');
  const [hiddenPostIds, setHiddenPostIds] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('hiddenPosts') || '[]')));
  const [hiddenDiscoveryIds, setHiddenDiscoveryIds] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('hiddenDiscovery') || '[]')));
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [blockedPeersOpen, setBlockedPeersOpen] = useState(false);
  const [hiddenPostsOpen, setHiddenPostsOpen] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const blockedPeersRef = useRef<Set<string>>(new Set());
  const [myProfile, setMyProfile] = useState({
    displayName: '',
    bio: '',
    feedMix: DEFAULT_FEED_MIX,
    blockedPeers: [] as string[],
    hiddenPeers: [] as string[]
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
  const [discoveryPosts, setDiscoveryPosts] = useState<LocalPostView[]>([]);
    const [recommendationRevision, setRecommendationRevision] = useState(0);
  const [homeSyncBusy, setHomeSyncBusy] = useState(false);
  const [newPostContent, setNewPostContent] = useState('');
  const [newPostTags, setNewPostTags] = useState('');
  const [objectTestPeerId, setObjectTestPeerId] = useState('');
  const [objectTestStoragePeerId, setObjectTestStoragePeerId] = useState('');
  const [objectTestStatus, setObjectTestStatus] = useState('');
  const [objectTestIds, setObjectTestIds] = useState('');
  const [suppressPhase6FindResponses, setSuppressPhase6FindResponses] = useState(false);
  const [objectTestLastId, setObjectTestLastId] = useState<string | null>(null);
  const [phase7Author, setPhase7Author] = useState('');
  const [phase7StartTime, setPhase7StartTime] = useState('10:03');
  const [phase7EndTime, setPhase7EndTime] = useState('10:09');
  const [phase7QueryStatus, setPhase7QueryStatus] = useState('');
  const [phase7SelectedObjectId, setPhase7SelectedObjectId] = useState('');
  const [phase7Results, setPhase7Results] = useState<Array<{ object_id: string; created_at: string; author: string }>>([]);
  const [phase7RequestId, setPhase7RequestId] = useState('');
  const [objectStoreObjects, setObjectStoreObjects] = useState<Array<{ object_id: string; object_type: string; author: string; created_at: string; payload: unknown }>>([]);
  const lastObjectTestRef = useRef<Awaited<ReturnType<typeof createSignedObject>> | null>(null);
  const selectedContactIdRef = useRef<string | null>(null);
  const myProfileRef = useRef({ displayName: '', bio: '', feedMix: DEFAULT_FEED_MIX });
  const identityRef = useRef<IdentityRecord | null>(null);
  const objectStoreRef = useRef<ObjectStore | null>(null);
  const localPostMetadataStoreRef = useRef<LocalPostMetadataStore | null>(null);
  const recommendationSequenceStoreRef = useRef<IndexedDbRecommendationSequenceStore | null>(null);
  const recommendationIndexRef = useRef(new RecommendationIndex());
  const objectTransportRef = useRef<PeerConnectionObjectTransport | null>(null);
  const findRequestCacheRef = useRef<Map<string, number>>(new Map());
  const findRequestRouteRef = useRef<Map<string, { upstreamPeer: string; expiresAt: number }>>(new Map());
  const findAggregationRef = useRef<Map<string, { aggregation: FindAggregation; requestedObjectIds: Set<string>; upstreamPeer: string; origin: string; expiresAt: string }>>(new Map());
  const suppressPhase6FindResponsesRef = useRef(false);

  if (!objectStoreRef.current) {
    objectStoreRef.current = new IndexedDbObjectStore();
  }
  if (!localPostMetadataStoreRef.current) {
    localPostMetadataStoreRef.current = new IndexedDbLocalPostMetadataStore();
  }
  if (!recommendationSequenceStoreRef.current) {
    recommendationSequenceStoreRef.current = new IndexedDbRecommendationSequenceStore();
  }
  if (!objectTransportRef.current) {
    objectTransportRef.current = new PeerConnectionObjectTransport(() => peerManagersRef.current);
  }

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
    postViewsRef.current = postViews;
  }, [postViews]);

  useEffect(() => {
    const objectStore = objectStoreRef.current;
    const metadataStore = localPostMetadataStoreRef.current;
    if (!objectStore || !metadataStore) return;
    void hydratePostViews(objectStore, metadataStore, (error) => {
      addLog(`Post hydration failed: ${error instanceof Error ? error.message : String(error)}`);
    }, resolvePostAuthorFingerprint).then((hydratedViews) => {
      const hydratedWithMetadata = hydratedViews.filter((view) => view.authorDisplayName !== undefined || view.notInterested !== undefined || view.hidden !== undefined).length;
      addLog(`Hydrated ${hydratedViews.length} posts from storage (${hydratedWithMetadata} with metadata)`);
      setPostViews((prev) => mergeLocalPostViews(prev, hydratedViews));
    });
  }, []);

  useEffect(() => {
    const store = objectStoreRef.current;
    if (!store) return;
    void store.query({ object_type: 'mycelium.recommendation' }).then((objects) => {
      recommendationIndexRef.current.rebuild(objects);
    });
  }, []);

  const getRecommendationSummary = (postId: string): RecommendationSummary => {
    const followedAuthors = contactsRef.current.filter((contact) => contact.followed).map((contact) => contact.publicKey);
    return recommendationIndexRef.current.getSummary(postId, followedAuthors, identityRef.current?.publicKey);
  };

  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  useEffect(() => {
    myProfileRef.current = myProfile;
  }, [myProfile]);

  useEffect(() => {
    blockedPeersRef.current = new Set(myProfile.blockedPeers);
  }, [myProfile.blockedPeers]);

  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    suppressPhase6FindResponsesRef.current = suppressPhase6FindResponses;
  }, [suppressPhase6FindResponses]);

  useEffect(() => {
    const refreshConnectedPeers = () => {
      const next = (objectTransportRef.current?.connectedPeers() ?? []).sort();
      setConnectedPeerIds((previous) => (
        previous.length === next.length && previous.every((peerId, index) => peerId === next[index])
          ? previous
          : next
      ));
    };
    refreshConnectedPeers();
    const timer = window.setInterval(refreshConnectedPeers, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedContact = selectedContactId ? contacts.find((c) => c.fingerprint === selectedContactId) : undefined;

  const addLog = (entry: string) => {
    setLogs((prev) => [...prev, { text: `${new Date().toLocaleTimeString()}: ${entry}`, category: classifyLogEntry(entry) }]);
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

  const handleObjectPacket = async (peerId: string, packet: ObjectPacket) => {
    const store = objectStoreRef.current;
    if (!store) return;
    const now = Date.now();
    for (const [requestId, route] of findRequestRouteRef.current.entries()) {
      if (route.expiresAt <= now) {
        addLog(`PHASE6 ROUTE CLEANUP requestId=${requestId} upstream=${route.upstreamPeer} expiresAt=${route.expiresAt} now=${now}`);
        findRequestRouteRef.current.delete(requestId);
      }
    }
    for (const [seenRequestId, expiresAt] of findRequestCacheRef.current.entries()) {
      if (expiresAt <= now) {
        addLog(`PHASE6 CACHE CLEANUP requestId=${seenRequestId} expiresAt=${expiresAt} now=${now}`);
        findRequestCacheRef.current.delete(seenRequestId);
      }
    }
    if (packet.type === 'FIND') {
      const queryFields = packet.payload as { object_type?: string; author?: string; created_after?: string; created_before?: string; since?: string; limit?: number; order?: 'created_at_desc' };
      const isPhase7Query = Boolean(queryFields.object_type || queryFields.author || queryFields.created_after || queryFields.created_before || queryFields.since || queryFields.limit !== undefined || queryFields.order);
      if (isPhase7Query) {
        addLog(`PHASE7 QUERY RECEIVED requestId=${packet.payload.requestId} peer=${peerId} author=${queryFields.author ?? 'unknown'} lower=${queryFields.created_after ?? 'none'} upper=${queryFields.created_before ?? 'none'}`);
      }
      addLog(`FIND ${String(packet.payload.requestId).slice(0, 12)} received`);
      const requestedObjectIds = getFindObjectIds(packet);
      if (requestedObjectIds && (requestedObjectIds.length > 1 || isPhase7Query)) {
        if (suppressPhase6FindResponsesRef.current) {
          addLog(`PHASE 6 FIND response suppressed for deterministic partial test: requestId=${packet.payload.requestId}`);
          return;
        }
        const requestId = packet.payload.requestId;
        const expiresAt = packet.payload.expiresAt;
        const expiresAtMs = Date.parse(expiresAt);
        if (!requestId || Number.isNaN(expiresAtMs) || now >= expiresAtMs || findRequestCacheRef.current.has(requestId)) return;
        findRequestCacheRef.current.set(requestId, expiresAtMs);
        const localObjects = isPhase7Query
          ? await filterObjectsByFindQuery(store, {
            object_type: queryFields.object_type,
            author: queryFields.author,
            created_after: queryFields.created_after,
            created_before: queryFields.created_before,
            since: queryFields.since,
            limit: queryFields.limit,
            order: queryFields.order
          })
          : (await Promise.all(requestedObjectIds.map(async (objectId) => {
            const object = await store.get(objectId);
            return object && await validateObject(object) ? object : null;
          }))).filter((object): object is NonNullable<typeof object> => object !== null);
        const connectedPeers = objectTransportRef.current?.connectedPeers() ?? [];
        const nextPeers = selectFindPeers(connectedPeers, peerId, identityRef.current?.id ?? '', 2);
        const aggregationStartedAt = Date.now();
        addLog(`requested: ${requestedObjectIds.length} objects`);
        addLog(`local results: ${localObjects.length}`);
        addLog(`children selected: ${nextPeers.join(', ') || 'none'}`);
        addLog(`upstream recorded: ${peerId}`);
        let aggregation: FindAggregation;
        aggregation = new FindAggregation(requestedObjectIds, expiresAtMs, async (objects, reason) => {
          addLog('aggregate complete');
          addLog(`reason: ${reason}`);
          addLog(`returning: ${objects.length} objects`);
          addLog(`elapsed: ${Date.now() - aggregationStartedAt}ms`);
          addLog(`PHASE6 AGG COMPLETE callback requestId=${requestId} reason=${reason} objects=${objects.length} upstream=${peerId}`);
          const response = await buildFindResponseObjectsPacket(
            identityRef.current?.id ?? 'unknown',
            peerId,
            requestId,
            objects,
            undefined,
            typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
            expiresAt
          );
          await objectTransportRef.current?.send(peerId, response) ?? Promise.reject(new Error('Object transport is unavailable'));
          addLog(`aggregate sent upstream to ${peerId}`);
          addLog(`PHASE6 AGG CLEANUP BEFORE DELETE requestId=${requestId} aggregationPresent=${findAggregationRef.current.has(requestId)} routePresent=${findRequestRouteRef.current.has(requestId)} cachePresent=${findRequestCacheRef.current.has(requestId)}`);
          findAggregationRef.current.delete(requestId);
          findRequestRouteRef.current.delete(requestId);
          findRequestCacheRef.current.delete(requestId);
          addLog(`PHASE6 AGG CLEANUP AFTER DELETE requestId=${requestId} aggregationPresent=${findAggregationRef.current.has(requestId)} routePresent=${findRequestRouteRef.current.has(requestId)} cachePresent=${findRequestCacheRef.current.has(requestId)}`);
        }, undefined, isPhase7Query);
        findAggregationRef.current.set(requestId, {
          aggregation,
          requestedObjectIds: new Set(requestedObjectIds),
          upstreamPeer: peerId,
          origin: typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
          expiresAt
        });
        findRequestRouteRef.current.set(requestId, { upstreamPeer: peerId, expiresAt: expiresAtMs });
        addLog(`PHASE 6 aggregation state created: requestId=${requestId} upstream=${peerId} requested=${requestedObjectIds.length}`);
        addLog(`PHASE6 AGG CREATED local=${identityRef.current?.id ?? 'unknown'} requestId=${requestId} upstream=${peerId} children=${nextPeers.join(',') || 'none'} requested=${requestedObjectIds.length} localHits=${localObjects.length}`);
        addLog(`PHASE6 AGG STORED requestId=${requestId} aggregationPresent=${findAggregationRef.current.has(requestId)} routePresent=${findRequestRouteRef.current.has(requestId)} cachePresent=${findRequestCacheRef.current.has(requestId)}`);
        for (const nextPeer of nextPeers) aggregation.addChild(nextPeer);
        aggregation.addLocal(localObjects);
        if (!aggregation.isComplete() && (isPhase7Query || requestedObjectIds.some((objectId) => !localObjects.some((object) => object.object_id === objectId))) && packet.payload.ttl > 0) {
          for (const nextPeer of nextPeers) {
            const forwardedPacket = await buildFindPacket(identityRef.current?.id ?? 'unknown', nextPeer, requestedObjectIds, undefined, requestId, packet.payload.ttl - 1, typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender, expiresAt, isPhase7Query ? {
              object_type: queryFields.object_type,
              author: queryFields.author,
              created_after: queryFields.created_after,
              created_before: queryFields.created_before,
              since: queryFields.since,
              limit: queryFields.limit,
              order: queryFields.order
            } : undefined);
            try {
              await objectTransportRef.current?.send(nextPeer, forwardedPacket);
              addLog(`forwarded request to child ${nextPeer}: requestId=${requestId} ttl=${packet.payload.ttl - 1}`);
            } catch {
              addLog(`child ${nextPeer} failed before response`);
              aggregation.failChild(nextPeer);
            }
          }
        } else {
          for (const nextPeer of nextPeers) aggregation.failChild(nextPeer);
        }
        return;
      }
      if (typeof packet.payload?.requestId === 'string' && typeof packet.payload?.expiresAt === 'string') {
        const expiresAtMs = Date.parse(packet.payload.expiresAt);
        if (!Number.isNaN(expiresAtMs) && now < expiresAtMs) {
          findRequestRouteRef.current.set(packet.payload.requestId, { upstreamPeer: peerId, expiresAt: expiresAtMs });
        }
      }
      const handled = await respondToFindPacket(
        packet,
        store,
        async (response) => {
          addLog(`OBJECT FIND_RESPONSE generated: requestId=${response.payload.requestId} object=${response.payload.object ? 'present' : 'missing'} to=${peerId}`);
          const route = response.payload.requestId ? findRequestRouteRef.current.get(response.payload.requestId) : undefined;
          const aggregationState = response.payload.requestId ? findAggregationRef.current.get(response.payload.requestId) : undefined;
          if (route && route.upstreamPeer !== peerId && typeof response.payload.origin === 'string') {
            const relayed = await buildFindResponsePacket(
              identityRef.current?.id ?? 'unknown',
              route.upstreamPeer,
              response.payload.object_id,
              response.payload.requestId,
              response.payload.object,
              undefined,
              response.payload.origin,
              response.payload.expiresAt
            );
            if (!shouldRetainFindRequestRoute(peerId, route, aggregationState)) {
              findRequestRouteRef.current.delete(response.payload.requestId);
            } else {
              addLog(`OBJECT FIND_RESPONSE route retained: requestId=${response.payload.requestId} sender=${peerId} remainingChildren=${aggregationState?.aggregation.pendingChildren().join(', ') || 'none'}`);
            }
            addLog(`OBJECT FIND_RESPONSE relayed: requestId=${response.payload.requestId} ${peerId} -> ${route.upstreamPeer}`);
            await objectTransportRef.current?.send(route.upstreamPeer, relayed);
            return;
          }
          await objectTransportRef.current?.send(peerId, response) ?? Promise.reject(new Error('Object transport is unavailable'));
        },
        identityRef.current?.id ?? 'unknown',
        findRequestCacheRef.current,
        async ({ objectId, requestId, ttl, fromPeer, origin, expiresAt, query }) => {
          addLog(`OBJECT FIND local lookup missed: requestId=${requestId} object=${objectId} ttl=${ttl + 1}`);
          const connectedPeers = objectTransportRef.current?.connectedPeers() ?? [];
          const nextPeers = connectedPeers.filter((candidate) => candidate !== fromPeer && candidate !== identityRef.current?.id);
          if (nextPeers.length === 0) {
            const emptyResponse = await buildFindResponsePacket(
              identityRef.current?.id ?? 'unknown',
              fromPeer,
              objectId,
              requestId,
              undefined,
              undefined,
              origin,
              expiresAt
            );
            findRequestRouteRef.current.delete(requestId);
            await objectTransportRef.current?.send(fromPeer, emptyResponse);
            return;
          }
          const nextPeer = nextPeers[0];
          const forwardedPacket = await buildFindPacket(
            identityRef.current?.id ?? 'unknown',
            nextPeer,
            query ? [] : objectId,
            undefined,
            requestId,
            ttl,
            origin,
            expiresAt,
            query
          );
          findRequestRouteRef.current.set(requestId, { upstreamPeer: fromPeer, expiresAt: Date.parse(expiresAt) });
          addLog(`OBJECT FIND forwarded: requestId=${requestId} ${fromPeer} -> ${nextPeer} ttl=${ttl} expiresAt=${expiresAt}`);
          try {
            await objectTransportRef.current?.send(nextPeer, forwardedPacket);
          } catch (error) {
            findRequestRouteRef.current.delete(requestId);
            findRequestCacheRef.current.delete(requestId);
            throw error;
          }
        }
      );
      addLog(`${handled ? 'Handled' : 'Rejected'} generic FIND from ${peerId}`);
      if (!handled) addLog(`OBJECT FIND suppressed or expired: requestId=${packet.payload.requestId}`);
      return;
    }
    if (packet.type === 'FIND_RESPONSE') {
      const requestId = typeof packet.payload?.requestId === 'string' ? packet.payload.requestId : null;
      const aggregationState = requestId ? findAggregationRef.current.get(requestId) : undefined;
      const route = requestId ? findRequestRouteRef.current.get(requestId) : undefined;
      addLog(`FIND_RESPONSE received: requestId=${requestId ?? 'unknown'} aggregationState=${aggregationState ? 'present' : 'absent'} route=${route?.upstreamPeer ?? 'none'} routePresent=${Boolean(route)}`);
      if (aggregationState) {
        if (peerId !== aggregationState.upstreamPeer && aggregationState.aggregation.hasChild(peerId)) {
          const objects = await validateFindResponseObjects(packet, requestId!, aggregationState.requestedObjectIds);
          const queryFields = packet.payload as { object_type?: string; author?: string; created_after?: string; created_before?: string; since?: string; limit?: number; order?: 'created_at_desc' };
          const isPhase7Query = Boolean(queryFields.object_type || queryFields.author || queryFields.created_after || queryFields.created_before || queryFields.since || queryFields.limit !== undefined || queryFields.order);
          if (isPhase7Query) {
            addLog(`PHASE7 CHILD RESPONSE requestId=${requestId} from=${peerId} objects=${objects.map((object) => object.object_id).join(', ') || 'none'} aggregate=${aggregationState.aggregation.aggregateSize() + objects.length}`);
          }
          addLog(`child ${peerId} response received`);
          addLog(`objects: ${objects.length}`);
          addLog(`PHASE6 CHILD RESPONSE local=${identityRef.current?.id ?? 'unknown'} from=${peerId} requestId=${requestId} objects=${objects.length} pendingBefore=${aggregationState.aggregation.pendingChildren().join(', ') || 'none'}`);
          await aggregationState.aggregation.addChildObjects(peerId, objects);
          aggregationState.aggregation.startGracePeriod();
          addLog(`PHASE6 AGG UPDATED local=${identityRef.current?.id ?? 'unknown'} requestId=${requestId} aggregate=${aggregationState.aggregation.aggregateSize()} pendingAfter=${aggregationState.aggregation.pendingChildren().join(', ') || 'none'}`);
          addLog(`aggregate: ${aggregationState.aggregation.aggregateSize()} unique objects`);
          addLog(`children pending: ${aggregationState.aggregation.pendingChildren().join(', ') || 'none'}`);
        } else {
          addLog(`PHASE 6 FIND response ignored: requestId=${requestId} sender=${peerId} is not a selected child pending=${aggregationState.aggregation.pendingChildren().join(',') || 'none'}`);
        }
        return;
      }
      addLog(`PHASE6 RESPONSE PATH CHECK requestId=${requestId ?? 'unknown'} aggregationPresent=${Boolean(aggregationState)} routePresent=${Boolean(route)} routeUpstream=${route?.upstreamPeer ?? 'none'} sender=${peerId}`);
      addLog(`OBJECT FIND_RESPONSE received from ${peerId}: requestId=${requestId ?? 'unknown'} route=${route?.upstreamPeer ?? 'none'}`);
      if (route && route.upstreamPeer !== peerId) {
        const shouldRetainRoute = shouldRetainFindRequestRoute(peerId, route, aggregationState);
        const relayed = Array.isArray(packet.payload.objects) && !packet.payload.object
          ? await buildFindResponseObjectsPacket(
            identityRef.current?.id ?? 'unknown',
            route.upstreamPeer,
            requestId!,
            [...packet.payload.objects],
            undefined,
            typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
            typeof packet.payload.expiresAt === 'string' ? packet.payload.expiresAt : undefined
          )
          : await buildFindResponsePacket(
            identityRef.current?.id ?? 'unknown',
            route.upstreamPeer,
            packet.payload.object_id,
            requestId!,
            packet.payload.object,
            undefined,
            typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
            typeof packet.payload.expiresAt === 'string' ? packet.payload.expiresAt : undefined
          );
        if (!shouldRetainRoute) {
          findRequestRouteRef.current.delete(requestId!);
        }
        addLog(`OBJECT FIND_RESPONSE relayed: requestId=${requestId} ${peerId} -> ${route.upstreamPeer}`);
        await objectTransportRef.current?.send(route.upstreamPeer, relayed);
      } else if (!route) {
        addLog(`OBJECT FIND_RESPONSE ignored: unknown requestId=${requestId ?? 'unknown'}`);
      }
      return;
    }
    const stored = await receiveObjectPacket(packet, store);
    addLog(`${stored ? 'Stored' : 'Rejected'} generic object from ${peerId}`);
    if (stored && packet.type === 'OBJECT_STORE') {
      setObjectTestStatus(`Received and stored ${packet.payload.object.object_id} from ${peerId}`);
      void refreshObjectStore();
    }
  };

  const refreshObjectStore = async () => {
    const objects = await objectStoreRef.current?.query();
    setObjectStoreObjects((objects ?? []) as Array<{ object_id: string; object_type: string; author: string; created_at: string; payload: unknown }>);
  };

  useEffect(() => {
    const transport = objectTransportRef.current;
    if (!transport) return;
    return transport.onPacket((peerId, packet) => {
      void handleObjectPacket(peerId, packet);
    });
  }, []);

  // Signed posts store the author's raw public key; resolve it to the short fingerprint used for contact matching.
  const resolvePostAuthorFingerprint = async (author: string): Promise<string> => {
    if (identityRef.current && (author === identityRef.current.id || author === identityRef.current.publicKey)) {
      return identityRef.current.id;
    }
    const knownContact = contactsRef.current.find((contact) => contact.fingerprint === author || contact.publicKey === author);
    if (knownContact) return knownContact.fingerprint;
    if (isValidPeerFingerprint(author)) return author;
    try {
      return await deriveFingerprint(author);
    } catch {
      return author;
    }
  };

  const generatedDisplayName = useMemo(() => identity ? fingerprintToHumanName(identity.id) : 'Me', [identity]);

  const getLocalDisplayName = () => myProfile.displayName.trim() || generatedDisplayName || 'Me';

  const buildPeerMetadata = (peerId: string, followingOverride?: boolean) => {
    const p = myProfileRef.current;
    const id = identityRef.current;
    const fallbackName = id ? fingerprintToHumanName(id.id) : 'Me';
    return {
      author: id?.id ?? '',
      publicKey: id?.publicKey,
      displayName: p.displayName.trim() || fallbackName || 'Me',
      following: followingOverride ?? contactsRef.current.find((c) => c.fingerprint === peerId)?.followed ?? false,
      timestamp: new Date().toISOString(),
      bio: p.bio.trim() || `Peer ${id?.id?.slice(0, 12) ?? 'unknown'}`,
      tags: []
    };
  };

  const handlePeerMetadata = (peerId: string, metadata: any) => {
    const metadataPublicKey = typeof metadata?.publicKey === 'string' && metadata.publicKey.trim()
      ? metadata.publicKey.trim()
      : undefined;
    const normalizedProfile: Contact['profile'] = {
      protocol: 'mycelium',
      version: 1,
      type: 'profile',
      id: peerId,
      author: metadataPublicKey ?? peerId,
      timestamp: typeof metadata?.timestamp === 'string' ? metadata.timestamp : new Date().toISOString(),
      displayName: typeof metadata?.displayName === 'string' ? metadata.displayName : undefined,
      bio: typeof metadata?.bio === 'string' ? metadata.bio : undefined,
      tags: Array.isArray(metadata?.tags) ? metadata.tags.filter((item: unknown): item is string => typeof item === 'string') : [],
      signature: ''
    };

    setContacts((prev) => {
      const existing = prev.find((contact) => contact.fingerprint === peerId);
      const updatedContact: Contact = existing
        ? {
            ...existing,
            publicKey: metadataPublicKey ?? existing.publicKey,
            displayName: metadata.displayName,
            profile: normalizedProfile,
            follower: metadata.following,
            online: true,
            connected: true
          }
        : {
          publicKey: metadataPublicKey ?? peerId,
            fingerprint: peerId,
            displayName: metadata.displayName,
            profile: normalizedProfile,
            addedAt: new Date().toISOString(),
            followed: false,
            follower: metadata.following,
            online: true,
            connected: true,
            unreadMessages: 0,
            queuedMessages: 0
          };

      void saveContact(updatedContact);
      void saveProfile(normalizedProfile);
      return existing ? prev.map((contact) => (contact.fingerprint === peerId ? updatedContact : contact)) : [...prev, updatedContact];
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
    if (!peerId || peerId === identity?.id || peerId === identity?.publicKey) return;
    if (blockedPeersRef.current.has(peerId)) {
      addLog(`Ignoring blocked peer from network: ${peerId}`);
      return;
    }
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

  const isDuplicateOutboundMessage = (peerId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return true;
    const key = trimmed.toLowerCase();
    const peerMessages = recentOutboundMessageKeysRef.current[peerId] ?? new Set<string>();
    if (peerMessages.has(key)) {
      return true;
    }
    peerMessages.add(key);
    recentOutboundMessageKeysRef.current[peerId] = peerMessages;
    window.setTimeout(() => {
      const currentSet = recentOutboundMessageKeysRef.current[peerId];
      currentSet?.delete(key);
      if (currentSet && currentSet.size === 0) {
        delete recentOutboundMessageKeysRef.current[peerId];
      }
    }, 20000);
    return false;
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
    if (!identity?.id || peerId === identity.id) {
      if (peerId === identity?.id) addLog(`Ignoring self peer manager request for ${peerId}`);
      return null;
    }
    const existing = peerManagersRef.current[peerId];
    if (existing) {
      if (!existing.needsReplacement()) {
        return existing;
      }
      addLog(`ICE offer/reconnect replacing existing peer manager for ${peerId}: state=${existing.getDataChannelState()}`);
      closeAndRemovePeerManager(peerManagersRef.current, peerId, existing);
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

    let manager: PeerConnectionManager;
    const isCurrentManager = (peer: string) => peerManagersRef.current[peer] === manager;
    manager = new PeerConnectionManager(
      identity.id,
      (peer, state) => {
        if (!isCurrentManager(peer)) return;
        setConnectionStatus(state);
        updateContactState(peer, { connected: state === 'connected', lastConnectionStatus: state });
        if (state !== 'connected') {
          setDataChannelOpen(false);
        }
      },
      (peer, incoming) => {
        if (!isCurrentManager(peer)) return;
        if (!isValidPeerFingerprint(peer)) {
          addLog(`Ignoring direct message from invalid peer id: ${peer}`);
          return;
        }
        if (blockedPeersRef.current.has(peer)) {
          addLog(`Blocked peer ${peer} message ignored`);
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
      async (peer: string, object: DistributedObject) => {
        if (!isCurrentManager(peer)) return;
        if (blockedPeersRef.current.has(peer)) {
          addLog(`Blocked peer ${peer} post ignored`);
          return;
        }
        if (!(await validateObject(object))) {
          addLog(`Rejected invalid object from ${peer}`);
          return;
        }
        await objectStoreRef.current?.put(object);
        recommendationIndexRef.current.add(object);
        setRecommendationRevision((revision) => revision + 1);
        const authorFingerprint = await resolvePostAuthorFingerprint(object.author);
        const view = object.object_type === 'mycelium.post'
          ? createLocalPostView(object as PostObject, authorFingerprint, { source: 'peer' })
          : null;
        if (view) setPostViews((prev) => upsertLocalPostView(prev, view));
        addLog(`Received verified object ${object.object_id} from ${peer}`);
      },
      (peer: string, metadata: PeerMetadata) => {
        if (!isCurrentManager(peer)) return;
        if (!isValidPeerFingerprint(peer)) {
          addLog(`Ignoring profile metadata from invalid peer id: ${peer}`);
          return;
        }
        if (blockedPeersRef.current.has(peer)) {
          addLog(`Blocked peer ${peer} metadata ignored`);
          return;
        }
        handlePeerMetadata(peer, metadata);
      },
      async (peer: string, since: string | null = null, limit = 100) => {
        if (!isCurrentManager(peer)) return;
        if (blockedPeersRef.current.has(peer)) {
          addLog(`Blocked peer ${peer} requested feed ignored`);
          return;
        }

        const store = objectStoreRef.current;
        const feedObjects = store && identityRef.current
          ? await queryFeedObjectsForPeer(store, identityRef.current.publicKey, { since, limit: Math.max(1, limit) })
          : [];

        const manager = peerManagersRef.current[peer];
        if (manager) {
          manager.sendObjectsBatch(feedObjects);
          addLog(`Sent ${feedObjects.length} canonical posts to ${peer}`);
        }
      },
      async (peer: string, objects: DistributedObject[]) => {
        if (!isCurrentManager(peer)) return;
        if (blockedPeersRef.current.has(peer)) {
          addLog(`Blocked peer ${peer} batch ignored`);
          return;
        }

        const uniqueById = new Map<string, DistributedObject>();
        for (const object of objects) {
          if (await validateObject(object)) uniqueById.set(object.object_id, object);
        }
        const receivedViews: LocalPostView[] = [];
        for (const object of uniqueById.values()) {
          await objectStoreRef.current?.put(object);
          recommendationIndexRef.current.add(object);
          setRecommendationRevision((revision) => revision + 1);
          const authorFingerprint = await resolvePostAuthorFingerprint(object.author);
          if (object.object_type === 'mycelium.post') receivedViews.push(createLocalPostView(object as PostObject, authorFingerprint, { source: 'peer' }));
        }

        setPostViews((prev) => receivedViews.reduce(upsertLocalPostView, prev));
        // Only advance the cursor when something was actually received, and use the newest
        // post timestamp (not wall-clock now) so an empty/partial batch never causes older,
        // not-yet-synced posts to become permanently unreachable on future requests.
        if (uniqueById.size > 0) {
          const latestTimestamp = [...uniqueById.values()].reduce(
            (latest, object) => Math.max(latest, new Date(object.created_at).getTime()),
            0
          );
          const cursorKey = `myceliumHomeSync:${peer}`;
          const existingCursor = localStorage.getItem(cursorKey);
          const existingCursorMs = existingCursor ? Date.parse(existingCursor) : 0;
          if (latestTimestamp > existingCursorMs) {
            localStorage.setItem(cursorKey, new Date(latestTimestamp).toISOString());
          }
        }
        addLog(`Received ${uniqueById.size} canonical posts from ${peer}`);
      },
      async (peer: string) => {
        if (!isCurrentManager(peer)) return;
        setDataChannelOpen(true);
        setActivePeerId(peer);
        updateContactState(peer, { connected: true });
        addLog(`Peer ${peer} data channel open`);
        const manager = peerManagersRef.current[peer];
        if (manager) {
          manager.sendMetadata(buildPeerMetadata(peer));
          const contact = contactsRef.current.find((candidate) => candidate.fingerprint === peer);
          if (contact?.followed) {
            manager.sendRequestPosts(null, 200);
            addLog(`Requested full home feed from ${peer} after data channel opened`);
          }
        }
        await flushQueuedMessages(peer);
      },
      (peer: string) => {
        if (!isCurrentManager(peer)) return;
        for (const state of findAggregationRef.current.values()) {
          if (state.aggregation.hasChild(peer)) {
            addLog(`child ${peer} disconnected`);
            addLog('marking child failed');
            void state.aggregation.failChild(peer);
          }
        }
        // Remove dead manager so reconnect creates a fresh RTCPeerConnection
        closeAndRemovePeerManager(peerManagersRef.current, peer, manager);
        if (selectedContactIdRef.current === peer) {
          setDataChannelOpen(false);
          setActivePeerId(null);
        }
        updateContactState(peer, { connected: false, lastConnectionStatus: 'disconnected' });
      },
      (peer: string, event: string) => {
        if (!isCurrentManager(peer)) return;
        addLog(`Peer ${peer}: ${event}`);
      },
      (peer: string) => {
        if (!isCurrentManager(peer)) return;
        // Respond to PROFILE_REQUEST with our current profile
        const manager = peerManagersRef.current[peer];
        if (manager) {
          manager.sendMetadata(buildPeerMetadata(peer));
          addLog(`Sent profile to ${peer} (on request)`);
        }
      },
      async (peer: string, transportMessageId: string) => {
        if (!isCurrentManager(peer)) return;
        const chatMessageId = acknowledgeMessage(outboundAckTimersRef.current, outboundChatMessageIdsRef.current, transportMessageId) ?? transportMessageId;
          await updateDirectChatMessageStatus(chatMessageId, 'sent');
          markDirectMessageDelivered(peer, chatMessageId, 'sent');
      },
      packetSigner,
      undefined,
      undefined,
      (peer, packet) => {
        objectTransportRef.current?.handlePacket(peer, packet);
      }
    );

    peerManagersRef.current[peerId] = manager;
    return manager;
  };

  const requestPeerOffer = (peerId: string, manager: PeerConnectionManager, socket: WebSocket) => {
    if (!identity?.id || peerId === identity.id) return;
    if (identity.id > peerId) {
      addLog(`Waiting for ${peerId} to initiate the peer connection`);
      return;
    }
    void manager.createOffer(peerId, socket);
  };

  const registerMessageAckTimeout = (peerId: string, transportMessageId: string, chatMessageId: string, text: string) => {
    scheduleMessageAckTimeout(outboundAckTimersRef.current, outboundChatMessageIdsRef.current, transportMessageId, chatMessageId, async () => {
      addLog(`Direct-message ACK timeout fired for ${peerId} message ${transportMessageId}`);
      const alreadyQueued = messageQueueRef.current[peerId]?.some((entry) => entry.chatMessageId === chatMessageId);
      if (alreadyQueued || isDuplicateOutboundMessage(peerId, text)) {
        return;
      }

      await queuePeerMessage(peerId, text, chatMessageId);
      await updateDirectChatMessageStatus(chatMessageId, 'queued');
      markDirectMessageDelivered(peerId, chatMessageId, 'queued');
      const socket = signallingSocketRef.current;
      const manager = peerManagersRef.current[peerId] ?? ensurePeerManager(peerId);
      if (socket && socket.readyState === WebSocket.OPEN && manager) {
        requestPeerOffer(peerId, manager, socket);
      }
    });
  };

  const handlePeerList = async (peers: string[]) => {
    const validPeers = peers.filter((peerId) => {
      if (!peerId || peerId === identity?.id) return false;
      return isValidPeerFingerprint(peerId) && !blockedPeersRef.current.has(peerId);
    });
    const invalidPeers = peers.filter((peerId) => !validPeers.includes(peerId) && !blockedPeersRef.current.has(peerId) && peerId !== identity?.id);
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
      if (!socket || socket.readyState !== WebSocket.OPEN || !manager) return;

      const channelState = manager.getDataChannelState();
      const shouldReconnect = !contact?.connected || channelState === 'closed' || channelState === 'missing' || channelState === 'connecting';
      if (shouldReconnect) {
        const freshManager = ensurePeerManager(peerId);
        if (freshManager) {
          requestPeerOffer(peerId, freshManager, socket);
        }
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
        addLog(`Identity loaded: ${loadedIdentity.id}`);
      }
      const rawProfile = localStorage.getItem('myProfile');
      if (rawProfile) {
        try {
          const parsed = JSON.parse(rawProfile);
          if (typeof parsed.displayName === 'string' || typeof parsed.bio === 'string' || parsed.feedMix || Array.isArray(parsed.blockedPeers) || Array.isArray(parsed.hiddenPeers)) {
            const parsedFeedMix = parsed.feedMix && typeof parsed.feedMix === 'object'
              ? {
                  followedAuthors: Number(parsed.feedMix.followedAuthors ?? DEFAULT_FEED_MIX.followedAuthors),
                  followedLikes: Number(parsed.feedMix.followedLikes ?? DEFAULT_FEED_MIX.followedLikes),
                  discoveryRandom: Number(parsed.feedMix.discoveryRandom ?? DEFAULT_FEED_MIX.discoveryRandom)
                }
              : DEFAULT_FEED_MIX;
            const blockedPeers = Array.isArray(parsed.blockedPeers)
              ? parsed.blockedPeers.filter((value: unknown): value is string => typeof value === 'string')
              : [];
            const hiddenPeers = Array.isArray(parsed.hiddenPeers)
              ? parsed.hiddenPeers.filter((value: unknown): value is string => typeof value === 'string')
              : [];
            const rawDisplayName = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
            const sanitizedDisplayName = rawDisplayName && /^([0-9a-fA-F]{16,})$/.test(rawDisplayName)
              ? fingerprintToHumanName(identity?.id ?? rawDisplayName)
              : rawDisplayName;

            setMyProfile({
              displayName: sanitizedDisplayName,
              bio: typeof parsed.bio === 'string' ? parsed.bio : '',
              feedMix: {
                followedAuthors: Math.max(0, parsedFeedMix.followedAuthors),
                followedLikes: Math.max(0, parsedFeedMix.followedLikes),
                discoveryRandom: Math.max(0, parsedFeedMix.discoveryRandom)
              },
              blockedPeers,
              hiddenPeers
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
      const loadedContacts = dedupeContactsByFingerprint(cs || []);
      setContacts(loadedContacts);
      addLog(`Contacts loaded: ${loadedContacts.length}`);
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
          handlePeerList(message.peers.filter((peerId) => !blockedPeersRef.current.has(peerId)));
          return;
        }

        if (message.type === 'discovery-result') {
          handleDiscoveryResult(message.packet);
          return;
        }

        if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
          if (message.from === identityRef.current?.id) {
            addLog(`Ignoring signalling message from self: ${message.type}`);
            return;
          }
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
          addLog(`Signalling reconnect timer scheduled in 3000ms after ${status}`);
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            setSignallingReconnectTick((prev) => prev + 1);
            addLog('Signalling reconnect timer fired; retrying signalling connection');
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
      addLog('30-second peer reconnect interval fired');
      const socket = signallingSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      dedupeContactsByFingerprint(contactsRef.current).forEach((contact) => {
        if (!contact.fingerprint || contact.fingerprint === identity.id) return;
        const hasQueuedMessages = (messageQueueRef.current[contact.fingerprint]?.length ?? 0) > 0;
        const manager = ensurePeerManager(contact.fingerprint);
        if (!manager) return;

        const shouldReconnect = (contact.online || hasQueuedMessages) && (
          !contact.connected ||
          manager.needsReplacement()
        );

        if (shouldReconnect && !manager.isNegotiating() && contact.lastConnectionStatus !== 'signalling' && contact.lastConnectionStatus !== 'connecting') {
          addLog(`Reconnect attempt to ${contact.fingerprint}`);
          requestPeerOffer(contact.fingerprint, manager, socket);
        }
      });
    }, 30000);

    return () => window.clearInterval(interval);
  }, [identity]);

  useEffect(() => {
    if (!identity?.id) return;
    void handleRefreshHomeFeed();
    void handleFetchDiscovery();
  }, [identity?.id]);

  useEffect(() => {
    if (page !== 'discover' || discoveryPosts.length > 0) return;
    void handleFetchDiscovery();
  }, [page, discoveryPosts.length]);

  useEffect(() => {
    if (!identity?.id || page !== 'home') return;
    void handleRefreshHomeFeed();
  }, [page, identity?.id, contacts.length]);

  useEffect(() => {
    if (!identity?.id) return;
    const interval = window.setInterval(() => {
      addLog('60-second home-sync interval fired');
      const lastSync = localStorage.getItem('myceliumLastHomeSync');
      if (!lastSync) {
        void handleRefreshHomeFeed();
        return;
      }
      const elapsedMs = Date.now() - new Date(lastSync).getTime();
      if (elapsedMs >= 10 * 60 * 1000) {
        void handleRefreshHomeFeed();
      }
    }, 60000);
    return () => window.clearInterval(interval);
  }, [identity?.id]);

  async function handleAddContactFromKey(publicKey: string, displayName?: string) {
    if (blockedPeersRef.current.has(publicKey)) {
      addLog(`Refusing to add blocked peer: ${publicKey}`);
      return;
    }
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
    if (blockedPeersRef.current.has(normalized)) {
      addLog(`Refusing to add blocked peer address: ${normalized}`);
      return;
    }

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
      requestPeerOffer(fingerprint, manager, socket);
      addLog(`Attempting connection to ${fingerprint}`);
    } else {
      addLog('Peer added. Waiting for signalling connection to connect.');
    }
  }

  async function handleToggleFollow(peerId: string) {
    const existing = contactsRef.current.find((c) => c.publicKey === peerId || c.fingerprint === peerId);
    const normalizedId = existing?.publicKey || existing?.fingerprint || peerId;
    const fingerprint = existing?.fingerprint || (isValidPeerFingerprint(peerId) ? peerId : await deriveFingerprint(peerId));
    const baseContact: Contact = existing ?? {
      publicKey: normalizedId,
      fingerprint,
      displayName: undefined,
      addedAt: new Date().toISOString(),
      followed: false
    };
    const updated = { ...baseContact, publicKey: normalizedId, fingerprint, followed: !baseContact.followed };

    await saveContact(updated);
    setContacts((prev) => {
      const next = dedupeContactsByFingerprint(prev.map((c) => (c.publicKey === normalizedId || c.fingerprint === peerId || c.fingerprint === fingerprint ? updated : c)).concat(existing ? [] : [updated]));
      contactsRef.current = next;
      return next;
    });
    const socket = signallingSocketRef.current;
    const manager = peerManagersRef.current[fingerprint] ?? ensurePeerManager(fingerprint);
    if (socket?.readyState === WebSocket.OPEN && manager) {
      if (manager.isDataChannelOpen()) {
        manager.sendMetadata(buildPeerMetadata(fingerprint, updated.followed));
      } else {
        requestPeerOffer(fingerprint, manager, socket);
      }
    }
    addLog(`${updated.followed ? 'Following' : 'Unfollowed'} ${updated.fingerprint || updated.publicKey}`);
  }

  async function handleRemoveContact(publicKey: string) {
    await deleteContact(publicKey);
    setContacts((prev) => prev.filter((c) => c.publicKey !== publicKey));
    addLog(`Removed contact`);
  }

  const handleHidePost = async (postId: string) => {
    setHiddenPostIds((prev) => {
      const next = new Set(prev);
      next.add(postId);
      localStorage.setItem('hiddenPosts', JSON.stringify(Array.from(next)));
      return next;
    });
    const target = postViews.find((post) => post.object.object_id === postId);
    if (target) {
      await localPostMetadataStoreRef.current?.put(localPostMetadata({ ...target, hidden: true }));
      setPostViews((prev) => upsertLocalPostView(prev, { ...target, hidden: true }));
    }
  };

  const handleUnhidePost = async (postId: string) => {
    setHiddenPostIds((prev) => {
      const next = new Set(prev);
      next.delete(postId);
      localStorage.setItem('hiddenPosts', JSON.stringify(Array.from(next)));
      return next;
    });
    setHiddenDiscoveryIds((prev) => {
      const next = new Set(prev);
      next.delete(postId);
      localStorage.setItem('hiddenDiscovery', JSON.stringify(Array.from(next)));
      return next;
    });
    const target = postViews.find((post) => post.object.object_id === postId);
    if (target) {
      const next = { ...target, hidden: false };
      await localPostMetadataStoreRef.current?.put(localPostMetadata(next));
      setPostViews((prev) => upsertLocalPostView(prev, next));
      setDiscoveryPosts((prev) => upsertLocalPostView(prev, next));
    }
  };

  const handleHideDiscoveryPost = async (postId: string) => {
    setHiddenDiscoveryIds((prev) => {
      const next = new Set(prev);
      next.add(postId);
      localStorage.setItem('hiddenDiscovery', JSON.stringify(Array.from(next)));
      return next;
    });
    const target = discoveryPosts.find((post) => post.object.object_id === postId);
    if (target) {
      await localPostMetadataStoreRef.current?.put(localPostMetadata({ ...target, hidden: true }));
      setPostViews((prev) => upsertLocalPostView(prev, { ...target, hidden: true }));
      setDiscoveryPosts((prev) => upsertLocalPostView(prev, { ...target, hidden: true }));
    }
  };

  const handleLikePost = async (objectId: string) => {
    const target = discoveryPosts.find((post) => post.object.object_id === objectId) ?? postViews.find((post) => post.object.object_id === objectId);
    if (target && identity && target.object.author !== identity.publicKey) {
      const isLiked = getRecommendationSummary(objectId).recommended_by_me;
      const sequence = await recommendationSequenceStoreRef.current!.next(identity.publicKey);
      const recommendation = await createSignedRecommendationObject(objectId, isLiked ? 'withdraw' : 'recommend', sequence, createObjectIdentity(identity));
      await objectStoreRef.current?.put(recommendation);
      recommendationIndexRef.current.add(recommendation);
      setRecommendationRevision((revision) => revision + 1);
      setPostViews((prev) => upsertLocalPostView(prev, target));
      setDiscoveryPosts((prev) => upsertLocalPostView(prev, target));
      await localPostMetadataStoreRef.current?.put(localPostMetadata(target));
      addLog(`Liked post ${objectId}`);
    }
  };

  const handleDislikePost = async (objectId: string) => {
    const target = postViews.find((post) => post.object.object_id === objectId) ?? discoveryPosts.find((post) => post.object.object_id === objectId);
    if (target) {
      const next = { ...target, notInterested: true };
      setPostViews((prev) => upsertLocalPostView(prev, next));
      setDiscoveryPosts((prev) => upsertLocalPostView(prev, next));
      await localPostMetadataStoreRef.current?.put(localPostMetadata(next));
      addLog(`Disliked post ${objectId}`);
    }
  };

  async function handleCreatePost(publishToDiscovery = false, replyTo?: string, replyContent?: string) {
    if (!identity) return;
    const isReply = Boolean(replyTo);
    const content = (isReply ? replyContent : newPostContent)?.trim() ?? '';
    if (!content) return;
    const tags = isReply ? [] : newPostTags.split(',').map((t) => t.trim()).filter(Boolean);
    const objectIdentity = createObjectIdentity(identity);
    const postObject = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: new Date().toISOString(),
      payload: {
        content,
        tags,
        ...(replyTo ? { reply_to: replyTo } : {})
      },
      replication_policy: {}
    }, objectIdentity) as PostObject;
    const objectStore = objectStoreRef.current;
    if (!objectStore) throw new Error('Object store is unavailable');
    await objectStore.put(postObject);

    const localPostView = createLocalPostView(postObject, identity.id, { source: 'local' });
    setPostViews((prev) => upsertLocalPostView(prev, localPostView));
    await localPostMetadataStoreRef.current?.put(localPostMetadata(localPostView));

    addLog(`Created and stored object post ${postObject.object_id}`);
    if (!isReply) {
      setNewPostContent('');
      setNewPostTags('');
    }

    if (replyTo) {
      const targetPost = postViews.find((post) => post.object.object_id === replyTo);
      const targetPeer = targetPost
        ? targetPost.authorFingerprint
        : undefined;
      if (targetPost && targetPeer && identity) {
        const replyIdentity = createObjectIdentity(identity);
        const replyObject = await createSignedObject({
          object_type: 'mycelium.reply',
          created_at: new Date().toISOString(),
          payload: createReplyObjectPayload(replyTo),
          replication_policy: {}
        }, replyIdentity);
        const replyResult = await sendReplyToAuthor(identity.id, replyObject, objectTransportRef.current!, targetPeer, (packet) => signString(identity.privateKey, canonicalize(packet)));
        addLog(replyResult.sent
          ? `Pushed reply object ${replyObject.object_id} to ${targetPeer}`
          : `Reply object ${replyObject.object_id} author ${targetPeer} is not connected`);
      }
    }

    Object.entries(peerManagersRef.current).forEach(([peerId, manager]) => {
      const contact = contacts.find((c) => c.fingerprint === peerId);
      if (contact?.followed && contact.connected && manager) {
        manager.sendObject(postObject);
        addLog(`Shared canonical post ${postObject.object_id} with connected followed peer ${peerId}`);
      }
    });

    if (publishToDiscovery) {
      const socket = signallingSocketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          await publishObject(postObject, socket);
          addLog('Published canonical object to discovery');
        } catch (err: any) {
          addLog(`Discovery publish failed: ${err.message}`);
        }
      } else {
        addLog('Discovery publish skipped: not connected to signalling server');
      }
    }
  }

  const blockedPeerSet = useMemo(() => new Set(myProfile.blockedPeers), [myProfile.blockedPeers]);
  const isBlockedPost = (post: LocalPostView) => blockedPeerSet.has(post.object.author) || blockedPeerSet.has(post.authorFingerprint);
  const isHiddenPost = (post: LocalPostView) => hiddenPostIds.has(post.object.object_id) || hiddenDiscoveryIds.has(post.object.object_id) || post.hidden === true;
  const visibleDiscoveryPosts = discoveryPosts.filter((post) => !isHiddenPost(post) && !isBlockedPost(post));

  const visibleContacts = useMemo(
    () => contacts.filter((contact) => {
      if (!contact.fingerprint) return false;
      if (identity && (contact.fingerprint === identity.id || contact.publicKey === identity.publicKey)) return false;
      return !blockedPeerSet.has(contact.fingerprint);
    }),
    [contacts, blockedPeerSet, identity]
  );

  const discoverFeedPosts = useMemo(() => {
    return [...visibleDiscoveryPosts].sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime());
  }, [visibleDiscoveryPosts]);

  const visibleHomePosts = useMemo(() => {
    const followedAuthorKeys = new Set([
      ...contacts.filter((contact) => contact.followed).flatMap((contact) => [contact.fingerprint, contact.publicKey]),
      ...(identity ? [identity.id, identity.publicKey] : [])
    ]);
    const computedHomePosts = selectFollowedPosts(postViews.filter((post) => !isHiddenPost(post)), followedAuthorKeys)
      .map((post) => ({
        ...post,
        homeFeedSource: 'followed' as const,
        recommendationSummary: getRecommendationSummary(post.object.object_id)
      }));
    addLog(`Home feed computed: ${computedHomePosts.length} visible posts (${postViews.length} total in postViews); feedMix=${myProfile.feedMix.followedAuthors}/${myProfile.feedMix.followedLikes}/${myProfile.feedMix.discoveryRandom}; hiddenPostIds=${hiddenPostIds.size}`);
    return computedHomePosts;
  }, [postViews, contacts, hiddenPostIds, hiddenDiscoveryIds, recommendationRevision]);

  const profileContact = profileContactId ? contactsRef.current.find((contact) => contact.fingerprint === profileContactId || contact.publicKey === profileContactId) : undefined;
  const profileAuthorIds = new Set([profileContactId, profileContact?.fingerprint, profileContact?.publicKey].filter((value): value is string => Boolean(value)));
  const profilePosts = profileContactId
    ? postViews
      // post.author is the raw public key, not the fingerprint - match on authorFingerprint too
      .filter((post) => profileAuthorIds.has(post.authorFingerprint) || profileAuthorIds.has(post.object.author))
      .filter((post) => !isHiddenPost(post))
      .filter((post) => !isBlockedPost(post))
      .sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime())
    : [];

  const likedProfilePosts = profileContactId
    ? postViews.filter((post) => {
      const summary = getRecommendationSummary(post.object.object_id);
      return summary.active_recommenders.includes(profileContact?.publicKey ?? profileContactId) && !isHiddenPost(post) && !isBlockedPost(post);
    }).sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime())
    : [];

  const currentChatMessages = chatContactId ? (directChats[chatContactId] || []).filter((entry) => !blockedPeerSet.has(chatContactId)) : [];

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

  const handleHidePeer = (peerId: string) => {
    if (!peerId) return;
    setMyProfile((prev) => {
      const nextHidden = Array.from(new Set([...prev.hiddenPeers, peerId]));
      const nextProfile = { ...prev, hiddenPeers: nextHidden };
      localStorage.setItem('myProfile', JSON.stringify(nextProfile));
      return nextProfile;
    });
  };

  const handleBlockPeer = (peerId: string) => {
    if (!peerId) return;
    const manager = peerManagersRef.current[peerId];
    if (manager) {
      manager.closeConnection();
      delete peerManagersRef.current[peerId];
    }
    setMyProfile((prev) => {
      const nextBlocked = Array.from(new Set([...prev.blockedPeers, peerId]));
      const nextHidden = Array.from(new Set([...prev.hiddenPeers, peerId]));
      const nextProfile = { ...prev, blockedPeers: nextBlocked, hiddenPeers: nextHidden };
      localStorage.setItem('myProfile', JSON.stringify(nextProfile));
      return nextProfile;
    });
    setContacts((prev) => prev.filter((candidate) => candidate.fingerprint !== peerId));
    setPostViews((prev) => prev.filter((post) => post.authorFingerprint !== peerId && post.object.author !== peerId));
    setDiscoveryPosts((prev) => prev.filter((post) => post.object.author !== peerId && post.authorFingerprint !== peerId));
    setDirectChats((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    setMessageQueue((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    setSelectedContactId((current) => (current === peerId ? null : current));
    setChatContactId((current) => (current === peerId ? null : current));
    setProfileContactId((current) => (current === peerId ? null : current));
  };

  const handleUnblockPeer = (peerId: string) => {
    if (!peerId) return;
    setMyProfile((prev) => {
      const nextProfile = {
        ...prev,
        blockedPeers: prev.blockedPeers.filter((id) => id !== peerId),
        hiddenPeers: prev.hiddenPeers.filter((id) => id !== peerId)
      };
      localStorage.setItem('myProfile', JSON.stringify(nextProfile));
      return nextProfile;
    });
  };

  useEffect(() => {
    const pageContainer = document.getElementById('page-content');
    if (pageContainer) {
      pageContainer.scrollTop = pageScrollPositions[page] || 0;
    }
  }, [page, pageScrollPositions]);

  const resolveAuthorDisplayName = (authorId: string, fallbackContact?: Contact) => {
    const trimmedName = fallbackContact?.displayName?.trim();
    if (trimmedName) {
      return trimmedName;
    }

    if (isValidPeerFingerprint(authorId)) {
      return fingerprintToHumanName(authorId);
    }

    return undefined;
  };

  async function handleRefreshHomeFeed() {
    if (!identity) return;
    setHomeSyncBusy(true);

    try {
      const socket = signallingSocketRef.current;
      const followedPeers = contactsRef.current.filter((contact) => contact.followed && contact.fingerprint !== identity.id);

      if (!socket || socket.readyState !== WebSocket.OPEN || followedPeers.length === 0) {
        return;
      }

      for (const contact of followedPeers) {
        const manager = peerManagersRef.current[contact.fingerprint] ?? ensurePeerManager(contact.fingerprint);
        if (!manager) continue;

        if (manager.isDataChannelOpen()) {
          manager.sendRequestPosts(null, 200);
          addLog(`Requested full home feed from ${contact.fingerprint}`);
        } else if (contact.online) {
          const channelState = manager.getDataChannelState();
          if (channelState === 'closed' || channelState === 'missing') {
            requestPeerOffer(contact.fingerprint, manager, socket);
            addLog(`Reconnecting to ${contact.fingerprint} to fetch home updates`);
          }
        }
      }

      localStorage.setItem('myceliumLastHomeSync', new Date().toISOString());
    } finally {
      setHomeSyncBusy(false);
    }
  }

  async function handleFetchDiscovery() {
    const socket = signallingSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      addLog('Discovery fetch skipped: not connected to signalling server');
      return;
    }
    addLog('Refreshing discovery posts');
    try {
      const items = await fetchDiscovery(socket, 20);
      const verifiedPosts = (await Promise.all(items.map(async (object) => {
          if (object.object_type !== 'mycelium.post' || !(await validateObject(object))) return null;
          const cachedPost = discoveryPosts.find((cached) => cached.object.object_id === object.object_id)
            ?? postViews.find((cached) => cached.object.object_id === object.object_id);
          const knownContact = contactsRef.current.find((contact) =>
            contact.fingerprint === object.author || contact.publicKey === object.author
          );
          const authorFingerprint = knownContact?.fingerprint || (isValidPeerFingerprint(object.author) ? object.author : await deriveFingerprint(object.author).catch(() => object.author));
          const authorDisplayName = resolveAuthorDisplayName(authorFingerprint, knownContact);
          return createLocalPostView(object as PostObject, authorFingerprint, {
              source: 'discovery',
              authorDisplayName: authorDisplayName || cachedPost?.authorDisplayName
          });
      }))).filter((view): view is LocalPostView => view !== null);
      setDiscoveryPosts((prev) => {
        const merged = mergeLocalPostViews(prev, verifiedPosts);
        return merged.sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime());
      });
      addLog(`Fetched ${verifiedPosts.length} discovery posts`);
    } catch (err: any) {
      const message = err?.message || String(err);
      addLog(`Discovery fetch failed (${signalEndpoint}): ${message}`);
    }
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

    const exportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      identity: {
        key: identity.key,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        id: identity.id
      },
      profile: {
        displayName: myProfile.displayName.trim() || fingerprintToHumanName(identity.id),
        bio: myProfile.bio.trim(),
        feedMix: myProfile.feedMix,
        blockedPeers: myProfile.blockedPeers,
        hiddenPeers: myProfile.hiddenPeers
      },
      contacts: contacts.map((contact) => ({
        publicKey: contact.publicKey,
        fingerprint: contact.fingerprint,
        displayName: contact.displayName?.trim() || undefined,
        followed: Boolean(contact.followed),
        follower: Boolean(contact.follower),
        online: Boolean(contact.online),
        connected: Boolean(contact.connected),
        addedAt: contact.addedAt,
        lastConnectionStatus: contact.lastConnectionStatus,
        lastSeen: contact.lastSeen,
        unreadMessages: contact.unreadMessages ?? 0,
        queuedMessages: contact.queuedMessages ?? 0,
        profile: contact.profile
          ? {
              ...contact.profile,
              displayName: contact.profile.displayName?.trim() || undefined,
              bio: contact.profile.bio?.trim() || undefined
            }
          : undefined
      }))
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
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
        const importedIdentity = imported?.identity ?? imported;

        if (importedIdentity?.publicKey && importedIdentity?.privateKey && importedIdentity?.id) {
          const nextIdentity = {
            key: importedIdentity.key ?? 'local',
            publicKey: importedIdentity.publicKey,
            privateKey: importedIdentity.privateKey,
            id: importedIdentity.id
          };

          await saveIdentity(nextIdentity);
          setIdentity(nextIdentity);

          const profileData = imported?.profile ?? {};
          const safeFeedMix = typeof profileData.feedMix === 'object' && profileData.feedMix !== null
            ? {
                followedAuthors: Number(profileData.feedMix.followedAuthors ?? DEFAULT_FEED_MIX.followedAuthors),
                followedLikes: Number(profileData.feedMix.followedLikes ?? DEFAULT_FEED_MIX.followedLikes),
                discoveryRandom: Number(profileData.feedMix.discoveryRandom ?? DEFAULT_FEED_MIX.discoveryRandom)
              }
            : { ...DEFAULT_FEED_MIX };

          const nextProfile = {
            displayName: typeof profileData.displayName === 'string' ? profileData.displayName : '',
            bio: typeof profileData.bio === 'string' ? profileData.bio : '',
            feedMix: {
              followedAuthors: Math.max(0, Math.min(100, Number(safeFeedMix.followedAuthors) || DEFAULT_FEED_MIX.followedAuthors)),
              followedLikes: Math.max(0, Math.min(100, Number(safeFeedMix.followedLikes) || DEFAULT_FEED_MIX.followedLikes)),
              discoveryRandom: Math.max(0, Math.min(100, Number(safeFeedMix.discoveryRandom) || DEFAULT_FEED_MIX.discoveryRandom))
            },
            blockedPeers: Array.isArray(profileData.blockedPeers)
              ? profileData.blockedPeers.filter((value: unknown): value is string => typeof value === 'string')
              : [],
            hiddenPeers: Array.isArray(profileData.hiddenPeers)
              ? profileData.hiddenPeers.filter((value: unknown): value is string => typeof value === 'string')
              : []
          };

          setMyProfile(nextProfile);
          localStorage.setItem('myProfile', JSON.stringify(nextProfile));

          const importedContacts: Contact[] = Array.isArray(imported?.contacts)
            ? imported.contacts.map((contact: any): Contact => ({
                publicKey: contact.publicKey ?? contact.fingerprint ?? '',
                fingerprint: contact.fingerprint ?? contact.publicKey ?? '',
                displayName: typeof contact.displayName === 'string' ? contact.displayName : undefined,
                profile: contact.profile ?? undefined,
                addedAt: typeof contact.addedAt === 'string' ? contact.addedAt : new Date().toISOString(),
                followed: Boolean(contact.followed),
                follower: Boolean(contact.follower),
                online: Boolean(contact.online),
                connected: Boolean(contact.connected),
                lastConnectionStatus: typeof contact.lastConnectionStatus === 'string' ? contact.lastConnectionStatus : undefined,
                lastSeen: typeof contact.lastSeen === 'string' ? contact.lastSeen : undefined,
                unreadMessages: Number(contact.unreadMessages ?? 0),
                queuedMessages: Number(contact.queuedMessages ?? 0)
              })).filter((contact: Contact) => Boolean(contact.fingerprint && contact.publicKey))
            : [];

          const restoredContacts = dedupeContactsByFingerprint(importedContacts);
          setContacts(restoredContacts);
          await Promise.all(restoredContacts.map(async (contact) => saveContact(contact)));

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

  async function handleClearOldPeerCache() {
    const confirmed = window.confirm('Clear cached peer messages older than one week? This keeps your identity, contacts, and local posts.');
    if (!confirmed) return;

    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const chatEntries = await loadDirectChatMessages();
    const stalePeerMessages = chatEntries.filter((entry) => !entry.isMine && new Date(entry.timestamp).getTime() <= cutoff);
    for (const entry of stalePeerMessages) {
      await deleteDirectChatMessage(entry.id);
    }

    const refreshedChats = await loadDirectChatMessages();
    const groupedDirectMessages = refreshedChats.reduce((acc, message) => {
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

    addLog(`Cleared peer cache older than 7 days (0 posts, ${stalePeerMessages.length} messages)`);
  }

  async function handleClearAllPeerCache() {
    const confirmed = window.confirm('Clear all cached peer messages? This will not delete your identity, contacts, or your own posts.');
    if (!confirmed) return;

    const chatEntries = await loadDirectChatMessages();
    const stalePeerMessages = chatEntries.filter((entry) => !entry.isMine);
    for (const entry of stalePeerMessages) {
      await deleteDirectChatMessage(entry.id);
    }

    const refreshedChats = await loadDirectChatMessages();
    const groupedDirectMessages = refreshedChats.reduce((acc, message) => {
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

    addLog(`Cleared all peer cache entries (0 posts, ${stalePeerMessages.length} messages)`);
  }

  async function handleClearIdentity() {
    const confirmed = window.confirm(
      'Warning: clearing this identity logs you out on this browser. Export your identity backup first, or you may lose access permanently. Continue?'
    );
    if (!confirmed) return;

    // Close any live sockets/managers first so stale RTC sessions disappear immediately.
    signallingSocketRef.current?.close();
    Object.values(peerManagersRef.current).forEach((manager) => manager.closeConnection());
    peerManagersRef.current = {};
    signallingSocketRef.current = null;

    // Remove every persisted app record tied to this identity/browser session.
    await deleteIdentity();
    await clearAllLocalData();
    localStorage.removeItem('myProfile');
    localStorage.removeItem('hiddenPosts');
    localStorage.removeItem('hiddenDiscovery');
    localStorage.removeItem('myceliumHeaderCollapsed');

    setIdentity(null);
    setContacts([]);
    setPostViews([]);
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
    requestPeerOffer(normalizedRemoteId, manager, socket);
  }

  async function handleSelectContact(peerId: string) {
    setSelectedContactId(peerId);
    setChatContactId(peerId);
    setPage('chat');
    addLog(`Selected contact ${peerId}`);
    updateContactState(peerId, { unreadMessages: 0 });

    const socket = signallingSocketRef.current;
    const manager = ensurePeerManager(peerId);
    const targetContact = contacts.find((contact) => contact.fingerprint === peerId);
    if (socket && socket.readyState === WebSocket.OPEN && manager && !targetContact?.connected) {
      requestPeerOffer(peerId, manager, socket);
      addLog(`Opening chat and connecting to ${peerId}`);
    }
  }

  async function handleOpenPeerProfile(peerId: string) {
    if (!peerId) return;

    if (peerId === identity?.id) {
      setProfileContactId(null);
      setPage('myProfile');
      setProfileNotice(null);
      return;
    }

    let contact = contactsRef.current.find((candidate) => candidate.fingerprint === peerId || candidate.publicKey === peerId);
    let resolvedContact = contact;
    if (!resolvedContact) {
      resolvedContact = {
        publicKey: peerId,
        fingerprint: peerId,
        addedAt: new Date().toISOString(),
        followed: false,
        online: false,
        connected: false,
        unreadMessages: 0,
        queuedMessages: 0
      };
      await saveContact(resolvedContact);
      setContacts((prev) => dedupeContactsByFingerprint([...prev, resolvedContact!]));
    }

    const cachedProfile = await loadProfile(peerId);
    if (cachedProfile && !resolvedContact.profile) {
      resolvedContact = { ...resolvedContact, displayName: cachedProfile.displayName ?? resolvedContact.displayName, profile: cachedProfile };
      await saveContact(resolvedContact);
      setContacts((prev) => prev.map((item) => (item.fingerprint === peerId ? resolvedContact! : item)));
    }

    setProfileContactId(peerId);
    setPage('profile');
    setProfileNotice(null);

    const socket = signallingSocketRef.current;
    const manager = peerManagersRef.current[peerId] ?? ensurePeerManager(peerId);
    const canRequestProfile = Boolean(
      socket &&
      socket.readyState === WebSocket.OPEN &&
      manager &&
      (resolvedContact.online || resolvedContact.connected || manager.getDataChannelState() === 'connecting' || manager.getDataChannelState() === 'open')
    );

    if (canRequestProfile) {
      if (!resolvedContact.connected && !manager.isDataChannelOpen() && socket) {
        requestPeerOffer(peerId, manager, socket);
      }
      manager.requestProfile();
      manager.sendRequestPosts(null, 200);
      return;
    }

    if (socket && socket.readyState === WebSocket.OPEN && manager && !resolvedContact.connected) {
      requestPeerOffer(peerId, manager, socket);
      setProfileNotice(`Profile information for ${peerId.slice(0, 12)} is unavailable at the moment.`);
      return;
    }

    setProfileNotice(`Profile information for ${peerId.slice(0, 12)} is unavailable at the moment.`);
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
    if (isDuplicateOutboundMessage(peerId, trimmedMessage)) {
      addLog(`Duplicate message suppressed for ${peerId}: ${trimmedMessage.slice(0, 80)}`);
      setMessage('');
      return;
    }
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
      const transportMessageId = manager.sendChatMessage(trimmedMessage);
      registerMessageAckTimeout(peerId, transportMessageId, messageId, trimmedMessage);
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
        requestPeerOffer(peerId, lazyManager, socket);
        addLog(`Queued message and requested data channel to ${peerId}`);
      }
      addLog(`Queued direct message for ${peerId}`);
    }

    updateContactState(peerId, { unreadMessages: 0 });
    setMessage('');
  }

  async function handleSendObjectTest() {
    if (!identity || !objectTestPeerId) return;
    try {
      const store = objectStoreRef.current;
      if (!store) throw new Error('Object store is unavailable');
      const objectIdentity = createObjectIdentity(identity);
      const object = await createSignedObject({
        object_type: 'mycelium.browser-test',
        created_at: new Date().toISOString(),
        payload: { message: 'Stage 2 browser transport test', sent_at: new Date().toISOString() },
        replication_policy: {}
      }, objectIdentity);
      await store.put(object);
      lastObjectTestRef.current = object;
      setObjectTestLastId(object.object_id);
      await refreshObjectStore();
      const packetSigner: PacketSigner = (packet) => signString(identity.privateKey, canonicalize(packet));
      const packet = await buildObjectStorePacket(identity.id, objectTestPeerId, object, packetSigner);
      await objectTransportRef.current?.send(objectTestPeerId, packet);
      setObjectTestStatus(`Created, stored locally, and sent ${object.object_id} to ${objectTestPeerId}`);
      addLog(`Created and stored generic browser test object ${object.object_id}`);
      addLog(`Sent generic browser test object ${object.object_id} to ${objectTestPeerId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`Object test failed: ${message}`);
      addLog(`Generic object test failed: ${message}`);
    }
  }

  async function handlePlaceObjectTestOnly() {
    if (!identity || !objectTestStoragePeerId) return;
    try {
      const store = objectStoreRef.current;
      if (!store) throw new Error('Object store is unavailable');
      const objectIdentity = createObjectIdentity(identity);
      const object = await createSignedObject({
        object_type: 'mycelium.browser-test',
        created_at: new Date().toISOString(),
        payload: { message: 'Phase 5 recursive FIND browser test', sent_at: new Date().toISOString() },
        replication_policy: {}
      }, objectIdentity);
      const packetSigner: PacketSigner = (packet) => signString(identity.privateKey, canonicalize(packet));
      const packet = await buildObjectStorePacket(identity.id, objectTestStoragePeerId, object, packetSigner);
      await objectTransportRef.current?.send(objectTestStoragePeerId, packet);
      lastObjectTestRef.current = object;
      setObjectTestLastId(object.object_id);
      await store.delete(object.object_id);
      await refreshObjectStore();
      setObjectTestStatus(`Created ${object.object_id}; stored only on ${objectTestStoragePeerId}`);
      addLog(`OBJECT TEST placed object ${object.object_id} on ${objectTestStoragePeerId}; removed local copy`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`Object placement failed: ${message}`);
      addLog(`OBJECT TEST placement failed: ${message}`);
    }
  }

  async function sendDeveloperFindPacket(packet: ObjectPacket, label: string) {
    if (!objectTestPeerId || !objectTransportRef.current) return;
    try {
      await objectTransportRef.current.send(objectTestPeerId, packet);
      setObjectTestStatus(`${label} sent to ${objectTestPeerId}`);
      const requestId = packet.type === 'FIND' || packet.type === 'FIND_RESPONSE' ? packet.payload.requestId : 'n/a';
      addLog(`OBJECT DEV TEST ${label} sent: requestId=${requestId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`${label} failed: ${message}`);
      addLog(`OBJECT DEV TEST ${label} failed: ${message}`);
    }
  }

  async function handleSendTtlZeroTest() {
    if (!identity || !objectTestPeerId || !objectTestLastId) return;
    await sendDeveloperFindPacket(await buildFindPacket(identity.id, objectTestPeerId, objectTestLastId, undefined, `dev-ttl-zero-${Date.now()}`, 0, identity.id), 'FIND TTL 0');
  }

  async function handleSendDuplicateTest() {
    if (!identity || !objectTestPeerId || !objectTestLastId) return;
    const packet = await buildFindPacket(identity.id, objectTestPeerId, objectTestLastId, undefined, `dev-duplicate-${Date.now()}`, 2, identity.id);
    await sendDeveloperFindPacket(packet, 'FIND duplicate first copy');
    await sendDeveloperFindPacket(packet, 'FIND duplicate second copy');
  }

  async function handleSendExpiredTest() {
    if (!identity || !objectTestPeerId || !objectTestLastId) return;
    await sendDeveloperFindPacket(await buildFindPacket(identity.id, objectTestPeerId, objectTestLastId, undefined, `dev-expired-${Date.now()}`, 2, identity.id, new Date(Date.now() - 1000).toISOString()), 'FIND expired');
  }

  async function handleSendUnknownResponseTest() {
    if (!identity || !objectTestPeerId || !objectTestLastId) return;
    await sendDeveloperFindPacket(await buildFindResponsePacket(identity.id, objectTestPeerId, objectTestLastId, `dev-unknown-${Date.now()}`, undefined, undefined, identity.id), 'unknown FIND_RESPONSE');
  }

  async function handleResendObjectTest() {
    const object = lastObjectTestRef.current;
    if (!identity || !object || !objectTestPeerId) return;
    try {
      const packetSigner: PacketSigner = (packet) => signString(identity.privateKey, canonicalize(packet));
      const packet = await buildObjectStorePacket(identity.id, objectTestPeerId, object, packetSigner);
      await objectTransportRef.current?.send(objectTestPeerId, packet);
      await refreshObjectStore();
      setObjectTestStatus(`Resent the same object ${object.object_id} to ${objectTestPeerId}`);
      addLog(`Resent the same generic browser test object ${object.object_id} to ${objectTestPeerId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`Object resend failed: ${message}`);
      addLog(`Generic object resend failed: ${message}`);
    }
  }

  async function handleFindObjectTest() {
    const objectId = objectTestLastId;
    const peerId = objectTestPeerId;
    const store = objectStoreRef.current;
    const transport = objectTransportRef.current;
    if (!identity || !objectId || !peerId || !store || !transport) return;
    try {
      await store.delete(objectId);
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      await refreshObjectStore();
      addLog(`FIND TEST: removed local copy ${objectId}; querying ${peerId}`);
      const found = await findObject(identity.id, peerId, objectId, transport, store, 2);
      if (!found) {
        setObjectTestStatus(`FIND TEST: FAIL - peer returned no object for ${objectId}`);
        addLog(`FIND TEST: FAIL - no object returned for ${objectId}`);
        return;
      }
      await refreshObjectStore();
      setObjectTestStatus(`FIND TEST: PASS - retrieved and stored ${found.object_id} from ${peerId}`);
      addLog(`OBJECT FIND requester validation/storage: validated and stored ${found.object_id} after response from ${peerId}`);
      addLog(`FIND TEST: PASS - validated and stored ${found.object_id} from ${peerId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`FIND TEST: FAIL - ${message}`);
      addLog(`FIND TEST: FAIL - ${message}`);
    }
  }

  async function handleFindMissingObjectTest() {
    const peerId = objectTestPeerId;
    const store = objectStoreRef.current;
    const transport = objectTransportRef.current;
    if (!identity || !peerId || !store || !transport) return;
    const missingObjectId = await sha256(`mycelium.find-missing-test:${identity.id}:${Date.now()}:${Math.random()}`);
    try {
      const found = await findObject(identity.id, peerId, missingObjectId, transport, store, 2);
      const localCopy = await store.get(missingObjectId);
      if (found || localCopy) {
        setObjectTestStatus(`FIND MISSING TEST: FAIL - unexpected object returned for ${missingObjectId}`);
        addLog(`FIND MISSING TEST: FAIL - unexpected object returned for ${missingObjectId}`);
        return;
      }
      setObjectTestStatus(`FIND MISSING TEST: PASS - peer returned no object for ${missingObjectId}`);
      addLog(`FIND MISSING TEST: PASS - no object stored for ${missingObjectId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`FIND MISSING TEST: FAIL - ${message}`);
      addLog(`FIND MISSING TEST: FAIL - ${message}`);
    }
  }

  function getPhase6ObjectIds() {
    return [...new Set(objectTestIds.split(/\s+/).map((objectId) => objectId.trim()).filter(Boolean))];
  }

  function selectPhase6ObjectIds(start: number, end: number) {
    const ids = getPhase6ObjectIds();
    setObjectTestIds(ids.slice(start, end).join('\n'));
  }

  async function handleCreatePhase6Set() {
    if (!identity) return;
    try {
      const store = objectStoreRef.current;
      if (!store) throw new Error('Object store is unavailable');
      const objectIdentity = createObjectIdentity(identity);
      const objects = await Promise.all(Array.from({ length: 5 }, (_, index) => createSignedObject({
        object_type: 'mycelium.phase6-browser-test',
        created_at: new Date().toISOString(),
        payload: { object_number: index + 1, test: 'phase6-aggregation' },
        replication_policy: {}
      }, objectIdentity)));
      for (const object of objects) await store.put(object);
      setObjectTestIds(objects.map((object) => object.object_id).join('\n'));
      await refreshObjectStore();
      setObjectTestStatus('Created five signed objects locally. Select a branch set and send it to the connected peer.');
      addLog(`PHASE 6 created five signed objects: ${objects.map((object) => object.object_id).join(',')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`Phase 6 setup failed: ${message}`);
      addLog(`PHASE 6 setup failed: ${message}`);
    }
  }

  async function handleCreatePhase7Set() {
    if (!identity) return;
    try {
      const store = objectStoreRef.current;
      if (!store) throw new Error('Object store is unavailable');
      const objectIdentity = createObjectIdentity(identity);
      const timestamps = ['2026-08-25T10:00:00.000Z', '2026-08-25T10:05:00.000Z', '2026-08-25T10:10:00.000Z'];
      const objects = await Promise.all(timestamps.map(async (createdAt, index) => createSignedObject({
        object_type: 'mycelium.phase7-browser-test',
        created_at: createdAt,
        payload: { object_number: index + 1, test: 'phase7-time-range-query' },
        replication_policy: {}
      }, objectIdentity)));
      for (const object of objects) await store.put(object);
      setObjectTestIds(objects.map((object) => object.object_id).join('\n'));
      setPhase7Author(objects[0]?.author ?? '');
      setPhase7StartTime('10:03');
      setPhase7EndTime('10:09');
      setPhase7SelectedObjectId(objects[0]?.object_id ?? '');
      setPhase7Results(objects.map((object) => ({ object_id: object.object_id, created_at: object.created_at, author: object.author })));
      await refreshObjectStore();
      setPhase7QueryStatus('Created the three Phase 7 signed objects for peer B. Use the existing send controls to distribute them across peers A/B/C.');
      addLog(`PHASE7 CREATE requestId=manual-batch author=${identity.id} objects=${objects.map((object) => `${object.object_id}@${object.created_at}`).join(', ')}`);
      setObjectTestStatus('Created three Phase 7 test objects for peer B.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase7QueryStatus(`Phase 7 setup failed: ${message}`);
      addLog(`PHASE7 CREATE failed: ${message}`);
    }
  }

  async function handleRunPhase7Query(mode: 'narrow' | 'broad') {
    if (!identity || !objectTestPeerId) {
      setPhase7QueryStatus('Select a peer before running the Phase 7 query.');
      return;
    }
    const author = phase7Author || identity.publicKey;
    const lowerBound = mode === 'narrow' ? '2026-08-25T10:03:00.000Z' : '2026-08-25T10:00:00.000Z';
    const upperBound = mode === 'narrow' ? '2026-08-25T10:09:00.000Z' : '2026-08-25T10:11:00.000Z';
    const requestId = `phase7-query-${Date.now()}`;
    const transport = objectTransportRef.current;
    if (!transport) {
      setPhase7QueryStatus('Object transport is unavailable.');
      return;
    }
    const observed = new Map<string, { object_id: string; created_at: string; author: string }>();
    const unsubscribe = transport.onPacket((peerId, packet) => {
      if (packet.type !== 'FIND_RESPONSE' || packet.payload.requestId !== requestId) return;
      const objects = Array.isArray(packet.payload.objects) ? packet.payload.objects : packet.payload.object ? [packet.payload.object] : [];
      for (const object of objects) {
        if (!object || typeof object !== 'object') continue;
        const candidate = object as { object_id: string; created_at: string; author: string };
        if (candidate.object_id) observed.set(candidate.object_id, candidate);
      }
    });

    setPhase7RequestId(requestId);
    setPhase7QueryStatus(`Running Phase 7 query... requestId=${requestId}`);
    addLog(`PHASE7 QUERY START requestId=${requestId} author=${author} peer=${objectTestPeerId} start=${lowerBound} end=${upperBound}`);
    const packet = await buildTimeRangeFindPacket(identity.id, objectTestPeerId, author, lowerBound, upperBound, undefined, requestId, 2, identity.id, new Date(Date.now() + 5000).toISOString());
    await transport.send(objectTestPeerId, packet);
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    unsubscribe();
    const results = [...observed.values()].filter((object) => object.author === author && new Date(object.created_at) >= new Date(lowerBound) && new Date(object.created_at) <= new Date(upperBound));
    const uniqueResults = [...new Map(results.map((object) => [object.object_id, object])).values()];
    setPhase7Results(uniqueResults);
    setPhase7QueryStatus(`Phase 7 result: ${uniqueResults.length} object(s) returned for ${author} ${lowerBound} -> ${upperBound}: ${uniqueResults.map((object) => object.object_id).join(', ') || 'none'}`);
    addLog(`PHASE7 QUERY DONE requestId=${requestId} author=${author} peer=${objectTestPeerId} lower=${lowerBound} upper=${upperBound} returned=${uniqueResults.length} ids=${uniqueResults.map((object) => object.object_id).join(', ') || 'none'}`);
    if (uniqueResults.length > 0) {
      addLog(`PHASE7 FINAL RETURN requestId=${requestId} ids=${uniqueResults.map((object) => object.object_id).join(', ')}`);
    }
  }

  async function handleFindPhase7SingleObject() {
    const transport = objectTransportRef.current;
    const store = objectStoreRef.current;
    const objectId = phase7SelectedObjectId || objectTestLastId || objectTestIds.split(/\s+/).filter(Boolean)[0];
    if (!identity || !objectTestPeerId || !transport || !store || !objectId) {
      setPhase7QueryStatus('Select a peer and a valid object ID before running the single-object FIND.');
      return;
    }
    try {
      const found = await findObject(identity.id, objectTestPeerId, objectId, transport, store, 2);
      const status = found ? `Single-object FIND returned ${found.object_id}` : `Single-object FIND returned no object for ${objectId}`;
      setPhase7QueryStatus(status);
      addLog(`PHASE7 SINGLE FIND requestId=single-${Date.now()} peer=${objectTestPeerId} object=${objectId} result=${found ? found.object_id : 'none'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase7QueryStatus(`Single-object FIND failed: ${message}`);
      addLog(`PHASE7 SINGLE FIND failed: ${message}`);
    }
  }

  async function handleSendPhase6Listed() {
    if (!identity || !objectTestPeerId) return;
    const objectIds = getPhase6ObjectIds();
    const store = objectStoreRef.current;
    if (!store || objectIds.length === 0) return;
    try {
      const packetSigner: PacketSigner = (packet) => signString(identity.privateKey, canonicalize(packet));
      let sent = 0;
      for (const objectId of objectIds) {
        const object = await store.get(objectId);
        if (!object) continue;
        await objectTransportRef.current?.send(objectTestPeerId, await buildObjectStorePacket(identity.id, objectTestPeerId, object, packetSigner));
        sent += 1;
      }
      setObjectTestStatus(`Sent ${sent} listed objects to ${objectTestPeerId}`);
      addLog(`PHASE 6 seeded ${sent} objects to ${objectTestPeerId}: ${objectIds.join(',')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`Phase 6 seed failed: ${message}`);
      addLog(`PHASE 6 seed failed: ${message}`);
    }
  }

  async function handleRemovePhase6Listed() {
    const store = objectStoreRef.current;
    if (!store) return;
    const objectIds = getPhase6ObjectIds();
    for (const objectId of objectIds) await store.delete(objectId);
    await refreshObjectStore();
    setObjectTestStatus(`Removed ${objectIds.length} listed objects locally`);
    addLog(`PHASE 6 removed listed objects locally: ${objectIds.join(',')}`);
  }

  async function handleClearObjectStore() {
    const store = objectStoreRef.current;
    if (!store) return;
    const objects = await store.query();
    for (const object of objects) await store.delete(object.object_id);
    await refreshObjectStore();
    setObjectTestStatus(`Cleared ${objects.length} objects from the local object store`);
    addLog(`OBJECT STORE cleared locally: ${objects.length} objects removed`);
  }

  async function handleFindPhase6Listed() {
    if (!identity || !objectTestPeerId) return;
    const objectIds = getPhase6ObjectIds();
    const store = objectStoreRef.current;
    const transport = objectTransportRef.current;
    if (!store || objectIds.length < 2 || !transport) return;
    try {
      addLog(`PHASE 6 FIND started via ${objectTestPeerId}: requested=${objectIds.join(',')}`);
      const found = await findObjects(identity.id, objectTestPeerId, objectIds, transport, store, 2, 1000);
      await refreshObjectStore();
      setObjectTestStatus(`FIND returned ${found.length}/${objectIds.length} distinct objects`);
      addLog(`PHASE 6 FIND completed via ${objectTestPeerId}: returned=${found.map((object) => object.object_id).join(',')} distinct=${new Set(found.map((object) => object.object_id)).size}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObjectTestStatus(`Phase 6 FIND failed: ${message}`);
      addLog(`PHASE 6 FIND failed: ${message}`);
    }
  }

  async function handleSendPostToPeer(post: LocalPostView) {
    if (!selectedContactId) return;
    const manager = peerManagersRef.current[selectedContactId];
    if (!manager || selectedContactId !== activePeerId) return;
    const object = await objectStoreRef.current?.get(post.object.object_id);
    if (!object) return;
    manager.sendObject(object);
    addLog(`Sent canonical object ${object.object_id} to peer ${selectedContactId}`);
  }

  const connectedPeersCount = connectedPeerIds.length;
  const syncStatus = signallingStatus === 'connected' ? 'synced' : signallingStatus;
  const activeProfileContact = profileContactId ? contacts.find((c) => c.fingerprint === profileContactId) : undefined;
  const myProfileContact = useMemo<Contact | undefined>(() => {
    if (!identity) return undefined;
    const displayName = myProfile.displayName.trim() || fingerprintToHumanName(identity.id);
    return {
      publicKey: identity.publicKey,
      fingerprint: identity.id,
      displayName,
      addedAt: new Date().toISOString(),
      followed: false,
      online: false,
      connected: false,
      profile: {
        protocol: 'mycelium',
        version: 1,
        type: 'profile',
        id: identity.id,
        author: identity.id,
        timestamp: new Date().toISOString(),
        displayName,
        bio: myProfile.bio.trim(),
        tags: [],
        signature: ''
      } as any
    };
  }, [identity, myProfile.displayName, myProfile.bio]);
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
        connectedPeerIds={connectedPeerIds}
        syncStatus={syncStatus}
        myFingerprint={identity?.id}
        unreadCount={contacts.filter((contact) => (contact.unreadMessages || 0) > 0).length}
        onOpenMyProfile={() => setPage('myProfile')}
        onOpenSettings={() => setPage('settings')}
        onOpenPeopleInbox={() => setPage('people')}
        onRefresh={() => {
          void handleRefreshHomeFeed();
          void handleFetchDiscovery();
        }}
      />

      <main id="page-content" className={`page-content${page === 'chat' ? ' chat-active' : ''}`}>
        {page === 'home' && (
          <HomePage
            posts={visibleHomePosts}
            contacts={contacts}
            postText={newPostContent}
            onPostTextChange={setNewPostContent}
            onSubmitPost={handleCreatePost}
            onRefreshPosts={handleRefreshHomeFeed}
            canCreatePost={Boolean(identity)}
            onAuthorClick={handleOpenPeerProfile}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onReply={(postId, content, publishToDiscovery) => {
              if (content && content.trim()) {
                void handleCreatePost(Boolean(publishToDiscovery), postId, content);
              }
            }}
            onHide={handleHidePost}
            isRefreshing={homeSyncBusy}
          />
        )}

        {page === 'people' && (
          <PeoplePage
            contacts={visibleContacts}
            myPeerId={identity.id}
            onViewProfile={handleOpenPeerProfile}
            onMessage={handleSelectContact}
            onToggleFollow={handleToggleFollow}
            onBlockPeer={handleBlockPeer}
            onAddPeerAddress={handleAddPeerByAddress}
          />
        )}

        {page === 'discover' && (
          <DiscoverPage
            discoveryPosts={discoverFeedPosts}
            contacts={contacts}
            myPeerId={identity.id}
            myPublicKey={identity.publicKey}
            onRefreshDiscovery={handleFetchDiscovery}
            onAuthorClick={handleOpenPeerProfile}
            onFollow={handleToggleFollow}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onHide={handleHideDiscoveryPost}
            onBlock={handleBlockPeer}
            getRecommendationSummary={getRecommendationSummary}
          />
        )}

        {page === 'profile' && activeProfileContact && (
          <ProfilePage
            contact={activeProfileContact}
            posts={profilePosts}
            likedPosts={likedProfilePosts}
            myPeerId={identity.id}
            notice={profileNotice}
            onFollowToggle={() => handleToggleFollow(activeProfileContact.publicKey)}
            onBlock={() => handleBlockPeer(activeProfileContact.fingerprint)}
            onMessage={() => handleSelectContact(activeProfileContact.fingerprint)}
            onAuthorClick={handleOpenPeerProfile}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onHide={handleHidePost}
            getRecommendationSummary={getRecommendationSummary}
          />
        )}

        {page === 'myProfile' && myProfileContact && (
          <ProfilePage
            contact={myProfileContact}
            posts={postViews.filter((post) => (post.authorFingerprint === identity?.id || post.object.author === identity?.publicKey) && !isHiddenPost(post)).sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime())}
            likedPosts={postViews.filter((post) => getRecommendationSummary(post.object.object_id).recommended_by_me && post.object.author !== identity?.publicKey && !isHiddenPost(post)).sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime())}
            onAuthorClick={handleOpenPeerProfile}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onHide={handleHidePost}
            getRecommendationSummary={getRecommendationSummary}
            isOwnProfile
            profileSettingsOpen={profileSettingsOpen}
            onToggleProfileSettings={() => setProfileSettingsOpen((prev) => !prev)}
            profileSettings={
              <div className="card profile-edit-card">
                <label>
                  Nickname
                  <input
                    value={myProfile.displayName || fingerprintToHumanName(identity?.id ?? '')}
                    onChange={(e) => setMyProfile((prev) => ({ ...prev, displayName: e.target.value }))}
                    placeholder="Your display name"
                  />
                </label>
                <label>
                  Bio
                  <textarea value={myProfile.bio} onChange={(e) => setMyProfile((prev) => ({ ...prev, bio: e.target.value }))} placeholder="Write a short bio" />
                </label>
                <h3>Home Feed Mix</h3>
                <p className="note">Set how much of your home feed should come from people you follow; the rest comes from their recommendations.</p>
                <label>
                  From people you follow: {myProfile.feedMix.followedAuthors}%
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={myProfile.feedMix.followedAuthors}
                    onChange={(e) => setMyProfile((prev) => ({
                      ...prev,
                      feedMix: {
                        ...prev.feedMix,
                        followedAuthors: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                        followedLikes: Math.max(0, 100 - Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                      }
                    }))}
                  />
                </label>
                <div className="row">
                  <button className="btn" onClick={() => {
                    const rawDisplayName = myProfile.displayName.trim();
                    const nextDisplayName = rawDisplayName && /^([0-9a-fA-F]{16,})$/.test(rawDisplayName)
                      ? fingerprintToHumanName(identity?.id ?? rawDisplayName)
                      : (rawDisplayName || fingerprintToHumanName(identity?.id ?? ''));

                    const persistedProfile = {
                      ...myProfile,
                      displayName: nextDisplayName,
                      bio: myProfile.bio.trim(),
                      blockedPeers: myProfile.blockedPeers,
                      hiddenPeers: myProfile.hiddenPeers
                    };
                    setMyProfile(persistedProfile);
                    localStorage.setItem('myProfile', JSON.stringify(persistedProfile));
                    addLog('Profile saved locally');
                    contacts.forEach((contact) => {
                      if (!contact.connected) return;
                      peerManagersRef.current[contact.fingerprint]?.sendMetadata(buildPeerMetadata(contact.fingerprint));
                    });
                  }}>Save Profile</button>
                  <button className="btn secondary" onClick={handleExportIdentity}>Export Identity</button>
                </div>
                <div className="row">
                  <button className="btn secondary" onClick={handleImportIdentity}>Import Identity</button>
                  <button className="btn secondary" onClick={handleCreateIdentity}>Create New Identity</button>
                  <button className="btn secondary" onClick={handleClearIdentity}>Clear Identity (Log Out)</button>
                </div>
                <div className="blocked-peers-settings">
                  <CollapsibleSection
                    title="Blocked Peers"
                    summary={`${myProfile.blockedPeers.length}`}
                    isOpen={blockedPeersOpen}
                    onToggle={() => setBlockedPeersOpen((open) => !open)}
                  >
                    <BlockedPeerList peerIds={myProfile.blockedPeers} onUnblock={handleUnblockPeer} />
                  </CollapsibleSection>
                  <CollapsibleSection
                    title="Hidden Posts"
                    summary={`${postViews.filter((post) => isHiddenPost(post)).length}`}
                    isOpen={hiddenPostsOpen}
                    onToggle={() => setHiddenPostsOpen((open) => !open)}
                  >
                    <HiddenPostList posts={postViews.filter((post) => isHiddenPost(post))} contacts={contacts} onUnhide={handleUnhidePost} />
                  </CollapsibleSection>
                </div>
              </div>
            }
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
            identityId={identity?.id ?? ''}
            publicKey={identity?.publicKey ?? ''}
            contacts={contacts.length}
            posts={postViews.length}
            logs={logs}
            onClearLogs={() => setLogs([])}
            signalEndpoint={signalEndpoint}
            discoveryEndpoint={discoveryEndpoint}
            connectionStatus={connectionStatus}
            signallingStatus={signallingStatus}
            connectedPeers={connectedPeersCount}
            syncStatus={syncStatus}
            objectTransportTest={(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ? {
              connectedPeers: objectTransportRef.current?.connectedPeers() ?? [],
              selectedPeerId: objectTestPeerId,
              objectIds: objectTestIds,
              suppressFindResponses: suppressPhase6FindResponses,
              status: objectTestStatus,
              objects: objectStoreObjects,
              onPeerChange: setObjectTestPeerId,
              onObjectIdsChange: setObjectTestIds,
              onCreateSet: () => { void handleCreatePhase6Set(); },
              onSelectFirstBranch: () => selectPhase6ObjectIds(0, 3),
              onSelectSecondBranch: () => selectPhase6ObjectIds(2, 5),
              onSelectAll: () => selectPhase6ObjectIds(0, 5),
              onSendListed: () => { void handleSendPhase6Listed(); },
              onRemoveListed: () => { void handleRemovePhase6Listed(); },
              onFindListed: () => { void handleFindPhase6Listed(); },
              onToggleSuppressFindResponses: () => setSuppressPhase6FindResponses((current) => !current),
              onClearObjectStore: () => { void handleClearObjectStore(); },
              onRefresh: () => { void refreshObjectStore(); }
            } : undefined}
            phase7Test={(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ? {
              author: phase7Author,
              startTime: phase7StartTime,
              endTime: phase7EndTime,
              status: phase7QueryStatus,
              requestId: phase7RequestId,
              objectIds: objectTestIds,
              objects: phase7Results,
              selectedObjectId: phase7SelectedObjectId,
              onAuthorChange: setPhase7Author,
              onStartTimeChange: setPhase7StartTime,
              onEndTimeChange: setPhase7EndTime,
              onSelectedObjectIdChange: setPhase7SelectedObjectId,
              onCreateSet: () => { void handleCreatePhase7Set(); },
              onUseCurrentObjectIds: () => setObjectTestIds(objectTestIds),
              onRunNarrow: () => { void handleRunPhase7Query('narrow'); },
              onRunBroad: () => { void handleRunPhase7Query('broad'); },
              onRunSingleObjectFind: () => { void handleFindPhase7SingleObject(); },
              onRefresh: () => { void refreshObjectStore(); }
            } : undefined}
            onResetApp={() => {
              setHiddenPostIds(new Set());
              setHiddenDiscoveryIds(new Set());
              setCollapsedHeader(false);
              localStorage.removeItem('hiddenPosts');
              localStorage.removeItem('hiddenDiscovery');
              localStorage.removeItem('myceliumHeaderCollapsed');
            }}
            onClearOldMessages={() => { void handleClearOldPeerCache(); }}
            onClearAllMessages={() => { void handleClearAllPeerCache(); }}
          />
        )}
      </main>

      <TabBar active={page === 'home' || page === 'people' || page === 'discover' ? page : 'home'} onChange={handlePageChange} />
    </div>
  );
}

export default App;
