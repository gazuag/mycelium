import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateIdentityKeyPair, deriveFingerprint, exportPrivateKey, exportPublicKey, sha256, signString } from './crypto/identity';
import { decryptJsonPayload, encryptJsonPayload, type VaultBlob } from './crypto/key-vault';
import { connectToSignalling, requestOnlinePeerList, resolveOnlinePeerList, resolveSignalServerUrl, SignalMessage } from './p2p/signalling';
import { configureIceServers, PeerConnectionManager } from './p2p/webrtc';
import { closeAndRemovePeerManager } from './p2p/peer-manager-registry';
import {
  getAuthenticatedConnectedAuthors as collectAuthenticatedConnectedAuthors,
  recordAuthenticatedPeerAuthor,
  removeAuthenticatedPeerAuthor,
  type AuthenticatedPeerAuthorMap
} from './p2p/authenticated-peer-authors';
import {
  DEFAULT_PREFERRED_CONNECTION_TARGET,
  PeerConnectionCapacity,
  PeerRecoveryCoordinator
} from './p2p/peer-recovery';
import { estimateLocalPeerUsefulness } from './p2p/peer-usefulness';
import { PeerConnectionObjectTransport } from './p2p/object-transport';
import {
  connectionObservationId,
  exportLocalObservations,
  newConnectionAttemptObservationId,
  recordConnectionClosed,
  recordConnectionFailure,
  recordConnectionOpened,
  recordFindForwarding,
  recordValidatedObjectSupply,
  type PeerIdentityEvidence
} from './p2p/local-observations';
import { createPeerCandidateIntake } from './p2p/peer-candidates';
import { wrapFindTransport } from './object-layer/find-transport-adapter';
import { collectFindResults } from './object-layer/find-client';
import { createDmEvents } from './object-layer/dm-events';
import { createInboxService } from './object-layer/inbox-service';
import { createDmService } from './object-layer/dm-service';
import { createOutboxService } from './object-layer/outbox-service';
import { createFeedRequestAdapter, type ProcessedFeedBatchHandler } from './object-layer/feed-request-adapter';
import { contactWithIdentityProfile, dedupeContactsByFingerprint } from './contact-utils';
import { DmUnreadProvider } from './hooks/useDmUnread';
import { useReplyUnreadController } from './hooks/useReplyUnread';
import { listConversations, previewConversation, type ConversationSummary } from './object-layer/conversations';
import { addEncryptionKeyBinding, applyEncryptionKeyBinding, createEncryptionKeyBinding, getContactEncryptionKey } from './crypto/dm-crypto';
import { appendBoundedLog, redactNetworkAddresses } from './diagnostics';
import { filterTombstonedObjects, getFindQueryCriteria, prepareFindQueryPage } from './object-layer/transport';
import { ensureIdentityEncryptionKeyPair, identityBackupFields, loadIdentity, saveIdentity, deleteIdentity, loadContacts, saveContact, deleteContact, saveDiscoveryInteraction, loadDiscoveryInteractions, clearAllLocalData, loadProfile, loadInboxCursor, saveInboxCursor, loadInboxBackfillState, saveInboxBackfillState, loadFeedCursor, saveFeedCursor } from './storage/idb';
import { fetchDiscovery, handleDiscoveryResult, publishObject, validateDiscoveryObjects } from './services/discovery';
import { AppHeader } from './components/AppHeader';
import { TabBar } from './components/TabBar';
import { HomePage } from './pages/HomePage';
import { ConversationPage } from './pages/ConversationPage';
import { DiscoverPage } from './pages/DiscoverPage';
import { MessagesPage } from './pages/MessagesPage';
import { ProfilePage } from './pages/ProfilePage';
import { RelationshipsPage } from './pages/RelationshipsPage';
import type { RelationshipTab } from './pages/RelationshipsPage';
import { DmChatPage } from './pages/DmChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { LandingPage } from './pages/LandingPage';
import { BlockedPeerList } from './components/BlockedPeerList';
import { HiddenPostList } from './components/HiddenPostList';
import { CollapsibleSection } from './components/CollapsibleSection';
import { ExternalImageLimitContext } from './components/MarkdownContent';
import { canonicalize, createPacketId, type MyceliumPacket, type PacketSigner } from './p2p/protocol';
import { dispatchAuthenticatedProfileMetadata } from './p2p/profile-auth';
import { webPushManager } from './services/web-push';
import {
  classifyNewlyAcceptedObjectNotification,
  createPushWakeOutboxFlusher,
  DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES,
  DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES,
  parseWebPushNotificationPreferences,
  showWebPushNotificationOnce,
  updateWebPushNotificationPreference,
  WEB_PUSH_NOTIFICATION_PREFERENCES_STORAGE_KEY,
  type WebPushNotificationCategory
} from './services/web-push-notifications';
import {
  envelopeObjectId,
  parseIncomingWebPushEnvelope,
  WEB_PUSH_STAGED_MESSAGE_TYPE,
  WEB_PUSH_STAGING_MAX_ENTRIES
} from './services/web-push-inbox';
import { acceptDeleteRequest, applyFindQueryLimit, buildFindPacket, buildFindResponseObjectsPacket, buildFindResponsePacket, buildForwardedFindPacket, buildLocalQueryCriteria, buildObjectBatchPacket, buildObjectStorePacket, buildTimeRangeFindPacket, createDeleteRequest, createLocalPostView, createObjectIdentity, createPostObjectPayload, createReplyObjectPayload, createSignedIdentityObject, createSignedObject, createSignedRecommendationObject, DELETE_REQUEST_OBJECT_TYPE, ensurePostChainCached, expandObjectsWithPostChains, findLatestIdentityObjectsByConnectionQuery, findObjectsByFindQueryPage, findObject, findObjects, FindAggregation, forwardFindRequestToChild, getFindObjectIds, getLatestIdentityObject, getLatestIdentityObjects, hydratePostViews, IDENTITY_OBJECT_TYPE, IndexedDbLocalPostMetadataStore, IndexedDbObjectStore, IndexedDbOutboxStore, IndexedDbRecommendationSequenceStore, isDeleteRequest, isDeletionAwareObjectStore, loadPostAncestry, localPostMetadata, mergeLocalPostViews, postReplyTo, queryFeedPage, RecommendationIndex, receiveAndReplicate, receiveBatchAndReplicate, receiveObjectPacket, replicateObject, respondToFindPacket, selectFindPeers, selectFollowedPosts, selectRecommendationCandidates, sendFindPacketToConnectedPeer, sendObjectBatches, sendObjectToPeers, sendReplyToAuthor, shouldRetainFindRequestRoute, storeDiscoveredIdentityProfiles, storeRequestedIdentityProfile, syncFeedFromPeer, upsertLocalPostView, validateFindResponseObjects, validateIdentityObject, validateObject, type DeletionAwareObjectStore, type DeletionTombstone, type DistributedObject, type FeedCursor, type FeedPageMetadata, type FindResponsePacket, type IdentityObject, type LocalPostMetadataStore, type LocalPostView, type ObjectPacket, type ObjectStore, type PostAncestryResult, type PostChainResult, type PostMention, type PostObject, type PostParentResolver, type RecommendationSummary } from './object-layer';
import { fingerprintToHumanName } from './utils/fingerprintNames';
import { parsePeerId } from './utils/peerId';
import { parseAddPeerInvitePath } from './utils/addPeerInvite';
import { buildLocalDirectReplyCounts } from './utils/localReplyCounts';
import { composeHomeFeed } from './utils/homeFeed';
import { mentionsPresentInText } from './utils/postMentions';
import { MAX_POST_CONTENT_LENGTH } from './object-layer/post-state';
import { isObjectExpired } from './object-layer/envelope';
import {
  checkExternalImageSizes,
  DEFAULT_EXTERNAL_IMAGE_LIMIT_MB,
  EXTERNAL_IMAGE_LIMIT_STORAGE_KEY,
  MAX_EXTERNAL_IMAGE_LIMIT_MB,
  parseExternalImageLimitMb
} from './markdown/external-content';
import {
  BYTES_PER_MB,
  DEFAULT_OBJECT_STORAGE_BYTES,
  MIN_OBJECT_STORAGE_BYTES,
  OBJECT_STORAGE_LIMIT_STORAGE_KEY,
  parseObjectStorageLimitMb
} from './object-layer/storage-gc';
import {
  DEFAULT_HOME_FEED_INJECTION_THRESHOLDS,
  HomeFeedInjectionScheduler,
  homeFeedInjectionStorageKey,
  parseHomeFeedInjectionState
} from './utils/homeFeedInjection';
import { fetchPeerPool, fetchPopularPeers, handlePeerDiscoveryResult, type PopularPeer, type PopularPeerWithIdentityProfile } from './services/peer-discovery';
import { FALLBACK_ICE_SERVERS, fetchMeteredIceServers } from './services/metered-turn';
import type { ConnectionState, Contact, PeerMetadata } from './types';

interface IdentityRecord {
  key: string;
  publicKey: string;
  privateKey: string;
  id: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

interface ConversationAncestryState {
  postId: string;
  loading: boolean;
  result?: PostAncestryResult;
  error?: true;
}

export type LogCategory = 'pingPong' | 'discovery' | 'postRequests' | 'objectStorage' | 'ice' | 'general';
export interface LogEntry {
  text: string;
  category: LogCategory;
}

function classifyLogEntry(entry: string): LogCategory {
  if (/\b(PING|PONG|ping loop|keep.?alive)\b/i.test(entry)) return 'pingPong';
  if (/\bDISCOVERY\b|discovery/i.test(entry)) return 'discovery';
  if (/\bICE\b|candidate pair|candidate-pair/i.test(entry)) return 'ice';
  if (/\b(OBJECT|FIND|generic object)\b|PHASE ?[67]/i.test(entry)) return 'objectStorage';
  if (/\b(post|posts|feed|recommendation|home updates)\b/i.test(entry)) return 'postRequests';
  return 'general';
}

function loadObjectStorageLimitMb(): number {
  try {
    return parseObjectStorageLimitMb(localStorage.getItem(OBJECT_STORAGE_LIMIT_STORAGE_KEY));
  } catch {
    return DEFAULT_OBJECT_STORAGE_BYTES / BYTES_PER_MB;
  }
}

function loadExternalImageLimitMb(): number {
  try {
    return parseExternalImageLimitMb(localStorage.getItem(EXTERNAL_IMAGE_LIMIT_STORAGE_KEY));
  } catch {
    return DEFAULT_EXTERNAL_IMAGE_LIMIT_MB;
  }
}

type PageKey = 'home' | 'messages' | 'relationships' | 'discover' | 'profile' | 'myProfile' | 'chat' | 'settings';

interface AppNavigationState {
  page: PageKey;
  conversationPostId: string | null;
  focusedReplyId: string | null;
  profileContactId: string | null;
  relationshipOwnerId: string | null;
  relationshipTab: RelationshipTab;
  chatContactId: string | null;
  scrollTop: number;
  conversationReturnScrollTop: number | null;
}

const APP_NAVIGATION_STATE_KEY = 'myceliumNavigation';
const PUBLISH_TO_DISCOVERY_STORAGE_KEY = 'myceliumPublishToDiscovery';
const PUSH_OUTBOX_FLUSH_COOLDOWN_MS = 30_000;
const MAX_DEFERRED_DM_NOTIFICATION_IDS = 128;
const PAGE_KEYS: PageKey[] = ['home', 'messages', 'relationships', 'discover', 'profile', 'myProfile', 'chat', 'settings'];

function readAppNavigationState(state: unknown): AppNavigationState {
  const historyState = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  const navigation = historyState[APP_NAVIGATION_STATE_KEY];
  const appState = navigation && typeof navigation === 'object' ? navigation as Record<string, unknown> : {};
  const page = appState.page === 'people'
    ? 'messages'
    : PAGE_KEYS.includes(appState.page as PageKey) ? appState.page as PageKey : 'home';
  const legacyConversationId = historyState.myceliumConversationPostId;
  const conversationPostId = typeof appState.conversationPostId === 'string'
    ? appState.conversationPostId
    : typeof legacyConversationId === 'string' ? legacyConversationId : null;
  const legacyFocusedReplyId = historyState.myceliumFocusedReplyId;
  return {
    page,
    conversationPostId,
    focusedReplyId: typeof appState.focusedReplyId === 'string'
      ? appState.focusedReplyId
      : typeof legacyFocusedReplyId === 'string' ? legacyFocusedReplyId : null,
    profileContactId: typeof appState.profileContactId === 'string' ? appState.profileContactId : null,
    relationshipOwnerId: typeof appState.relationshipOwnerId === 'string' ? appState.relationshipOwnerId : null,
    relationshipTab: appState.relationshipTab === 'followers' ? 'followers' : 'following',
    chatContactId: typeof appState.chatContactId === 'string' ? appState.chatContactId : null,
    scrollTop: typeof appState.scrollTop === 'number' && Number.isFinite(appState.scrollTop) ? appState.scrollTop : 0,
    conversationReturnScrollTop: typeof appState.conversationReturnScrollTop === 'number'
      && Number.isFinite(appState.conversationReturnScrollTop)
      ? appState.conversationReturnScrollTop
      : null
  };
}

function withAppNavigationState(historyState: unknown, navigation: AppNavigationState): Record<string, unknown> {
  const state = historyState && typeof historyState === 'object' ? historyState as Record<string, unknown> : {};
  return { ...state, [APP_NAVIGATION_STATE_KEY]: navigation };
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

function isValidPeerFingerprint(value: string) {
  return /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/i.test(value.trim());
}

function observeValidatedObjectSupply(
  peerId: string,
  object: DistributedObject,
  reportError: (message: string) => void
) {
  void recordValidatedObjectSupply(peerId, object.object_id, object.author)
    .catch((error: unknown) => reportError(`Failed to record validated object supply from ${peerId}: ${error instanceof Error ? error.message : String(error)}`));
}

function App() {
  const peerManagersRef = useRef<Record<string, PeerConnectionManager>>({});
  const authenticatedPeerManagersRef = useRef(new WeakSet<PeerConnectionManager>());
  const authenticatedPeerAuthorsRef = useRef<AuthenticatedPeerAuthorMap<PeerConnectionManager>>(new Map());
  const onlinePeerDiscoveryStartedRef = useRef(new WeakSet<PeerConnectionManager>());
  const onlinePeerDiscoveryRef = useRef<(() => Promise<void>) | null>(null);
  const peerRecoveryRef = useRef<PeerRecoveryCoordinator | null>(null);
  const peerCapacityRef = useRef<PeerConnectionCapacity | null>(null);
  const activePeerAttemptsRef = useRef(new Set<string>());
  const peerRecoveryAttemptResolversRef = useRef(new Map<string, (connected: boolean) => void>());
  const peerDisconnectedTimeoutsRef = useRef(new Map<string, number>());
  const signallingSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const suppressReconnectRef = useRef(false);
  const contactsRef = useRef<Contact[]>([]);
  const postViewsRef = useRef<LocalPostView[]>([]);
  const homeFeedInjectionSchedulerRef = useRef<HomeFeedInjectionScheduler | null>(null);
  const homeFeedInjectionCandidatesRef = useRef<{ recommendations: LocalPostView[]; discovery: LocalPostView[] }>({
    recommendations: [],
    discovery: []
  });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>('idle');
  const [signallingStatus, setSignallingStatus] = useState('idle');
  const signallingStatusRef = useRef(signallingStatus);
  signallingStatusRef.current = signallingStatus;
  const [connectedPeerIds, setConnectedPeerIds] = useState<string[]>([]);
  const [signallingReconnectTick, setSignallingReconnectTick] = useState(0);
  const [remoteId, setRemoteId] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsRef = useRef(logs);
  logsRef.current = logs;
  const [dataChannelOpen, setDataChannelOpen] = useState(false);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [postViews, setPostViews] = useState<LocalPostView[]>([]);
  const [deletionTombstones, setDeletionTombstones] = useState<DeletionTombstone[]>([]);
  const initialNavigation = readAppNavigationState(window.history.state);
  const [page, setPage] = useState<PageKey>(initialNavigation.page);
  const [conversationPostId, setConversationPostId] = useState<string | null>(initialNavigation.conversationPostId);
  const activePageRef = useRef<PageKey | null>(initialNavigation.conversationPostId ? null : initialNavigation.page);
  const [conversationFocusPostId, setConversationFocusPostId] = useState<string | null>(initialNavigation.focusedReplyId);
  const [conversationAncestry, setConversationAncestry] = useState<ConversationAncestryState | null>(null);
  const conversationReturnScrollTopRef = useRef(initialNavigation.conversationReturnScrollTop ?? 0);
  const pendingScrollRestoreRef = useRef<number | null>(initialNavigation.scrollTop);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [profileContactId, setProfileContactId] = useState<string | null>(initialNavigation.profileContactId);
  const [relationshipOwnerId, setRelationshipOwnerId] = useState<string | null>(initialNavigation.relationshipOwnerId);
  const [relationshipTab, setRelationshipTab] = useState<RelationshipTab>(initialNavigation.relationshipTab);
  const [chatContactId, setChatContactId] = useState<string | null>(initialNavigation.chatContactId);
  const [collapsedHeader, setCollapsedHeader] = useState(true);
  const [hiddenPostIds, setHiddenPostIds] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('hiddenPosts') || '[]')));
  const [hiddenDiscoveryIds, setHiddenDiscoveryIds] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('hiddenDiscovery') || '[]')));
  const hiddenPostIdsRef = useRef(hiddenPostIds);
  const hiddenDiscoveryIdsRef = useRef(hiddenDiscoveryIds);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [blockedPeersOpen, setBlockedPeersOpen] = useState(false);
  const [hiddenPostsOpen, setHiddenPostsOpen] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const addPeerInviteHandledRef = useRef(false);
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
    messages: 0,
    discover: 0,
    profile: 0,
    relationships: 0,
    myProfile: 0,
    chat: 0,
    settings: 0
  });
  const [discoveryPosts, setDiscoveryPosts] = useState<LocalPostView[]>([]);
  const [discoveryReplyPosts, setDiscoveryReplyPosts] = useState<LocalPostView[]>([]);
  const [possiblePeerIds, setPossiblePeerIds] = useState<string[]>([]);
  const [popularPeers, setPopularPeers] = useState<PopularPeerWithIdentityProfile[]>([]);
  const [conversationSummaries, setConversationSummaries] = useState<ConversationSummary[]>([]);
  const [conversationPreviews, setConversationPreviews] = useState<Record<string, string>>({});
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [conversationListError, setConversationListError] = useState<string | null>(null);
  const [conversationPreviewError, setConversationPreviewError] = useState<string | null>(null);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [objectStorageLimitMb, setObjectStorageLimitMb] = useState(loadObjectStorageLimitMb);
  const objectStorageLimitBytesRef = useRef(objectStorageLimitMb * BYTES_PER_MB);
  const [objectStorageUsedBytes, setObjectStorageUsedBytes] = useState<number | null>(null);
  const [externalImageLimitMb, setExternalImageLimitMb] = useState(loadExternalImageLimitMb);
  const [publishToDiscovery, setPublishToDiscovery] = useState(() => {
    try {
      return localStorage.getItem(PUBLISH_TO_DISCOVERY_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [webPushNotificationPreferences, setWebPushNotificationPreferences] = useState(() => {
    try {
      return parseWebPushNotificationPreferences(localStorage.getItem(WEB_PUSH_NOTIFICATION_PREFERENCES_STORAGE_KEY));
    } catch {
      return DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES;
    }
  });
  const [recommendationRevision, setRecommendationRevision] = useState(0);
  const [homeFeedInjectionRevision, setHomeFeedInjectionRevision] = useState(0);
  const [homeFeedInjectionFrequencies, setHomeFeedInjectionFrequencies] = useState<{
    recommendation: number;
    discovery: number;
  }>({
    recommendation: DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.recommendation,
    discovery: DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.discovery
  });
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
  const peerPoolRequestedRef = useRef(false);
  const popularPeersRequestedRef = useRef(false);
  const turnIceInitializationRef = useRef<Promise<void> | null>(null);
  const turnIceConfiguredRef = useRef(false);
  const selectedContactIdRef = useRef<string | null>(null);
  const myProfileRef = useRef({ displayName: '', bio: '', feedMix: DEFAULT_FEED_MIX });
  const identityRef = useRef<IdentityRecord | null>(null);
  const objectStoreRef = useRef<ObjectStore | null>(null);
  const outboxServiceRef = useRef<ReturnType<typeof createOutboxService> | null>(null);
  const outboxStoreRef = useRef<IndexedDbOutboxStore | null>(null);
  const localPostMetadataStoreRef = useRef<LocalPostMetadataStore | null>(null);
  const recommendationSequenceStoreRef = useRef<IndexedDbRecommendationSequenceStore | null>(null);
  const recommendationIndexRef = useRef(new RecommendationIndex());
  const objectTransportRef = useRef<PeerConnectionObjectTransport | null>(null);
  const feedBatchSubscribersRef = useRef(new Set<ProcessedFeedBatchHandler>());
  const feedBatchProcessingQueuesRef = useRef(new Map<string, Promise<void>>());
  const feedDisconnectSubscribersRef = useRef(new Set<(peerId: string) => void>());
  const feedSyncPeerRef = useRef<((peerId: string) => Promise<void>) | null>(null);
  const profileContactIdRef = useRef<string | null>(null);
  const dmEventsRef = useRef(createDmEvents());
  const inboxServiceRef = useRef<ReturnType<typeof createInboxService> | null>(null);
  const dmServiceRef = useRef<ReturnType<typeof createDmService> | null>(null);
  const [, setDmServiceRevision] = useState(0);
  const dmOutboxIntervalRef = useRef<number | null>(null);
  const findRequestCacheRef = useRef<Map<string, number>>(new Map());
  const findRequestRouteRef = useRef<Map<string, {
    upstreamPeer: string;
    expiresAt: number;
    childPeer?: string;
    failureTimeout?: number;
  }>>(new Map());
  const findAggregationRef = useRef<Map<string, { aggregation: FindAggregation; requestedObjectIds: Set<string>; upstreamPeer: string; origin: string; expiresAt: string }>>(new Map());
  const waitingPeerIntervalsRef = useRef<Map<string, number>>(new Map());
  const peerElectionFallbackTimersRef = useRef<Map<string, number>>(new Map());
  const peerAttemptTimeoutsRef = useRef<Map<string, number>>(new Map());
  const peerAttemptObservationIdsRef = useRef(new Map<string, string>());
  const peerPostReceptionTimesRef = useRef<Map<string, number>>(new Map());
  const postParentLookupRef = useRef<Map<string, { attemptedAt: number; promise: Promise<DistributedObject | null> }>>(new Map());
  const suppressPhase6FindResponsesRef = useRef(false);
  const webPushProcessingIdsRef = useRef(new Set<string>());
  const deferredDmNotificationIdsRef = useRef(new Set<string>());
  const processingDeferredDmNotificationIdsRef = useRef(new Set<string>());
  const webPushNotificationPreferencesRef = useRef(webPushNotificationPreferences);
  const requestPushOutboxFlush = useMemo(() => createPushWakeOutboxFlusher(async () => {
    await outboxServiceRef.current?.flush();
  }, Date.now, PUSH_OUTBOX_FLUSH_COOLDOWN_MS), []);

  if (!objectStoreRef.current) {
    objectStoreRef.current = new IndexedDbObjectStore({
      getMaxStorageBytes: () => objectStorageLimitBytesRef.current,
      onStorageUsageChange: setObjectStorageUsedBytes,
      getLocalAuthor: () => identityRef.current?.publicKey,
      getFollowedAuthors: () => new Set(contactsRef.current
        .filter((contact) => contact.followed)
        .flatMap((contact) => [contact.publicKey, contact.fingerprint]))
    });
  }
  if (!outboxStoreRef.current) {
    outboxStoreRef.current = new IndexedDbOutboxStore();
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

  const refreshTurnIceServers = async () => {
    if (import.meta.env.DEV && import.meta.env.VITE_E2E_TEST_API === 'true') {
      configureIceServers([]);
      turnIceConfiguredRef.current = true;
      addLog('Using host-only ICE candidates for local browser integration tests');
      return;
    }
    try {
      const iceServers = await fetchMeteredIceServers();
      configureIceServers(iceServers);
      turnIceConfiguredRef.current = true;
      addLog(`Loaded ${iceServers.length} Metered ICE server entries`);
    } catch (error) {
      if (!turnIceConfiguredRef.current) {
        configureIceServers(FALLBACK_ICE_SERVERS);
      }
      addLog(`Metered TURN credentials unavailable; ${turnIceConfiguredRef.current ? 'retaining last configured servers' : 'using STUN-only fallback'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const ensureTurnIceServers = () => {
    if (!turnIceInitializationRef.current) {
      turnIceInitializationRef.current = refreshTurnIceServers();
    }
    return turnIceInitializationRef.current;
  };

  useEffect(() => {
    const navigation = readAppNavigationState(window.history.state);
    window.history.replaceState(
      withAppNavigationState(window.history.state, navigation),
      '',
      window.location.href
    );

    const handlePopState = (event: PopStateEvent) => {
      const next = readAppNavigationState(event.state);
      setPage(next.page);
      setConversationPostId(next.conversationPostId);
      setConversationFocusPostId(next.focusedReplyId);
      setProfileContactId(next.profileContactId);
      profileContactIdRef.current = next.profileContactId;
      setRelationshipOwnerId(next.relationshipOwnerId);
      setRelationshipTab(next.relationshipTab);
      setChatContactId(next.chatContactId);
      if (next.chatContactId) setSelectedContactId(next.chatContactId);
      conversationReturnScrollTopRef.current = next.conversationReturnScrollTop ?? 0;
      pendingScrollRestoreRef.current = next.scrollTop;
      setNavigationRevision((revision) => revision + 1);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    selectedContactIdRef.current = selectedContactId;
  }, [selectedContactId]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    hiddenPostIdsRef.current = hiddenPostIds;
    hiddenDiscoveryIdsRef.current = hiddenDiscoveryIds;
  }, [hiddenPostIds, hiddenDiscoveryIds]);

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
      const hydratedWithMetadata = hydratedViews.filter((view) => view.notInterested !== undefined || view.hidden !== undefined).length;
      addLog(`Hydrated ${hydratedViews.length} posts from storage (${hydratedWithMetadata} with metadata)`);
      setPostViews((prev) => mergeLocalPostViews(prev, hydratedViews));
    });
    if (isDeletionAwareObjectStore(objectStore)) {
      void objectStore.queryDeletionTombstones().then(setDeletionTombstones).catch((error) => {
        addLog(`Deletion tombstone hydration failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }, []);

  useEffect(() => {
    const store = objectStoreRef.current;
    if (!store) return;
    void store.query({ object_type: 'mycelium.recommendation' }).then((objects) => {
      recommendationIndexRef.current.rebuild(objects);
      setRecommendationRevision((revision) => revision + 1);
    });
  }, []);

  const getRecommendationSummary = (postId: string): RecommendationSummary => {
    const followedAuthors = contactsRef.current.filter((contact) => contact.followed).map((contact) => contact.publicKey);
    return recommendationIndexRef.current.getSummary(postId, followedAuthors, identityRef.current?.publicKey);
  };

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
    if (!identity) {
      feedSyncPeerRef.current = null;
      return;
    }

    const adapter = createFeedRequestAdapter({
      sendPacket: async (peerId, payload) => {
        const manager = peerManagersRef.current[peerId];
        if (!manager?.isDataChannelOpen()) throw new Error('Feed peer is unavailable');
        await manager.sendRequestPosts(null, payload.limit, {
          after: payload.after,
          requestId: payload.requestId
        });
      },
      subscribeBatches: (handler) => {
        feedBatchSubscribersRef.current.add(handler);
        return () => feedBatchSubscribersRef.current.delete(handler);
      },
      subscribeDisconnects: (handler) => {
        feedDisconnectSubscribersRef.current.add(handler);
        return () => feedDisconnectSubscribersRef.current.delete(handler);
      }
    });

    feedSyncPeerRef.current = async (peerId) => {
      const result = await syncFeedFromPeer({
        peerId,
        loadCursor: (requestedPeerId) => loadFeedCursor(identity.publicKey, requestedPeerId),
        saveCursor: (requestedPeerId, cursor) => saveFeedCursor(identity.publicKey, requestedPeerId, cursor),
        requestPage: adapter.requestPage,
        // The matching batch is acknowledged only after the App batch handler has stored and processed it.
        storeObjects: async () => {}
      });
      if (result.error) addLog(`Feed sync failed for ${peerId.slice(0, 12)}`);
    };

    return () => {
      adapter.dispose();
      feedSyncPeerRef.current = null;
    };
  }, [identity]);

  useEffect(() => {
    if (!identity) return;
    const store = objectStoreRef.current;
    const objectTransport = objectTransportRef.current;
    if (!store || !objectTransport) return;

    const signPacket: PacketSigner = (packet) => signString(identity.privateKey, canonicalize(packet));
    const service = createInboxService({
      myPublicKey: identity.publicKey,
      store,
      transport: wrapFindTransport({ objectTransport, signPacket }),
      loadCursor: loadInboxCursor,
      saveCursor: saveInboxCursor,
      loadBackfillState: loadInboxBackfillState,
      saveBackfillState: saveInboxBackfillState,
      events: dmEventsRef.current,
      onValidatedObject: (peerId, object) => observeValidatedObjectSupply(peerId, object, addLog)
    });
    const outboxStore = outboxStoreRef.current;
    if (!outboxStore) return;
    const outboxService = createOutboxService({
      outbox: outboxStore,
      objectStore: store,
      sendDirect: async (peerId, object) => {
        const packet = await buildObjectStorePacket(identity.id, peerId, object, signPacket);
        await objectTransport.send(peerId, packet);
        return true;
      },
      replicate: async (object, alreadyAttemptedTo) => {
        const result = await replicateObject(
          identity.id,
          object,
          objectTransport,
          signPacket,
          alreadyAttemptedTo
        );
        return [...result.attempted];
      },
      resolveRecipientPeerId: (recipientPublicKey) => (
        contactsRef.current.find((contact) => contact.publicKey === recipientPublicKey)?.fingerprint ?? null
      ),
      connectedPeers: () => objectTransport.connectedPeers()
    });
    outboxServiceRef.current = outboxService;
    void store.query({ object_type: DELETE_REQUEST_OBJECT_TYPE }).then(async (requests) => {
      for (const request of requests) await outboxService.enqueue(request);
      await outboxService.flush();
    }).catch((error: unknown) => {
      addLog(`Delete Request outbox recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const dmService = createDmService({
      getIdentity: () => ({
        id: identity.id,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        encryptionPrivateKey: identity.encryptionPrivateKey
      }),
      getContact: (publicKey) => contactsRef.current.find((contact) => contact.publicKey === publicKey) ?? null,
      store,
      outbox: outboxService,
      connectedPeers: () => objectTransport.connectedPeers()
    });
    inboxServiceRef.current = service;
    dmServiceRef.current = dmService;
    setDmServiceRevision((revision) => revision + 1);
    service.start();
    const outboxInterval = window.setInterval(() => {
      void dmService.flushOutbox();
    }, 30_000);
    dmOutboxIntervalRef.current = outboxInterval;

    return () => {
      service.stop();
      if (inboxServiceRef.current === service) inboxServiceRef.current = null;
      if (outboxServiceRef.current === outboxService) outboxServiceRef.current = null;
      window.clearInterval(outboxInterval);
      if (dmOutboxIntervalRef.current === outboxInterval) dmOutboxIntervalRef.current = null;
      if (dmServiceRef.current === dmService) dmServiceRef.current = null;
    };
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

  const addLog = useCallback((entry: string) => {
    const timestampedEntry = `${new Date().toLocaleTimeString()}: ${entry}`;
    setLogs((prev) => appendBoundedLog(prev, { text: timestampedEntry, category: classifyLogEntry(entry) }));
  }, []);

  useEffect(() => {
    const store = objectStoreRef.current;
    if (!(store instanceof IndexedDbObjectStore) || !contactsLoaded) return;
    void store.collectGarbage().then((result) => {
      if (result.triggered) {
        addLog(`Object storage GC removed ${result.removedObjectIds.length} objects and ${result.removedTombstoneIds.length} deletion records`);
        if (!result.targetReached) {
          addLog('Object storage GC could not reach its low-water target; remaining storage is protected or ineligible for eviction');
        }
      }
    }).catch((error: unknown) => {
      addLog(`Object storage GC failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [addLog, contactsLoaded, identity?.publicKey]);

  useEffect(() => {
    if (!identity) {
      homeFeedInjectionSchedulerRef.current = null;
      setHomeFeedInjectionFrequencies({
        recommendation: DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.recommendation,
        discovery: DEFAULT_HOME_FEED_INJECTION_THRESHOLDS.discovery
      });
      return;
    }

    try {
      const storageKey = homeFeedInjectionStorageKey(identity.id);
      const initialState = parseHomeFeedInjectionState(localStorage.getItem(storageKey));
      homeFeedInjectionSchedulerRef.current = new HomeFeedInjectionScheduler(initialState, (state) => {
        try {
          localStorage.setItem(storageKey, JSON.stringify(state));
        } catch (error) {
          addLog(`Home feed injection schedule persistence failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      setHomeFeedInjectionFrequencies({
        recommendation: initialState.recommendationThreshold,
        discovery: initialState.discoveryThreshold
      });
      setHomeFeedInjectionRevision((revision) => revision + 1);
    } catch (error) {
      homeFeedInjectionSchedulerRef.current = null;
      addLog(`Home feed injection schedule could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [identity?.id, addLog]);

  const handleSaveInjectionFrequencies = useCallback((
    recommendationFrequency: number,
    discoveryFrequency: number
  ) => {
    const scheduler = homeFeedInjectionSchedulerRef.current;
    if (!scheduler) {
      addLog('Home feed injection settings are unavailable until the schedule is loaded.');
      return;
    }
    try {
      const changed = scheduler.setThresholds(recommendationFrequency, discoveryFrequency);
      if (!changed) return;
      const next = scheduler.getState();
      setHomeFeedInjectionFrequencies({
        recommendation: next.recommendationThreshold,
        discovery: next.discoveryThreshold
      });
      setHomeFeedInjectionRevision((revision) => revision + 1);
    } catch (error) {
      addLog(`Home feed injection settings could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [addLog]);

  const handleSavePublishToDiscovery = useCallback((enabled: boolean): boolean => {
    try {
      localStorage.setItem(PUBLISH_TO_DISCOVERY_STORAGE_KEY, String(enabled));
    } catch (error) {
      addLog(`Publish to discovery setting could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    setPublishToDiscovery(enabled);
    return true;
  }, [addLog]);

  const handleSaveWebPushNotificationPreference = useCallback((
    category: WebPushNotificationCategory,
    enabled: boolean
  ): boolean => {
    const next = updateWebPushNotificationPreference(webPushNotificationPreferencesRef.current, category, enabled);
    try {
      localStorage.setItem(WEB_PUSH_NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      addLog(`Notification preference could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    webPushNotificationPreferencesRef.current = next;
    setWebPushNotificationPreferences(next);
    return true;
  }, [addLog]);

  const handleSaveObjectStorageLimit = useCallback((limitMb: number): boolean => {
    const limitBytes = limitMb * BYTES_PER_MB;
    if (!Number.isSafeInteger(limitMb) || limitBytes < MIN_OBJECT_STORAGE_BYTES
      || !Number.isSafeInteger(limitBytes)) {
      addLog('Object storage limit must be a whole number of megabytes and at least 100 MB.');
      return false;
    }
    try {
      localStorage.setItem(OBJECT_STORAGE_LIMIT_STORAGE_KEY, String(limitMb));
    } catch (error) {
      addLog(`Object storage limit could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    objectStorageLimitBytesRef.current = limitBytes;
    setObjectStorageLimitMb(limitMb);
    const store = objectStoreRef.current;
    if (store instanceof IndexedDbObjectStore) {
      void store.collectGarbage().then((result) => {
        if (result.triggered) {
          addLog(`Object storage GC removed ${result.removedObjectIds.length} objects and ${result.removedTombstoneIds.length} deletion records`);
          if (!result.targetReached) {
            addLog('Object storage GC could not reach its low-water target; remaining storage is protected or ineligible for eviction');
          }
        }
      }).catch((error: unknown) => {
        addLog(`Object storage GC failed after changing the storage limit: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return true;
  }, [addLog]);

  const handleSaveExternalImageLimit = useCallback((limitMb: number): boolean => {
    if (!Number.isFinite(limitMb) || limitMb < 0 || limitMb > MAX_EXTERNAL_IMAGE_LIMIT_MB) {
      addLog(`External image display limit must be between 0 and ${MAX_EXTERNAL_IMAGE_LIMIT_MB} MB.`);
      return false;
    }
    try {
      localStorage.setItem(EXTERNAL_IMAGE_LIMIT_STORAGE_KEY, String(limitMb));
    } catch (error) {
      addLog(`External image display limit could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    setExternalImageLimitMb(limitMb);
    return true;
  }, [addLog]);

  const recordNewEligibleHomePosts = useCallback((incomingViews: LocalPostView[]) => {
    const scheduler = homeFeedInjectionSchedulerRef.current;
    const localIdentity = identityRef.current;
    if (!scheduler || !localIdentity) return;

    const knownIds = new Set(postViewsRef.current.map((post) => post.object.object_id));
    const followedKeys = new Set([
      ...contactsRef.current
        .filter((contact) => contact.followed)
        .flatMap((contact) => [contact.fingerprint, contact.publicKey]),
      localIdentity.id,
      localIdentity.publicKey
    ]);
    const eligibleIds = new Set(selectFollowedPosts(
      [...postViewsRef.current, ...incomingViews],
      followedKeys
    )
      .filter((post) =>
        !blockedPeersRef.current.has(post.object.author)
        && !blockedPeersRef.current.has(post.authorFingerprint)
        && !hiddenPostIdsRef.current.has(post.object.object_id)
        && !hiddenDiscoveryIdsRef.current.has(post.object.object_id)
        && post.hidden !== true
      )
      .map((post) => post.object.object_id));
    const candidates = {
      recommendations: homeFeedInjectionCandidatesRef.current.recommendations
        .map((post) => post.object.object_id),
      discovery: homeFeedInjectionCandidatesRef.current.discovery
        .map((post) => post.object.object_id)
    };

    let changed = false;
    for (const post of incomingViews) {
      const postId = post.object.object_id;
      if (knownIds.has(postId) || !eligibleIds.has(postId)) continue;
      try {
        changed = scheduler.recordNewEligiblePost(postId, candidates) || changed;
      } catch (error) {
        addLog(`Home feed injection scheduling failed for ${postId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    postViewsRef.current = incomingViews.reduce(upsertLocalPostView, postViewsRef.current);
    if (changed) setHomeFeedInjectionRevision((revision) => revision + 1);
  }, [addLog]);

  const flushPendingHomeFeedInjections = useCallback(() => {
    const scheduler = homeFeedInjectionSchedulerRef.current;
    if (!scheduler) return;
    const candidates = {
      recommendations: homeFeedInjectionCandidatesRef.current.recommendations
        .map((post) => post.object.object_id),
      discovery: homeFeedInjectionCandidatesRef.current.discovery
        .map((post) => post.object.object_id)
    };
    try {
      if (scheduler.flushPendingInjections(candidates)) {
        setHomeFeedInjectionRevision((revision) => revision + 1);
      }
    } catch (error) {
      addLog(`Pending Home feed injection could not be scheduled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [addLog]);

  async function syncFeedPeer(peerId: string): Promise<void> {
    const sync = feedSyncPeerRef.current;
    if (!sync) return;
    try {
      await sync(peerId);
    } catch {
      addLog(`Feed sync failed for ${peerId.slice(0, 12)}`);
    }
  }

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

  const pageContact = profileContactId ? contacts.find((c) => c.fingerprint === profileContactId) : undefined;

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
    const contact = contactsRef.current.find((candidate) => candidate.fingerprint === peerId);
    if (contact) {
      void saveContact({ ...contact, ...updates }).catch((error: unknown) => {
        addLog(`Failed to persist contact state for ${peerId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    setContacts((prev) => prev.map((candidate) => (
      candidate.fingerprint === peerId ? { ...candidate, ...updates } : candidate
    )));
  };

  const resolvePostParentFromPeers: PostParentResolver = async (objectId) => {
    const store = objectStoreRef.current;
    if (!store) throw new Error('Object store is unavailable');
    if (isDeletionAwareObjectStore(store) && await store.getDeletionTombstone(objectId)) return null;
    const cached = await store.get(objectId);
    if (cached && cached.object_type === 'mycelium.post' && await validateObject(cached)) return cached;

    const previousLookup = postParentLookupRef.current.get(objectId);
    if (previousLookup && Date.now() - previousLookup.attemptedAt < 10_000) {
      return previousLookup.promise;
    }
    const transport = objectTransportRef.current;
    const localIdentity = identityRef.current;
    if (!transport || !localIdentity) return null;
    const lookup = (async () => {
      const peers = transport.connectedPeers()
        .filter((peerId) => !blockedPeersRef.current.has(peerId))
        .slice(0, 4);
      let lastError: unknown;
      for (const peerId of peers) {
        try {
          const object = await findObject(
            localIdentity.id,
            peerId,
            objectId,
            transport,
            store,
            2,
            (request) => handleAcceptedDeleteRequest(request, false),
            (supplierPeerId, object) => observeValidatedObjectSupply(supplierPeerId, object, addLog)
          );
          if (object) return object;
        } catch (error) {
          lastError = error;
          addLog(`Ancestor FIND via ${peerId} failed for ${objectId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (lastError) {
        throw new Error(`Ancestor retrieval failed for ${objectId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      }
      return null;
    })();
    postParentLookupRef.current.set(objectId, { attemptedAt: Date.now(), promise: lookup });
    while (postParentLookupRef.current.size > 256) {
      const oldestObjectId = postParentLookupRef.current.keys().next().value;
      if (oldestObjectId === undefined) break;
      postParentLookupRef.current.delete(oldestObjectId);
    }
    return lookup;
  };

  const handleAcceptedDeleteRequest = async (request: DistributedObject, propagateNow = true) => {
    const store = objectStoreRef.current;
    if (!store || !isDeletionAwareObjectStore(store)) {
      throw new Error('Deletion-aware object storage is unavailable');
    }
    const payload = request.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof payload.target_object_id !== 'string') {
      throw new Error('Accepted Delete Request has no target object ID');
    }
    const targetObjectId = payload.target_object_id;
    setDeletionTombstones(await store.queryDeletionTombstones());
    setPostViews((previous) => previous.filter((view) => view.object.object_id !== targetObjectId));
    setDiscoveryPosts((previous) => previous.filter((view) => view.object.object_id !== targetObjectId));
    setDiscoveryReplyPosts((previous) => previous.filter((view) => view.object.object_id !== targetObjectId));
    homeFeedInjectionCandidatesRef.current = {
      recommendations: homeFeedInjectionCandidatesRef.current.recommendations
        .filter((view) => view.object.object_id !== targetObjectId),
      discovery: homeFeedInjectionCandidatesRef.current.discovery
        .filter((view) => view.object.object_id !== targetObjectId)
    };
    await localPostMetadataStoreRef.current?.delete(targetObjectId);
    const outboxService = outboxServiceRef.current;
    if (outboxService) {
      await outboxService.enqueue(request);
      if (propagateNow) await outboxService.flush();
    }
    await refreshObjectStore();
  };

  const notifyNewlyAcceptedObject = async (object: DistributedObject) => {
    const deferDmNotification = () => {
      if (deferredDmNotificationIdsRef.current.has(object.object_id)) return;
      if (deferredDmNotificationIdsRef.current.size >= MAX_DEFERRED_DM_NOTIFICATION_IDS) {
        const oldestId = deferredDmNotificationIdsRef.current.values().next().value;
        if (oldestId) deferredDmNotificationIdsRef.current.delete(oldestId);
      }
      deferredDmNotificationIdsRef.current.add(object.object_id);
    };
    const isDirectMessage = object.object_type === 'mycelium.dm';
    if (isDirectMessage && !webPushNotificationPreferencesRef.current.directMessages) {
      deferredDmNotificationIdsRef.current.delete(object.object_id);
      return;
    }

    const localIdentity = identityRef.current;
    const store = objectStoreRef.current;
    if (!localIdentity || !store) {
      if (isDirectMessage) deferDmNotification();
      return;
    }

    try {
      const authorContact = contactsRef.current.find((contact) =>
        contact.publicKey === object.author || contact.fingerprint === object.author
      );
      const authorFingerprint = authorContact?.fingerprint
        ?? (isValidPeerFingerprint(object.author) ? object.author : await deriveFingerprint(object.author));
      if (blockedPeersRef.current.has(object.author)
        || blockedPeersRef.current.has(authorFingerprint)) return;
      const followedAuthorKeys = new Set(contactsRef.current
        .filter((contact) => contact.followed)
        .flatMap((contact) => [contact.publicKey, contact.fingerprint]));
      const classification = await classifyNewlyAcceptedObjectNotification(object, {
        identity: localIdentity,
        followedAuthorKeys,
        store,
        resolveSenderEncryptionKey: (author) => {
          const contact = contactsRef.current.find((candidate) => candidate.publicKey === author);
          return contact ? getContactEncryptionKey(contact) : null;
        },
        isTombstoned: async (objectId) => (
          isDeletionAwareObjectStore(store) && Boolean(await store.getDeletionTombstone(objectId))
        )
      });
      if (!classification) {
        deferredDmNotificationIdsRef.current.delete(object.object_id);
        return;
      }
      if (!('category' in classification)) {
        deferDmNotification();
        return;
      }
      deferredDmNotificationIdsRef.current.delete(object.object_id);
      if (!webPushNotificationPreferencesRef.current[classification.category]
        || typeof Notification === 'undefined' || Notification.permission !== 'granted'
        || !('serviceWorker' in navigator)) return;

      const registration = await navigator.serviceWorker.ready;
      await showWebPushNotificationOnce(registration, classification.category, classification.dedupeId, localStorage);
    } catch {
      addLog('A verified-object notification could not be displayed');
    }
  };
  const notifyNewlyAcceptedObjectRef = useRef(notifyNewlyAcceptedObject);
  notifyNewlyAcceptedObjectRef.current = notifyNewlyAcceptedObject;

  useEffect(() => {
    const store = objectStoreRef.current;
    if (!identity || !store || deferredDmNotificationIdsRef.current.size === 0) return;
    const retryDeferredNotifications = async () => {
      for (const objectId of [...deferredDmNotificationIdsRef.current]) {
        if (processingDeferredDmNotificationIdsRef.current.has(objectId)) continue;
        processingDeferredDmNotificationIdsRef.current.add(objectId);
        try {
          const object = await store.get(objectId);
          if (!object || object.object_type !== 'mycelium.dm') {
            deferredDmNotificationIdsRef.current.delete(objectId);
          } else {
            await notifyNewlyAcceptedObjectRef.current(object);
          }
        } catch (error) {
          addLog(`Deferred direct-message notification retry failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          processingDeferredDmNotificationIdsRef.current.delete(objectId);
        }
      }
    };
    void retryDeferredNotifications();
  }, [identity, contacts, webPushNotificationPreferences]);

  const setFindRequestRoute = (
    requestId: string,
    upstreamPeer: string,
    expiresAt: number,
    childPeer?: string
  ) => {
    deleteFindRequestRoute(requestId);
    const route: {
      upstreamPeer: string;
      expiresAt: number;
      childPeer?: string;
      failureTimeout?: number;
    } = { upstreamPeer, expiresAt, ...(childPeer ? { childPeer } : {}) };
    findRequestRouteRef.current.set(requestId, route);
    if (childPeer) {
      route.failureTimeout = window.setTimeout(() => {
        if (findRequestRouteRef.current.get(requestId) !== route) return;
        findRequestRouteRef.current.delete(requestId);
        route.failureTimeout = undefined;
        void recordFindForwarding(requestId, upstreamPeer, childPeer, 'failed')
          .catch((error: unknown) => addLog(`Failed to record FIND forwarding timeout: ${error instanceof Error ? error.message : String(error)}`));
      }, Math.max(0, expiresAt - Date.now()));
    }
  };

  const clearFindRequestRouteFailureTimeout = (requestId: string, childPeer: string) => {
    const route = findRequestRouteRef.current.get(requestId);
    if (route?.childPeer !== childPeer || route.failureTimeout === undefined) return;
    window.clearTimeout(route.failureTimeout);
    route.failureTimeout = undefined;
  };

  const deleteFindRequestRoute = (requestId: string) => {
    const route = findRequestRouteRef.current.get(requestId);
    if (route?.failureTimeout !== undefined) window.clearTimeout(route.failureTimeout);
    findRequestRouteRef.current.delete(requestId);
  };

  const handleObjectPacket = async (peerId: string, packet: ObjectPacket) => {
    const store = objectStoreRef.current;
    if (!store) return;
    const now = Date.now();
    for (const [requestId, route] of findRequestRouteRef.current.entries()) {
      if (route.expiresAt <= now) {
        addLog(`PHASE6 ROUTE CLEANUP requestId=${requestId} upstream=${route.upstreamPeer} expiresAt=${route.expiresAt} now=${now}`);
        if (route.childPeer) {
          void recordFindForwarding(requestId, route.upstreamPeer, route.childPeer, 'failed')
            .catch((error: unknown) => addLog(`Failed to record FIND forwarding timeout: ${error instanceof Error ? error.message : String(error)}`));
        }
        deleteFindRequestRoute(requestId);
      }
    }
    for (const [seenRequestId, expiresAt] of findRequestCacheRef.current.entries()) {
      if (expiresAt <= now) {
        addLog(`PHASE6 CACHE CLEANUP requestId=${seenRequestId} expiresAt=${expiresAt} now=${now}`);
        findRequestCacheRef.current.delete(seenRequestId);
      }
    }
    if (packet.type === 'FIND') {
      if (packet.payload.author_connected !== undefined
        && typeof packet.payload.author_connected !== 'boolean') {
        addLog(`Rejected FIND with invalid author connection filter: requestId=${packet.payload.requestId}`);
        return;
      }
      const hasRecipientField = Object.prototype.hasOwnProperty.call(packet.payload, 'recipient');
      if (hasRecipientField && (typeof packet.payload.recipient !== 'string' || packet.payload.recipient.trim().length === 0)) {
        addLog(`Rejected FIND with invalid recipient: requestId=${packet.payload.requestId}`);
        return;
      }
      const parsedQueryFields = getFindQueryCriteria(packet);
      const queryFields = parsedQueryFields ?? {};
      const isPhase7Query = parsedQueryFields !== null;
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
        const localQuery = buildLocalQueryCriteria(queryFields);
        const localPage = !isPhase7Query
          ? { objects: (await Promise.all(requestedObjectIds.map(async (objectId) => {
            const object = await store.get(objectId);
            return object && await validateObject(object) ? object : null;
          }))).filter((object): object is NonNullable<typeof object> => object !== null), hasMore: false }
          : queryFields.author_connected !== undefined && queryFields.object_type === IDENTITY_OBJECT_TYPE
            ? await findLatestIdentityObjectsByConnectionQuery(
              store,
              localQuery,
              getAuthenticatedConnectedPeerIds
            )
            : await findObjectsByFindQueryPage(
              store,
              localQuery,
              queryFields.author_connected === undefined
                ? undefined
                : getAuthenticatedConnectedAuthors()
            );
        const localObjects = localPage.objects;
        const connectedPeers = objectTransportRef.current?.connectedPeers() ?? [];
        const nextPeers = selectFindPeers(connectedPeers, peerId, identityRef.current?.id ?? '', 2);
        const aggregationStartedAt = Date.now();
        addLog(`requested: ${requestedObjectIds.length} objects`);
        addLog(`local results: ${localObjects.length}`);
        addLog(`children selected: ${nextPeers.join(', ') || 'none'}`);
        addLog(`upstream recorded: ${peerId}`);
        const forwardedChildren = new Set<string>();
        let aggregation: FindAggregation;
        aggregation = new FindAggregation(requestedObjectIds, expiresAtMs, async (objects, reason, aggregatedHasMore) => {
          try {
            for (const childPeerId of forwardedChildren) {
              void recordFindForwarding(requestId, peerId, childPeerId, 'failed')
                .catch((error: unknown) => addLog(`Failed to record FIND forwarding timeout: ${error instanceof Error ? error.message : String(error)}`));
            }
            const transport = objectTransportRef.current;
            if (!transport || !transport.connectedPeers().includes(peerId)) return;
            const responsePage = await prepareFindQueryPage(objects, queryFields);
            const responseObjects = responsePage.objects;
            const responseHasMore = aggregatedHasMore || responsePage.hasMore;
            const responseComplete = reason === 'all-objects-found' || aggregation.allChildrenResponded();
            addLog('aggregate complete');
            addLog(`reason: ${reason}`);
            addLog(`returning: ${responseObjects.length} objects`);
            addLog(`elapsed: ${Date.now() - aggregationStartedAt}ms`);
            addLog(`PHASE6 AGG COMPLETE callback requestId=${requestId} reason=${reason} objects=${responseObjects.length} upstream=${peerId}`);
            const response = await buildFindResponseObjectsPacket(
              identityRef.current?.id ?? 'unknown',
              peerId,
              requestId,
              responseObjects,
              undefined,
              typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
              expiresAt,
              responseComplete,
              queryFields.order === 'created_at_desc' && queryFields.limit !== undefined
                ? aggregation.allChildrenSupportPagination()
                : undefined,
              responseHasMore
            );
            if (!await sendFindPacketToConnectedPeer(transport, peerId, response)) return;
            addLog(`aggregate sent upstream to ${peerId}`);
          } finally {
            addLog(`PHASE6 AGG CLEANUP BEFORE DELETE requestId=${requestId} aggregationPresent=${findAggregationRef.current.has(requestId)} routePresent=${findRequestRouteRef.current.has(requestId)} cachePresent=${findRequestCacheRef.current.has(requestId)}`);
            if (findAggregationRef.current.get(requestId)?.aggregation === aggregation) {
              findAggregationRef.current.delete(requestId);
            }
            deleteFindRequestRoute(requestId);
            findRequestCacheRef.current.delete(requestId);
            addLog(`PHASE6 AGG CLEANUP AFTER DELETE requestId=${requestId} aggregationPresent=${findAggregationRef.current.has(requestId)} routePresent=${findRequestRouteRef.current.has(requestId)} cachePresent=${findRequestCacheRef.current.has(requestId)}`);
          }
        }, undefined, isPhase7Query, queryFields.order === 'created_at_desc' && queryFields.limit !== undefined);
        findAggregationRef.current.set(requestId, {
          aggregation,
          requestedObjectIds: new Set(requestedObjectIds),
          upstreamPeer: peerId,
          origin: typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
          expiresAt
        });
        setFindRequestRoute(requestId, peerId, expiresAtMs);
        addLog(`PHASE 6 aggregation state created: requestId=${requestId} upstream=${peerId} requested=${requestedObjectIds.length}`);
        addLog(`PHASE6 AGG CREATED local=${identityRef.current?.id ?? 'unknown'} requestId=${requestId} upstream=${peerId} children=${nextPeers.join(',') || 'none'} requested=${requestedObjectIds.length} localHits=${localObjects.length}`);
        addLog(`PHASE6 AGG STORED requestId=${requestId} aggregationPresent=${findAggregationRef.current.has(requestId)} routePresent=${findRequestRouteRef.current.has(requestId)} cachePresent=${findRequestCacheRef.current.has(requestId)}`);
        for (const nextPeer of nextPeers) aggregation.addChild(nextPeer);
        aggregation.addLocal(localObjects, localPage.hasMore);
        if (!aggregation.isComplete() && (isPhase7Query || requestedObjectIds.some((objectId) => !localObjects.some((object) => object.object_id === objectId))) && packet.payload.ttl > 0) {
          for (const nextPeer of nextPeers) {
            const origin = typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender;
            const forwarded = await forwardFindRequestToChild(aggregation, nextPeer, async () => {
              const forwardedPacket = isPhase7Query
                ? await buildForwardedFindPacket(
                  queryFields,
                  requestId,
                  identityRef.current?.id ?? 'unknown',
                  nextPeer,
                  requestedObjectIds,
                  packet.payload.ttl - 1,
                  origin,
                  expiresAt
                )
                : await buildFindPacket(
                  identityRef.current?.id ?? 'unknown',
                  nextPeer,
                  requestedObjectIds,
                  undefined,
                  requestId,
                  packet.payload.ttl - 1,
                  origin,
                  expiresAt
                );
              const transport = objectTransportRef.current;
              if (!transport || !transport.connectedPeers().includes(nextPeer)) {
                throw new Error('FIND child is unavailable');
              }
              await transport.send(nextPeer, forwardedPacket);
            });
            if (forwarded) forwardedChildren.add(nextPeer);
            void recordFindForwarding(requestId, peerId, nextPeer, forwarded ? 'pending' : 'failed')
              .catch((error: unknown) => addLog(`Failed to record FIND forwarding observation: ${error instanceof Error ? error.message : String(error)}`));
            if (forwarded) {
              addLog(`forwarded request to child ${nextPeer}: requestId=${requestId} ttl=${packet.payload.ttl - 1}`);
            } else {
              addLog(`child ${nextPeer} failed before response`);
            }
          }
        } else {
          for (const nextPeer of nextPeers) await aggregation.failChild(nextPeer);
        }
        return;
      }
      if (typeof packet.payload?.requestId === 'string' && typeof packet.payload?.expiresAt === 'string') {
        const expiresAtMs = Date.parse(packet.payload.expiresAt);
        if (!Number.isNaN(expiresAtMs) && now < expiresAtMs) {
          setFindRequestRoute(packet.payload.requestId, peerId, expiresAtMs);
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
              void recordFindForwarding(response.payload.requestId, route.upstreamPeer, peerId, 'responded')
                .catch((error: unknown) => addLog(`Failed to record FIND forwarding response: ${error instanceof Error ? error.message : String(error)}`));
              const relayed = await buildFindResponsePacket(
              identityRef.current?.id ?? 'unknown',
              route.upstreamPeer,
              response.payload.object_id,
              response.payload.requestId,
              response.payload.object,
              undefined,
              response.payload.origin,
              response.payload.expiresAt,
              response.payload.complete === true,
              response.payload.pagination_supported === true,
              response.payload.has_more
            );
            if (!shouldRetainFindRequestRoute(peerId, route, aggregationState)) {
              clearFindRequestRouteFailureTimeout(response.payload.requestId, peerId);
              deleteFindRequestRoute(response.payload.requestId);
            } else {
              addLog(`OBJECT FIND_RESPONSE route retained: requestId=${response.payload.requestId} sender=${peerId} remainingChildren=${aggregationState?.aggregation.pendingChildren().join(', ') || 'none'}`);
            }
            addLog(`OBJECT FIND_RESPONSE relayed: requestId=${response.payload.requestId} ${peerId} -> ${route.upstreamPeer}`);
            await objectTransportRef.current?.send(route.upstreamPeer, relayed);
            return;
          }
          const transport = objectTransportRef.current;
          if (!transport) throw new Error('Object transport is unavailable');
          await transport.send(peerId, response);
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
              expiresAt,
              true,
              query?.order === 'created_at_desc' && query.limit !== undefined ? true : undefined,
              query?.order === 'created_at_desc' && query.limit !== undefined ? false : undefined
            );
            deleteFindRequestRoute(requestId);
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
          setFindRequestRoute(requestId, fromPeer, Date.parse(expiresAt), nextPeer);
          addLog(`OBJECT FIND forwarded: requestId=${requestId} ${fromPeer} -> ${nextPeer} ttl=${ttl} expiresAt=${expiresAt}`);
          try {
            await objectTransportRef.current?.send(nextPeer, forwardedPacket);
            void recordFindForwarding(requestId, fromPeer, nextPeer, 'pending')
              .catch((error: unknown) => addLog(`Failed to record FIND forwarding observation: ${error instanceof Error ? error.message : String(error)}`));
          } catch (error) {
            void recordFindForwarding(requestId, fromPeer, nextPeer, 'failed')
              .catch((recordError: unknown) => addLog(`Failed to record FIND forwarding failure: ${recordError instanceof Error ? recordError.message : String(recordError)}`));
            deleteFindRequestRoute(requestId);
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
          const validatedObjects = await validateFindResponseObjects(packet, requestId!, aggregationState.requestedObjectIds);
          for (const object of validatedObjects) {
            observeValidatedObjectSupply(peerId, object, addLog);
          }
          const objects = await filterTombstonedObjects(validatedObjects, store);
          void recordFindForwarding(requestId!, aggregationState.upstreamPeer, peerId, 'responded')
            .catch((error: unknown) => addLog(`Failed to record FIND forwarding response: ${error instanceof Error ? error.message : String(error)}`));
          const queryFields = packet.payload as { object_type?: string; author?: string; created_after?: string; created_before?: string; page_before?: { created_at: string; object_id: string }; since?: string; limit?: number; order?: 'created_at_desc' };
          const isPhase7Query = Boolean(queryFields.object_type || queryFields.author || queryFields.created_after || queryFields.created_before || queryFields.page_before || queryFields.since || queryFields.limit !== undefined || queryFields.order);
          if (isPhase7Query) {
            addLog(`PHASE7 CHILD RESPONSE requestId=${requestId} from=${peerId} objects=${objects.map((object) => object.object_id).join(', ') || 'none'} aggregate=${aggregationState.aggregation.aggregateSize() + objects.length}`);
          }
          addLog(`child ${peerId} response received`);
          addLog(`objects: ${objects.length}`);
          addLog(`PHASE6 CHILD RESPONSE local=${identityRef.current?.id ?? 'unknown'} from=${peerId} requestId=${requestId} objects=${objects.length} pendingBefore=${aggregationState.aggregation.pendingChildren().join(', ') || 'none'}`);
          await aggregationState.aggregation.addChildObjects(
            peerId,
            objects,
            packet.payload.complete === true,
            packet.payload.pagination_supported === true && typeof packet.payload.has_more === 'boolean',
            packet.payload.has_more === true
          );
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
        clearFindRequestRouteFailureTimeout(requestId!, peerId);
        void recordFindForwarding(requestId!, route.upstreamPeer, peerId, 'responded')
          .catch((error: unknown) => addLog(`Failed to record FIND forwarding response: ${error instanceof Error ? error.message : String(error)}`));
        const shouldRetainRoute = shouldRetainFindRequestRoute(peerId, route, aggregationState);
        const validatedSuppliedObjects = await validateFindResponseObjects(packet, requestId!, new Set());
        for (const object of validatedSuppliedObjects) {
          observeValidatedObjectSupply(peerId, object, addLog);
        }
        const childObjects = Array.isArray(packet.payload.objects)
          ? packet.payload.objects
          : packet.payload.object ? [packet.payload.object] : [];
        const relayObjects = await filterTombstonedObjects(childObjects, store);
        const relayed = Array.isArray(packet.payload.objects) && !packet.payload.object
          ? await buildFindResponseObjectsPacket(
            identityRef.current?.id ?? 'unknown',
            route.upstreamPeer,
            requestId!,
            relayObjects,
            undefined,
            typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
            typeof packet.payload.expiresAt === 'string' ? packet.payload.expiresAt : undefined,
            packet.payload.complete === true,
            packet.payload.pagination_supported === true,
            packet.payload.has_more
          )
          : await buildFindResponsePacket(
            identityRef.current?.id ?? 'unknown',
            route.upstreamPeer,
            relayObjects[0]?.object_id ?? packet.payload.object_id,
            requestId!,
            relayObjects[0],
            undefined,
            typeof packet.payload.origin === 'string' ? packet.payload.origin : packet.sender,
            typeof packet.payload.expiresAt === 'string' ? packet.payload.expiresAt : undefined,
            packet.payload.complete === true,
            packet.payload.pagination_supported === true,
            packet.payload.has_more
          );
        if (!shouldRetainRoute) {
          deleteFindRequestRoute(requestId!);
        }
        addLog(`OBJECT FIND_RESPONSE relayed: requestId=${requestId} ${peerId} -> ${route.upstreamPeer}`);
        await objectTransportRef.current?.send(route.upstreamPeer, relayed);
      } else if (!route) {
        addLog(`OBJECT FIND_RESPONSE ignored: unknown requestId=${requestId ?? 'unknown'}`);
      }
      return;
    }
    const incomingPost = packet.type === 'OBJECT_STORE' && packet.payload.object.object_type === 'mycelium.post'
      ? packet.payload.object
      : null;
    const validIncomingPost = incomingPost ? await validateObject(incomingPost) : false;
    const stored = await receiveObjectPacket(packet, store);
    if (packet.type === 'OBJECT_STORE' && packet.payload.object.object_type === IDENTITY_OBJECT_TYPE) {
      await updateContactFromIdentityObject(packet.payload.object as IdentityObject);
    }
    if (stored && packet.type === 'OBJECT_STORE' && isDeleteRequest(packet.payload.object)) {
      await handleAcceptedDeleteRequest(packet.payload.object);
    }
    if (stored && validIncomingPost && incomingPost) {
      const authorFingerprint = await resolvePostAuthorFingerprint(incomingPost.author);
      recordNewEligibleHomePosts([
        createLocalPostView(incomingPost as PostObject, authorFingerprint, { source: 'peer' })
      ]);
    }
    if (validIncomingPost && incomingPost) {
      await cachePostChain(incomingPost);
    }
    addLog(`${stored ? 'Stored' : 'Rejected'} generic object from ${peerId}`);
    if (stored && packet.type === 'OBJECT_STORE') {
      inboxServiceRef.current?.notifyObjectStored(packet.payload.object);
      if (!isDeleteRequest(packet.payload.object)) void notifyNewlyAcceptedObject(packet.payload.object);
      if (packet.payload.object.object_type === 'mycelium.reply' || packet.payload.object.object_type === 'mycelium.post') {
        void replyUnread.discover([packet.payload.object]);
      }
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
      void handleObjectPacket(peerId, packet).catch((error: unknown) => {
        addLog(`Failed to process object packet from ${peerId}: ${error instanceof Error ? error.message : String(error)}`);
      });
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

  const replyUnread = useReplyUnreadController({
    store: objectStoreRef.current,
    identityId: identity?.id ?? null,
    myPublicKey: identity?.publicKey ?? null,
    resolveAuthorFingerprint: resolvePostAuthorFingerprint,
    onError: (error) => addLog(error instanceof Error ? error.message : String(error))
  });

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let disposed = false;

    const acknowledge = (source: MessageEventSource | null, ids: string[]) => {
      if (ids.length === 0) return;
      const message = { type: 'MYCELIUM_PUSH_ACK_V1', ids };
      try {
        if (source && 'postMessage' in source) {
          source.postMessage(message);
        } else {
          navigator.serviceWorker.controller?.postMessage(message);
        }
      } catch {
        return;
      }
    };

    const processItem = async (id: string, value: unknown): Promise<boolean> => {
      const envelope = parseIncomingWebPushEnvelope(value);
      if (!envelope || envelopeObjectId(envelope) !== id) return true;
      const store = objectStoreRef.current;
      const localIdentity = identityRef.current;
      if (!store || !localIdentity) return false;

      if (envelope.type === 'object') {
        if (!(await validateObject(envelope.object))) return false;
        const packet = await buildObjectStorePacket(localIdentity.id, localIdentity.id, envelope.object);
        await handleObjectPacket('web-push', packet);
        const stored = await store.get(id);
        return stored !== null
          || (isDeletionAwareObjectStore(store) && Boolean(await store.getDeletionTombstone(id)));
      }

      const existing = await store.get(id);
      if (existing && await validateObject(existing)) return true;
      if (isDeletionAwareObjectStore(store) && await store.getDeletionTombstone(id)) return true;

      const transport = objectTransportRef.current;
      const peers = transport?.connectedPeers()
        .filter((peerId) => !blockedPeersRef.current.has(peerId))
        .slice(0, 4) ?? [];
      for (const peerId of peers) {
        if (!transport) break;
        try {
          const found = await findObject(
            localIdentity.id,
            peerId,
            id,
            transport,
            store,
            2,
            (request) => handleAcceptedDeleteRequest(request, false),
            (supplierPeerId, object) => observeValidatedObjectSupply(supplierPeerId, object, addLog)
          );
          if (!found) continue;
          if (found.object_type === 'mycelium.post' && await validateObject(found)) {
            const authorFingerprint = await resolvePostAuthorFingerprint(found.author);
            recordNewEligibleHomePosts([
              createLocalPostView(found as PostObject, authorFingerprint, { source: 'peer' })
            ]);
            await cachePostChain(found);
          }
          if (found.object_type === 'mycelium.dm') inboxServiceRef.current?.notifyObjectStored(found);
          if (!isDeleteRequest(found)) void notifyNewlyAcceptedObject(found);
          if (found.object_type === 'mycelium.reply' || found.object_type === 'mycelium.post') {
            void replyUnread.discover([found]);
          }
          await refreshObjectStore();
          return true;
        } catch {
          addLog('Web Push reference retrieval failed; it remains staged for a later attempt');
        }
      }
      return false;
    };

    const handleMessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const messageType = (message as { type?: unknown }).type;
      if (messageType === 'MYCELIUM_PUSH_WAKE_V1') {
        const flush = requestPushOutboxFlush();
        if (flush) void flush.catch(() => addLog('Opportunistic outbox flush after Web Push failed'));
        return;
      }
      if (messageType !== WEB_PUSH_STAGED_MESSAGE_TYPE) return;
      const items = (message as { items?: unknown }).items;
      if (!Array.isArray(items) || items.length > WEB_PUSH_STAGING_MAX_ENTRIES) return;
      const source = event.source;
      void (async () => {
        const acknowledged: string[] = [];
        for (const item of items) {
          if (disposed || !item || typeof item !== 'object' || Array.isArray(item)) continue;
          const candidate = item as { id?: unknown; envelope?: unknown };
          if (typeof candidate.id !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.id)) continue;
          const id = candidate.id;
          if (webPushProcessingIdsRef.current.has(id)) continue;
          webPushProcessingIdsRef.current.add(id);
          try {
            if (await processItem(id, candidate.envelope)) acknowledged.push(id);
          } catch {
            addLog('Web Push staged item processing failed; it remains staged for a later attempt');
          } finally {
            webPushProcessingIdsRef.current.delete(id);
          }
        }
        acknowledge(source, acknowledged);
      })();
    };

    const requestDrain = () => {
      void navigator.serviceWorker.ready.then((registration) => {
        if (!disposed) {
          (navigator.serviceWorker.controller ?? registration.active)?.postMessage({
            type: 'MYCELIUM_PUSH_DRAIN_V1'
          });
        }
      }).catch(() => {
        if (!disposed) addLog('Web Push staging is unavailable in this browser session');
      });
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    window.addEventListener('focus', requestDrain);
    window.addEventListener('online', requestDrain);
    requestDrain();
    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener('message', handleMessage);
      window.removeEventListener('focus', requestDrain);
      window.removeEventListener('online', requestDrain);
    };
  }, [identity?.id, connectedPeerIds.join(','), addLog, requestPushOutboxFlush]);

  const logPostChainResult = (postId: string, result: PostChainResult) => {
    if (result.complete && result.storageFailures.length === 0) {
      addLog(`POST ancestry complete for ${postId}: ${result.objects.length} canonical posts cached`);
      return;
    }
    addLog(`POST ancestry incomplete for ${postId}: reason=${result.stopReason}${result.missingObjectId ? ` missing=${result.missingObjectId}` : ''}${result.error ? ` error=${result.error}` : ''} cached=${result.objects.length} storageFailures=${result.storageFailures.length}`);
  };

  const cachePostChain = async (
    post: DistributedObject,
    source: LocalPostView['source'] = 'peer'
  ): Promise<PostChainResult> => {
    const store = objectStoreRef.current;
    if (!store) throw new Error('Object store is unavailable');
    const result = await ensurePostChainCached(post, store, resolvePostParentFromPeers);
    logPostChainResult(post.object_id, result);
    const metadataStore = localPostMetadataStoreRef.current;
    const views = await Promise.all(result.objects.map(async (object) => {
      const metadata = await metadataStore?.get(object.object_id);
      const fingerprint = metadata?.authorFingerprint ?? await resolvePostAuthorFingerprint(object.author);
      const view = createLocalPostView(object as PostObject, fingerprint, {
        source: metadata?.source ?? source,
        ...(metadata?.notInterested === undefined ? {} : { notInterested: metadata.notInterested }),
        ...(metadata?.hidden === undefined ? {} : { hidden: metadata.hidden })
      });
      if (metadataStore && !metadata) await metadataStore.put(localPostMetadata(view));
      return view;
    }));
    setPostViews((previous) => views.reduce(upsertLocalPostView, previous));
    return result;
  };

  const generatedDisplayName = useMemo(() => identity ? fingerprintToHumanName(identity.id) : 'Me', [identity]);

  const getLocalDisplayName = () => myProfile.displayName.trim() || generatedDisplayName || 'Me';

  const buildPeerMetadata = async (peerId: string, followingOverride?: boolean) => {
    const p = myProfileRef.current;
    const id = identityRef.current;
    const fallbackName = id ? fingerprintToHumanName(id.id) : 'Me';
    const webPush = await webPushManager.getPublishedCapability();
    const metadata = {
      author: id?.id ?? '',
      publicKey: id?.publicKey,
      displayName: p.displayName.trim() || fallbackName || 'Me',
      following: followingOverride ?? contactsRef.current.find((c) => c.fingerprint === peerId)?.followed ?? false,
      timestamp: new Date().toISOString(),
      bio: p.bio.trim() || `Peer id: ${id?.id ?? 'unknown'}`,
      tags: [],
      ...(webPush ? { webPush } : {})
    };
    return id?.encryptionPublicKey ? addEncryptionKeyBinding(metadata, id) : metadata;
  };

  const sendPeerMetadata = async (manager: PeerConnectionManager, peerId: string, followingOverride?: boolean) => {
    manager.sendMetadata(await buildPeerMetadata(peerId, followingOverride));
  };

  const publishLocalIdentityProfile = async (
    localIdentity: IdentityRecord,
    profile: Pick<typeof myProfile, 'displayName' | 'bio'>,
    replicate = true
  ): Promise<IdentityObject> => {
    const store = objectStoreRef.current;
    if (!store) throw new Error('Profile object storage is unavailable');
    const displayName = profile.displayName.trim() || fingerprintToHumanName(localIdentity.id);
    const bio = profile.bio.trim() || `Peer id: ${localIdentity.id}`;
    const existing = await getLatestIdentityObject(store, localIdentity.publicKey);
    if (existing
      && existing.payload.display_name === displayName
      && existing.payload.bio === bio
      && existing.payload.encryption_public_key === localIdentity.encryptionPublicKey) {
      return existing;
    }

    const encryptionKeyBinding = await createEncryptionKeyBinding({
      publicKey: localIdentity.publicKey,
      privateKey: localIdentity.privateKey,
      encryptionPublicKey: localIdentity.encryptionPublicKey
    });
    const object = await createSignedIdentityObject({
      display_name: displayName,
      bio,
      encryption_public_key: localIdentity.encryptionPublicKey,
      encryption_key_binding: encryptionKeyBinding
    }, createObjectIdentity({
      id: localIdentity.id,
      publicKey: localIdentity.publicKey,
      privateKey: localIdentity.privateKey
    }));
    await store.put(object);
    await publishIdentityProfileToDiscovery(object);

    if (replicate) {
      const transport = objectTransportRef.current;
      if (transport) {
        const signer: PacketSigner = (packet) => signString(localIdentity.privateKey, canonicalize(packet));
        await replicateObject(localIdentity.id, object, transport, signer, new Set(), addLog);
      }
    }
    addLog(`Stored signed profile object ${object.object_id} for ${localIdentity.id}`);
    return object;
  };

  const publishIdentityProfileToDiscovery = async (profile: IdentityObject) => {
    const socket = signallingSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      await publishObject(profile, socket);
      addLog(`Published signed identity profile ${profile.object_id} to discovery`);
    } catch (error) {
      addLog(`Failed to publish signed identity profile: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const validatePopularPeerProfiles = async (
    peers: PopularPeer[]
  ): Promise<PopularPeerWithIdentityProfile[]> => {
    const store = objectStoreRef.current;
    return Promise.all(peers.map(async (peer) => {
      if (!peer.identity_profile) {
        return { peer_id: peer.peer_id, activity_score: peer.activity_score };
      }
      if (!store) {
        addLog(`Could not validate popular peer profile for ${peer.peer_id}: object storage is unavailable`);
        return { peer_id: peer.peer_id, activity_score: peer.activity_score };
      }
      try {
        const profile = await storeRequestedIdentityProfile(store, peer.identity_profile, peer.peer_id);
        if (!profile) {
          addLog(`Rejected discovery profile for popular peer ${peer.peer_id}`);
          return { peer_id: peer.peer_id, activity_score: peer.activity_score };
        }
        return {
          peer_id: peer.peer_id,
          activity_score: peer.activity_score,
          identity_profile: profile
        };
      } catch (error) {
        addLog(`Failed to validate discovery profile for ${peer.peer_id}: ${error instanceof Error ? error.message : String(error)}`);
        return { peer_id: peer.peer_id, activity_score: peer.activity_score };
      }
    }));
  };

  const sendCachedIdentityProfiles = async (peerId: string) => {
    const store = objectStoreRef.current;
    const transport = objectTransportRef.current;
    const localIdentity = identityRef.current;
    if (!store || !transport || !localIdentity || !transport.connectedPeers().includes(peerId)) return;
    const profiles = await getLatestIdentityObjects(store);
    if (profiles.length === 0) return;
    const signer: PacketSigner = (packet) => signString(localIdentity.privateKey, canonicalize(packet));
    const sentCount = await sendObjectBatches(
      localIdentity.id,
      peerId,
      profiles,
      transport,
      signer
    );
    addLog(`Exchanged ${sentCount} cached signed profile objects with ${peerId}`);
  };

  const updateContactFromIdentityObject = async (object: IdentityObject) => {
    if (!(await validateIdentityObject(object))) return;
    const store = objectStoreRef.current;
    const latest = store
      ? await getLatestIdentityObject(store, object.author)
      : object;
    if (!latest) return;

    const fingerprint = await deriveFingerprint(latest.author);
    const previous = contactsRef.current.find((contact) =>
      contact.fingerprint === fingerprint || contact.publicKey === latest.author
    );
    const updated = contactWithIdentityProfile(previous, latest, fingerprint);
    const next = previous
      ? contactsRef.current.map((contact) => contact === previous ? updated : contact)
      : [...contactsRef.current, updated];
    contactsRef.current = next;
    setContacts(next);
    try {
      await saveContact(updated);
    } catch (error) {
      addLog(`Failed to persist signed profile for ${fingerprint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const requestIdentityProfileIfMissing = async (
    peerId: string,
    manager: PeerConnectionManager,
    publicKey: string
  ) => {
    if (!manager.isDataChannelOpen() || peerManagersRef.current[peerId] !== manager) return;
    const cachedContactProfile = contactsRef.current.find((contact) => contact.fingerprint === peerId)?.identityObject;
    if (cachedContactProfile
      && !isObjectExpired(cachedContactProfile)
      && await validateIdentityObject(cachedContactProfile)
      && cachedContactProfile.author === publicKey
      && await deriveFingerprint(cachedContactProfile.author) === peerId) {
      return;
    }
    const store = objectStoreRef.current;
    if (!store) return;
    const profile = await getLatestIdentityObject(store, publicKey);
    if (profile && await deriveFingerprint(profile.author) === peerId) {
      await updateContactFromIdentityObject(profile);
      return;
    }

    if (!manager.isDataChannelOpen() || peerManagersRef.current[peerId] !== manager) return;
    try {
      if (await manager.requestIdentityProfile(createPacketId())) {
        addLog(`Requested signed identity profile from ${peerId}`);
      }
    } catch (error) {
      addLog(`Failed to request signed identity profile from ${peerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleIdentityProfileResponse = async (
    peerId: string,
    manager: PeerConnectionManager,
    candidate: unknown
  ) => {
    if (peerManagersRef.current[peerId] !== manager || !manager.isDataChannelOpen()) return;
    if (candidate === null) {
      addLog(`Peer ${peerId} has no signed identity profile to share`);
      return;
    }
    const store = objectStoreRef.current;
    if (!store) {
      manager.allowIdentityProfileRequestRetry();
      addLog(`Cannot store signed identity profile from ${peerId}: object storage is unavailable`);
      return;
    }
    let profile: IdentityObject | null;
    try {
      profile = await storeRequestedIdentityProfile(store, candidate, peerId);
    } catch (error) {
      manager.allowIdentityProfileRequestRetry();
      throw error;
    }
    if (!profile) {
      manager.allowIdentityProfileRequestRetry();
      addLog(`Rejected signed identity profile from ${peerId}: invalid profile or signing author mismatch`);
      return;
    }
    await updateContactFromIdentityObject(profile);
    addLog(`Stored signed identity profile from ${peerId}`);
  };

  const getAuthenticatedConnectedPeerIds = () => {
    const transport = objectTransportRef.current;
    return (transport?.connectedPeers() ?? []).filter((peerId) => {
      const manager = peerManagersRef.current[peerId];
      return manager !== undefined
        && manager.isDataChannelOpen()
        && authenticatedPeerManagersRef.current.has(manager);
    });
  };

  const getAuthenticatedConnectedAuthors = () => collectAuthenticatedConnectedAuthors(
    authenticatedPeerAuthorsRef.current,
    peerManagersRef.current,
    authenticatedPeerManagersRef.current
  );

  const closeAndRemoveAuthenticatedPeerManager = (peerId: string, expected?: PeerConnectionManager) => {
    const manager = expected ?? peerManagersRef.current[peerId];
    if (manager) {
      removeAuthenticatedPeerAuthor(authenticatedPeerAuthorsRef.current, peerId, manager);
      authenticatedPeerManagersRef.current.delete(manager);
    }
    return closeAndRemovePeerManager(peerManagersRef.current, peerId, expected);
  };

  const refreshConnectedPeerProfiles = async () => {
    const connectedPeers = objectTransportRef.current?.connectedPeers() ?? [];
    await Promise.all(connectedPeers.map(async (peerId) => {
      const manager = peerManagersRef.current[peerId];
      if (!manager) return;
      try {
        await sendPeerMetadata(manager, peerId);
      } catch (error) {
        addLog(`Failed to refresh profile for ${peerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  };

  const handlePeerMetadata = async (
    peerId: string,
    metadata: PeerMetadata,
    manager: PeerConnectionManager
  ) => {
    if (peerManagersRef.current[peerId] !== manager || !manager.isDataChannelOpen()) return;
    const metadataPublicKey = typeof metadata?.publicKey === 'string' && metadata.publicKey.trim()
      ? metadata.publicKey.trim()
      : undefined;
    if (!metadataPublicKey) return;
    authenticatedPeerManagersRef.current.add(manager);
    recordAuthenticatedPeerAuthor(authenticatedPeerAuthorsRef.current, peerId, manager, metadataPublicKey);
    if (!onlinePeerDiscoveryStartedRef.current.has(manager)) {
      onlinePeerDiscoveryStartedRef.current.add(manager);
      void onlinePeerDiscoveryRef.current?.().catch((error: unknown) => {
        addLog(`Connected-peer FIND discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const existingContact = contactsRef.current.find((contact) => contact.fingerprint === peerId);
    const bindingUpdate = await applyEncryptionKeyBinding(
      metadata.encryptionKeyBinding,
      metadataPublicKey,
      existingContact ? {
        encryptionPublicKey: existingContact.encryptionPublicKey,
        encryptionKeyChanged: existingContact.encryptionKeyChanged
      } : {}
    );
    if (bindingUpdate.keyChanged) {
      console.warn(`Peer encryption key changed for ${peerId}; keeping previously trusted key`);
    }
    setContacts((prev) => {
      const existing = prev.find((contact) => contact.fingerprint === peerId);
      const updatedContact: Contact = existing
        ? {
            ...existing,
            ...bindingUpdate.contactFields,
            publicKey: metadataPublicKey ?? existing.publicKey,
            authenticatedDisplayName: typeof metadata.displayName === 'string'
              ? metadata.displayName
              : existing.authenticatedDisplayName,
            webPush: metadata.webPush,
            follower: metadata.following,
            online: true,
            connected: true
          }
        : {
          publicKey: metadataPublicKey ?? peerId,
            fingerprint: peerId,
          authenticatedDisplayName: typeof metadata.displayName === 'string' ? metadata.displayName : undefined,
          ...bindingUpdate.contactFields,
            webPush: metadata.webPush,
            addedAt: new Date().toISOString(),
            followed: false,
            follower: metadata.following,
            online: true,
            connected: true,
          };

      void saveContact(updatedContact)
        .then(() => {
          if (existing && existing.publicKey !== updatedContact.publicKey) {
            return deleteContact(existing.publicKey);
          }
        })
        .catch((error: unknown) => {
          addLog(`Failed to persist contact profile for ${peerId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      return existing ? prev.map((contact) => (contact.fingerprint === peerId ? updatedContact : contact)) : [...prev, updatedContact];
    });
    if (metadataPublicKey) {
      void requestIdentityProfileIfMissing(peerId, manager, metadataPublicKey)
        .catch((error: unknown) => addLog(`Failed to check signed identity profile for ${peerId}: ${error instanceof Error ? error.message : String(error)}`));
    }
    addLog(`Received authenticated connection metadata from ${peerId} following=${metadata.following}`);
  };

  const peerObservationIdentity = async (peerId: string): Promise<PeerIdentityEvidence> => {
    const contact = contactsRef.current.find((candidate) => candidate.fingerprint === peerId);
    const identityObject = contact?.identityObject;
    if (contact
      && identityObject
      && identityObject.author === contact.publicKey
      && await validateIdentityObject(identityObject)
      && await deriveFingerprint(identityObject.author) === peerId) {
      return { kind: 'verified', peerId, publicKey: identityObject.author };
    }
    return { kind: 'session', peerId };
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
    };
    await saveContact(contact);
    const nextContacts = dedupeContactsByFingerprint([...contactsRef.current, contact]);
    contactsRef.current = nextContacts;
    setContacts(nextContacts);
  };

  const clearPeerWaitingInterval = (peerId: string) => {
    const interval = waitingPeerIntervalsRef.current.get(peerId);
    if (interval !== undefined) {
      window.clearInterval(interval);
      waitingPeerIntervalsRef.current.delete(peerId);
    }
  };

  const clearPeerAttemptTimeout = (peerId: string) => {
    const timeout = peerAttemptTimeoutsRef.current.get(peerId);
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      peerAttemptTimeoutsRef.current.delete(peerId);
    }
    activePeerAttemptsRef.current.delete(peerId);
    peerAttemptObservationIdsRef.current.delete(peerId);
    peerCapacityRef.current?.release(peerId);
  };

  const recordPeerAttemptFailure = (peerId: string) => {
    const failureId = peerAttemptObservationIdsRef.current.get(peerId);
    if (!failureId) return;
    void recordConnectionFailure(peerId, failureId)
      .catch((error: unknown) => addLog(`Failed to record connection attempt failure for ${peerId}: ${error instanceof Error ? error.message : String(error)}`));
  };

  const settlePeerRecoveryAttempt = (peerId: string, connected: boolean) => {
    const resolve = peerRecoveryAttemptResolversRef.current.get(peerId);
    peerRecoveryAttemptResolversRef.current.delete(peerId);
    clearPeerAttemptTimeout(peerId);
    resolve?.(connected);
  };

  const clearPeerDisconnectedTimeout = (peerId: string) => {
    const timeout = peerDisconnectedTimeoutsRef.current.get(peerId);
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      peerDisconnectedTimeoutsRef.current.delete(peerId);
    }
  };

  const clearPeerElectionFallback = (peerId: string) => {
    const timeout = peerElectionFallbackTimersRef.current.get(peerId);
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      peerElectionFallbackTimersRef.current.delete(peerId);
    }
  };

  const startPeerElectionFallback = (peerId: string) => {
    if (peerElectionFallbackTimersRef.current.has(peerId)) return;
    peerElectionFallbackTimersRef.current.set(peerId, window.setTimeout(() => {
      peerElectionFallbackTimersRef.current.delete(peerId);
      const manager = peerManagersRef.current[peerId];
      const socket = signallingSocketRef.current;
      const localPeerId = identityRef.current?.id;
      if (!manager || !localPeerId || socket?.readyState !== WebSocket.OPEN || manager.isDataChannelOpen()) return;
      clearPeerWaitingInterval(peerId);
      addLog(`Peer ${peerId} election wait timed out after 15 seconds; initiating fallback connection`);
      requestPeerOffer(peerId, manager, socket, true);
    }, 15_000));
  };

  const startPeerAttemptTimeout = (
    peerId: string,
    timeoutMs = 30_000,
    direction: 'inbound' | 'outbound' = 'outbound'
  ) => {
    if (peerAttemptTimeoutsRef.current.has(peerId)) return true;
    if (!peerCapacityRef.current?.reserve(peerId, direction)) return false;
    if (objectTransportRef.current?.connectedPeers().includes(peerId)) return true;
    activePeerAttemptsRef.current.add(peerId);
    peerAttemptObservationIdsRef.current.set(peerId, newConnectionAttemptObservationId());
    peerAttemptTimeoutsRef.current.set(peerId, window.setTimeout(() => {
      peerAttemptTimeoutsRef.current.delete(peerId);
      activePeerAttemptsRef.current.delete(peerId);
      peerCapacityRef.current?.release(peerId);
      addLog(`Peer ${peerId} connection attempt timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      recordPeerAttemptFailure(peerId);
      settlePeerRecoveryAttempt(peerId, false);
      const manager = peerManagersRef.current[peerId];
      if (manager && !manager.isDataChannelOpen()) {
        closeAndRemoveAuthenticatedPeerManager(peerId, manager);
      }
      peerRecoveryRef.current?.notifyConnectivityChanged();
    }, timeoutMs));
    return true;
  };

  const startPeerWaitingInterval = (peerId: string) => {
    if (waitingPeerIntervalsRef.current.has(peerId)) return;
    waitingPeerIntervalsRef.current.set(peerId, window.setInterval(() => {
      const manager = peerManagersRef.current[peerId];
      if (manager?.isDataChannelOpen()) {
        clearPeerWaitingInterval(peerId);
        clearPeerElectionFallback(peerId);
        return;
      }
      addLog(`Still waiting for peer ${peerId} to initiate`);
    }, 10_000));
  };

  const recordPeerPostReception = (peerId: string, count: number) => {
    if (count <= 0) return;
    const now = Date.now();
    const previous = peerPostReceptionTimesRef.current.get(peerId);
    const elapsed = previous === undefined ? 'first reception' : `${now - previous}ms since previous reception`;
    peerPostReceptionTimesRef.current.set(peerId, now);
    addLog(`Received ${count} posts from peer ${peerId} at ${new Date(now).toISOString()} (${elapsed})`);
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
      closeAndRemoveAuthenticatedPeerManager(peerId, existing);
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
    let connectionObservationSessionId = '';
    let connectionObservationPromise: Promise<void> = Promise.resolve();
    const isCurrentManager = (peer: string) => peerManagersRef.current[peer] === manager;
    manager = new PeerConnectionManager(
      identity.id,
      (peer, state) => {
        if (!isCurrentManager(peer)) return;
        if (state === 'connected') {
          clearPeerDisconnectedTimeout(peer);
        } else if (state === 'disconnected' && !peerDisconnectedTimeoutsRef.current.has(peer)) {
          peerDisconnectedTimeoutsRef.current.set(peer, window.setTimeout(() => {
            peerDisconnectedTimeoutsRef.current.delete(peer);
            const currentManager = peerManagersRef.current[peer];
            if (currentManager !== manager || currentManager.isDataChannelOpen()) return;
            addLog(`Peer ${peer} remained ICE-disconnected; replacing its connection manager`);
            recordPeerAttemptFailure(peer);
            settlePeerRecoveryAttempt(peer, false);
            closeAndRemoveAuthenticatedPeerManager(peer, currentManager);
            peerRecoveryRef.current?.notifyConnectivityChanged();
          }, 15_000));
        }
        if (state === 'disconnected') {
          feedDisconnectSubscribersRef.current.forEach((subscriber) => subscriber(peer));
        }
        setConnectionStatus(state);
        updateContactState(peer, { connected: state === 'connected', lastConnectionStatus: state });
        if (state !== 'connected') {
          setDataChannelOpen(false);
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
        if (object.object_type === 'mycelium.post') recordPeerPostReception(peer, 1);
        const store = objectStoreRef.current;
        const transport = objectTransportRef.current;
        if (!store || !transport) return;
        const existedBefore = await store.get(object.object_id);
        let stored: boolean;
        try {
          if (!await validateObject(object)) {
            addLog(`Rejected invalid object ${object.object_id} from ${peer}`);
            return;
          }
          stored = await receiveAndReplicate(
            object,
            peer,
            store,
            transport,
            identityRef.current?.id ?? identity.id,
            packetSigner,
            addLog,
            resolvePostParentFromPeers
          );
        } catch (error) {
          if (!existedBefore && await store.get(object.object_id)) {
            inboxServiceRef.current?.notifyObjectStored(object);
            if (!isDeleteRequest(object)) void notifyNewlyAcceptedObject(object);
          }
          throw error;
        }
        if (await validateObject(object)) {
          observeValidatedObjectSupply(peer, object, addLog);
        }
        if (object.object_type === IDENTITY_OBJECT_TYPE) {
          await updateContactFromIdentityObject(object as IdentityObject);
        }
        if (!stored) {
          if (object.object_type === 'mycelium.post' && await validateObject(object)) {
            await cachePostChain(object);
          }
          return;
        }
        inboxServiceRef.current?.notifyObjectStored(object);
        if (!isDeleteRequest(object)) void notifyNewlyAcceptedObject(object);
        if (isDeleteRequest(object)) {
          await handleAcceptedDeleteRequest(object, false);
          addLog(`Received and accepted Delete Request ${object.object_id} from ${peer}`);
          return;
        }
        if (object.object_type === 'mycelium.reply') void replyUnread.discover([object]);
        recommendationIndexRef.current.add(object);
        setRecommendationRevision((revision) => revision + 1);
        const authorFingerprint = await resolvePostAuthorFingerprint(object.author);
        const view = object.object_type === 'mycelium.post'
          ? createLocalPostView(object as PostObject, authorFingerprint, { source: 'peer' })
          : null;
        if (view) {
          recordNewEligibleHomePosts([view]);
          setPostViews((prev) => upsertLocalPostView(prev, view));
          await cachePostChain(object);
          void replyUnread.discover([object]);
        }
        addLog(`Received verified object ${object.object_id} from ${peer}`);
      },
      async (peer: string, _metadata: PeerMetadata, packet?: MyceliumPacket) => {
        if (!isCurrentManager(peer)) return;
        if (!isValidPeerFingerprint(peer)) {
          addLog(`Ignoring profile metadata from invalid peer id: ${peer}`);
          return;
        }
        if (blockedPeersRef.current.has(peer)) {
          addLog(`Blocked peer ${peer} metadata ignored`);
          return;
        }
        const accepted = await dispatchAuthenticatedProfileMetadata(
          peer,
          packet,
          (authenticatedMetadata) => handlePeerMetadata(peer, authenticatedMetadata, manager)
        );
        if (!accepted) {
          addLog(`Rejected unauthenticated profile metadata from ${peer}`);
        }
      },
      async (peer: string, _since: string | null = null, limit = 100, after: FeedCursor | null = null, requestId?: string) => {
        if (!isCurrentManager(peer)) return;
        if (blockedPeersRef.current.has(peer)) {
          addLog(`Blocked peer ${peer} requested feed ignored`);
          return;
        }

        const store = objectStoreRef.current;
        const feedPage = store && identityRef.current
          ? await queryFeedPage(store, identityRef.current.publicKey, { after, limit: Math.max(1, limit) })
          : { objects: [], next_cursor: after, has_more: false };

        const transport = objectTransportRef.current;
        const localIdentity = identityRef.current;
        if (!store || !transport || !localIdentity || !transport.connectedPeers().includes(peer)) return;
        const expandedPage = await expandObjectsWithPostChains(
          feedPage.objects,
          store,
          resolvePostParentFromPeers
        );
        expandedPage.chains.forEach((chain) => {
          if (!chain.complete || chain.storageFailures.length > 0) {
            logPostChainResult(chain.objects[chain.objects.length - 1]?.object_id ?? 'unknown', chain);
          }
        });
        const sentCount = await sendObjectBatches(
          localIdentity.id,
          peer,
          expandedPage.objects,
          transport,
          packetSigner,
          {
            request_id: requestId ?? null,
            next_cursor: feedPage.next_cursor,
            has_more: feedPage.has_more
          }
        );
        addLog(`Sent ${feedPage.objects.length} feed objects and ancestor-expanded ${sentCount} canonical objects to ${peer}`);
      },
      async (peer: string, objects: DistributedObject[], page?: FeedPageMetadata) => {
        const processBatch = async () => {
          let processingError: unknown;
          try {
            if (!isCurrentManager(peer)) throw new Error('Feed batch peer is no longer active');
            if (blockedPeersRef.current.has(peer)) throw new Error('Feed batch peer is blocked');
            recordPeerPostReception(peer, objects.filter((object) => object.object_type === 'mycelium.post').length);

            const store = objectStoreRef.current;
            const transport = objectTransportRef.current;
            if (!store || !transport) throw new Error('Feed batch storage is unavailable');
            const existingObjects = await Promise.all(objects.map((object) => store.get(object.object_id)));
            const existingIds = new Set(objects.filter((_, index) => existingObjects[index]).map((object) => object.object_id));
            let storedFlags: boolean[];
            try {
              storedFlags = await receiveBatchAndReplicate(
                objects,
                peer,
                store,
                transport,
                identityRef.current?.id ?? identity.id,
                packetSigner,
                addLog,
                resolvePostParentFromPeers
              );
            } catch (error) {
              for (const object of objects) {
                if (!existingIds.has(object.object_id) && await store.get(object.object_id)) {
                  inboxServiceRef.current?.notifyObjectStored(object);
                }
              }
              throw error;
            }
            for (const object of objects) {
              if (object && await validateObject(object)) {
                observeValidatedObjectSupply(peer, object, addLog);
              }
            }
            for (const object of objects) {
              if (object.object_type === IDENTITY_OBJECT_TYPE) {
                await updateContactFromIdentityObject(object as IdentityObject);
              }
            }
            const newlyAcceptedDeleteRequests = objects.filter((object, index) => (
              storedFlags[index] && isDeleteRequest(object)
            ));
            for (const request of newlyAcceptedDeleteRequests) {
              await handleAcceptedDeleteRequest(request, false);
            }
            const newlyStoredObjects: DistributedObject[] = [];
            for (let index = 0; index < objects.length; index += 1) {
              const object = objects[index];
              if (!storedFlags[index] || !object || isDeleteRequest(object)) continue;
              if (isDeletionAwareObjectStore(store)
                && await store.getDeletionTombstone(object.object_id)) continue;
              newlyStoredObjects.push(object);
            }
            const newlyDiscoveredReplies = newlyStoredObjects.filter((object) => (
              object.object_type === 'mycelium.reply' || object.object_type === 'mycelium.post'
            ));
            if (newlyDiscoveredReplies.length > 0) void replyUnread.discover(newlyDiscoveredReplies);
            for (let index = 0; index < objects.length; index += 1) {
              const object = objects[index];
              if (!storedFlags[index] && object?.object_type === 'mycelium.post' && await validateObject(object)) {
                await cachePostChain(object);
              }
            }
            newlyStoredObjects.forEach((object) => inboxServiceRef.current?.notifyObjectStored(object));
            newlyStoredObjects.forEach((object) => void notifyNewlyAcceptedObject(object));
            const receivedViews: LocalPostView[] = [];
            for (const object of newlyStoredObjects) {
              recommendationIndexRef.current.add(object);
              setRecommendationRevision((revision) => revision + 1);
              const authorFingerprint = await resolvePostAuthorFingerprint(object.author);
              if (object.object_type === 'mycelium.post') receivedViews.push(createLocalPostView(object as PostObject, authorFingerprint, { source: 'peer' }));
            }

            recordNewEligibleHomePosts(receivedViews);
            setPostViews((prev) => receivedViews.reduce(upsertLocalPostView, prev));
            addLog(`Received ${newlyStoredObjects.length} canonical objects from ${peer}`);
          } catch (error) {
            processingError = error instanceof Error ? error : new Error('Feed batch processing failed');
            if (page) addLog(`Feed batch processing failed for ${peer.slice(0, 12)}`);
            else throw error;
          } finally {
            if (page?.request_id) {
              feedBatchSubscribersRef.current.forEach((subscriber) => {
                subscriber(peer, page, objects, processingError);
              });
            }
          }
        };
        const previousBatch = feedBatchProcessingQueuesRef.current.get(peer) ?? Promise.resolve();
        const queuedBatch = previousBatch.catch(() => undefined).then(processBatch);
        feedBatchProcessingQueuesRef.current.set(peer, queuedBatch);
        try {
          await queuedBatch;
        } finally {
          if (feedBatchProcessingQueuesRef.current.get(peer) === queuedBatch) {
            feedBatchProcessingQueuesRef.current.delete(peer);
          }
        }
      },
      async (peer: string) => {
        if (!isCurrentManager(peer)) return;
        const openedAt = Date.now();
        if (!connectionObservationSessionId) {
          connectionObservationSessionId = connectionObservationId(manager.getConnectionId());
          connectionObservationPromise = peerObservationIdentity(peer)
            .then((peerIdentity) => recordConnectionOpened(peer, connectionObservationSessionId, peerIdentity, openedAt))
            .catch((error: unknown) => addLog(`Failed to record connection to ${peer}: ${error instanceof Error ? error.message : String(error)}`));
        }
        settlePeerRecoveryAttempt(peer, true);
        await addKnownPeer(peer);
        setDataChannelOpen(true);
        setActivePeerId(peer);
        updateContactStateAndPersist(peer, { connected: true, lastSeen: new Date().toISOString() });
        peerRecoveryRef.current?.notifyConnectivityChanged();
        inboxServiceRef.current?.notifyPeerConnected();
        void dmServiceRef.current?.flushOutbox();
        const connectedManager = peerManagersRef.current[peer];
        addLog(`Peer ${peer} data channel open`);
        addLog(`Peer ${peer} connected (initiated by ${connectedManager?.didInitiateConnection() ? 'us' : 'them'})`);
        clearPeerWaitingInterval(peer);
        clearPeerElectionFallback(peer);
        clearPeerAttemptTimeout(peer);
        if (connectedManager) {
          await sendPeerMetadata(connectedManager, peer);
          try {
            await sendCachedIdentityProfiles(peer);
          } catch (error) {
            addLog(`Cached profile exchange failed for ${peer}: ${error instanceof Error ? error.message : String(error)}`);
          }
          const contact = contactsRef.current.find((candidate) => candidate.fingerprint === peer);
          if (contact?.followed || profileContactIdRef.current === peer) {
            void syncFeedPeer(peer);
          }
        }
      },
      (peer: string) => {
        const closedAt = Date.now();
        removeAuthenticatedPeerAuthor(authenticatedPeerAuthorsRef.current, peer, manager);
        authenticatedPeerManagersRef.current.delete(manager);
        if (connectionObservationSessionId) {
          void connectionObservationPromise
            .then(() => recordConnectionClosed(peer, connectionObservationSessionId, closedAt))
            .catch((error: unknown) => addLog(`Failed to record disconnection from ${peer}: ${error instanceof Error ? error.message : String(error)}`));
        }
        if (!isCurrentManager(peer)) return;
        addLog(`Peer ${peer} disconnected (data channel or peer connection closed)`);
        clearPeerDisconnectedTimeout(peer);
        clearPeerWaitingInterval(peer);
        clearPeerElectionFallback(peer);
        recordPeerAttemptFailure(peer);
        settlePeerRecoveryAttempt(peer, false);
        feedDisconnectSubscribersRef.current.forEach((subscriber) => subscriber(peer));
        for (const [requestId, state] of findAggregationRef.current.entries()) {
          if (state.aggregation.hasChild(peer)) {
            addLog(`child ${peer} disconnected`);
            addLog('marking child failed');
            void recordFindForwarding(requestId, state.upstreamPeer, peer, 'failed')
              .catch((error: unknown) => addLog(`Failed to record FIND forwarding outcome: ${error instanceof Error ? error.message : String(error)}`));
            void state.aggregation.failChild(peer);
          }
        }
        // Remove dead manager so reconnect creates a fresh RTCPeerConnection
        closeAndRemoveAuthenticatedPeerManager(peer, manager);
        if (selectedContactIdRef.current === peer) {
          setDataChannelOpen(false);
          setActivePeerId(null);
        }
        updateContactState(peer, { connected: false, lastConnectionStatus: 'disconnected' });
        peerRecoveryRef.current?.notifyConnectivityChanged();
      },
      (peer: string, event: string) => {
        if (!isCurrentManager(peer)) return;
        if (/connection=failed|(?:offer|answer|ICE).*(?:failed|error|timeout)/i.test(event)) {
          recordPeerAttemptFailure(peer);
          addLog(redactNetworkAddresses(`Peer ${peer} connection failed: ${event}`));
        }
        addLog(redactNetworkAddresses(`Peer ${peer}: ${event}`));
      },
      (peer: string) => {
        if (!isCurrentManager(peer)) return;
        // Respond to PROFILE_REQUEST with our current profile
        const manager = peerManagersRef.current[peer];
        if (manager) {
          void sendPeerMetadata(manager, peer)
            .then(() => addLog(`Sent profile to ${peer} (on request)`))
            .catch((error: unknown) => addLog(`Failed to send profile to ${peer}: ${error instanceof Error ? error.message : String(error)}`));
        }
      },
      packetSigner,
      undefined,
      undefined,
      (peer, packet) => {
        objectTransportRef.current?.handlePacket(peer, packet);
      },
      {
        getConnectedPeerIds: () => objectTransportRef.current?.connectedPeers() ?? [],
        onPeerList: createPeerCandidateIntake(identity.id, (sourcePeerId, error) => {
          addLog(`Failed to store gossip peer candidates from ${sourcePeerId}: ${error instanceof Error ? error.message : String(error)}`);
        })
      },
      (peer, requestId) => {
        if (!isCurrentManager(peer)) return;
        const store = objectStoreRef.current;
        const localIdentity = identityRef.current;
        const currentManager = peerManagersRef.current[peer];
        if (!store || !localIdentity || currentManager !== manager || !manager.isDataChannelOpen()) return;
        void getLatestIdentityObject(store, localIdentity.publicKey)
          .then((profile) => manager.sendIdentityProfileResponse(requestId, profile))
          .then(() => addLog(`Sent signed identity profile response to ${peer}`))
          .catch((error: unknown) => addLog(`Failed to send signed identity profile to ${peer}: ${error instanceof Error ? error.message : String(error)}`));
      },
      (peer, _requestId, candidate) => {
        void handleIdentityProfileResponse(peer, manager, candidate)
          .catch((error: unknown) => addLog(`Failed to process signed identity profile from ${peer}: ${error instanceof Error ? error.message : String(error)}`));
      }
    );

    peerManagersRef.current[peerId] = manager;
    return manager;
  };

  const requestPeerOffer = (
    peerId: string,
    manager: PeerConnectionManager,
    socket: WebSocket,
    forceInitiation = false,
    attemptTimeoutMs = 30_000
  ) => {
    if (!identity?.id || peerId === identity.id) return;
    if (identity.id > peerId && !forceInitiation) {
      addLog(`Waiting for ${peerId} to initiate the peer connection`);
      startPeerWaitingInterval(peerId);
      startPeerElectionFallback(peerId);
      return;
    }
    if (manager.isDataChannelOpen() || activePeerAttemptsRef.current.has(peerId)) return;
    if (!startPeerAttemptTimeout(peerId, attemptTimeoutMs, 'outbound')) {
      addLog(`Peer ${peerId} connection attempt deferred: connection capacity is full`);
      settlePeerRecoveryAttempt(peerId, false);
      return;
    }
    void manager.createOffer(peerId, socket).catch((error: unknown) => {
      if (peerManagersRef.current[peerId] !== manager) return;
      recordPeerAttemptFailure(peerId);
      settlePeerRecoveryAttempt(peerId, false);
      addLog(`Peer ${peerId} connection failed: ${error instanceof Error ? error.message : String(error)}`);
      if (peerManagersRef.current[peerId] === manager && !manager.isDataChannelOpen()) {
        closeAndRemoveAuthenticatedPeerManager(peerId, manager);
      }
      peerRecoveryRef.current?.notifyConnectivityChanged();
    });
  };

  const initiatePeerConnections = (peerIds: readonly string[], sourceLabel: string) => {
    const localPeerId = identity?.id;
    if (!localPeerId) return;
    const candidates = [...new Set(peerIds)].filter((peerId) => (
      isValidPeerFingerprint(peerId)
      && peerId !== localPeerId
      && !blockedPeersRef.current.has(peerId)
    ));
    const socket = signallingSocketRef.current;
    let initiatedAttempts = 0;
    for (const peerId of candidates) {
      if ((peerCapacityRef.current?.getOccupiedCount() ?? 0) >= DEFAULT_PREFERRED_CONNECTION_TARGET) {
        addLog(`${sourceLabel} dialing stopped: preferred connection target reached`);
        break;
      }
      const manager = ensurePeerManager(peerId);
      if (!socket || socket.readyState !== WebSocket.OPEN || !manager) {
        addLog(`${sourceLabel} dial skipped for ${peerId}: signalling=${socket?.readyState === WebSocket.OPEN ? 'open' : 'closed'} manager=${manager ? 'ready' : 'missing'}`);
        continue;
      }

      const channelState = manager.getDataChannelState();
      if (channelState === 'open') {
        clearPeerWaitingInterval(peerId);
        clearPeerElectionFallback(peerId);
        addLog(`${sourceLabel} dial skipped for ${peerId}: data channel already open`);
        continue;
      }
      const electedToWait = localPeerId > peerId;
      if (electedToWait) {
        startPeerWaitingInterval(peerId);
        startPeerElectionFallback(peerId);
      }
      if (channelState === 'connecting' || manager.isNegotiating()) {
        addLog(`${sourceLabel} dial deferred for ${peerId}: channel=${channelState} negotiating=${manager.isNegotiating()}`);
        continue;
      }
      if (activePeerAttemptsRef.current.size >= 2 || initiatedAttempts >= 2) {
        addLog(`${sourceLabel} dial deferred for ${peerId}: connection attempt limit reached`);
        continue;
      }
      if (electedToWait) {
        addLog(`${sourceLabel} dial deferred for ${peerId}: local ID is not the initiator`);
        continue;
      }
      clearPeerWaitingInterval(peerId);
      clearPeerElectionFallback(peerId);
      addLog(`${sourceLabel} initiating connection to ${peerId}: channel=${channelState}`);
      requestPeerOffer(peerId, manager, socket);
      initiatedAttempts += 1;
    }
  };

  const discoverConnectedPeerProfiles = async (): Promise<string[]> => {
    const localIdentity = identityRef.current;
    const store = objectStoreRef.current;
    const objectTransport = objectTransportRef.current;
    if (!localIdentity || !store || !objectTransport || objectTransport.connectedPeers().length === 0) return [];

    const findTransport = wrapFindTransport({
      objectTransport,
      signPacket: (packet) => signString(localIdentity.privateKey, canonicalize(packet))
    });
    const result = await collectFindResults({
      transport: findTransport,
      sender: localIdentity.id,
      criteria: {
        object_type: IDENTITY_OBJECT_TYPE,
        author_connected: true,
        limit: 50
      },
      timeoutMs: 5000
    });
    const peerIds = await storeDiscoveredIdentityProfiles(store, result.objects, localIdentity.id);
    initiatePeerConnections(peerIds, 'FIND');
    return peerIds;
  };
  onlinePeerDiscoveryRef.current = async () => {
    await discoverConnectedPeerProfiles();
  };

  const handlePeerList = async (peers: string[], initiateConnections = true) => {
    const localPeerId = identity?.id;
    if (!localPeerId) return;
    const validPeers = peers.filter((peerId) => {
      if (!peerId || peerId === localPeerId) return false;
      return isValidPeerFingerprint(peerId) && !blockedPeersRef.current.has(peerId);
    });
    const invalidPeers = peers.filter((peerId) => !validPeers.includes(peerId) && !blockedPeersRef.current.has(peerId) && peerId !== localPeerId);
    if (invalidPeers.length) {
      addLog(`Ignoring ${invalidPeers.length} invalid peer ids from peer-list`);
    }
    addLog(`Peer-list received: ${peers.length} announced, ${validPeers.length} valid online peers`);
    const onlinePeerIds = new Set(validPeers);
    for (const peerId of peerElectionFallbackTimersRef.current.keys()) {
      if (!onlinePeerIds.has(peerId)) {
        clearPeerWaitingInterval(peerId);
        clearPeerElectionFallback(peerId);
      }
    }
    for (const peerId of waitingPeerIntervalsRef.current.keys()) {
      if (!onlinePeerIds.has(peerId)) clearPeerWaitingInterval(peerId);
    }
    const peerListForLog = [localPeerId, ...validPeers].sort();
    for (const peerId of validPeers) {
      const lowerPeerId = localPeerId < peerId ? localPeerId : peerId;
      addLog(`Peer list: [${peerListForLog.join(', ')}]; lower=${lowerPeerId}; elected-initiator=${localPeerId === lowerPeerId ? 'us' : 'them'}`);
    }

    for (const peerId of validPeers) {
      await addKnownPeer(peerId);
    }

    const nextContacts = dedupeContactsByFingerprint(contactsRef.current).map((contact) => ({
      ...contact,
      online: onlinePeerIds.has(contact.fingerprint)
    }));
    contactsRef.current = nextContacts;
    setContacts(nextContacts);

    if (!initiateConnections) return;
    initiatePeerConnections(validPeers, 'Peer-list');
  };

  useEffect(() => {
    if (!identity?.id || !contactsLoaded) return;

    const capacity = new PeerConnectionCapacity(
      () => objectTransportRef.current?.connectedPeers() ?? [],
      20,
      4,
      DEFAULT_PREFERRED_CONNECTION_TARGET
    );
    peerCapacityRef.current = capacity;
    const recovery = new PeerRecoveryCoordinator({
      getConnectedPeers: () => objectTransportRef.current?.connectedPeers() ?? [],
      getPendingPeerIds: () => capacity.getPendingPeerIds(),
      getPreviouslyConnectedPeers: () => contactsRef.current
        .filter((contact): contact is Contact & { lastSeen: string } => (
          isValidPeerFingerprint(contact.fingerprint) && typeof contact.lastSeen === 'string'
        ))
        .map((contact) => ({ peerId: contact.fingerprint, lastConnectedAt: contact.lastSeen })),
      getPeerUsefulnessEstimates: (peerIds, connectedPeerIds) =>
        estimateLocalPeerUsefulness(peerIds, connectedPeerIds),
      onPeerUsefulnessError: (error) => {
        addLog(`Peer usefulness estimate unavailable; retaining existing candidate order: ${error instanceof Error ? error.message : String(error)}`);
      },
      discoverOnlinePeers: async () => {
        const socket = signallingSocketRef.current;
        const localPeerId = identityRef.current?.id;
        if (!socket || !localPeerId) throw new Error('Signalling is not connected');
        let peers: string[];
        try {
          peers = await requestOnlinePeerList(socket, localPeerId);
        } catch (error) {
          addLog(`Online peer discovery failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        await handlePeerList(peers, false);
        return peers;
      },
      isAttemptInProgress: (peerId) => {
        const manager = peerManagersRef.current[peerId];
        return activePeerAttemptsRef.current.has(peerId)
          || Boolean(manager && (manager.isDataChannelOpen() || manager.isNegotiating()));
      },
      attemptPeer: (peerId) => {
        const socket = signallingSocketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN || blockedPeersRef.current.has(peerId)) {
          return Promise.resolve(false);
        }
        const manager = ensurePeerManager(peerId);
        if (!manager) return Promise.resolve(false);
        if (manager.isDataChannelOpen()) return Promise.resolve(true);
        if (manager.isNegotiating() || activePeerAttemptsRef.current.has(peerId)) {
          return Promise.resolve(false);
        }

        return new Promise<boolean>((resolve) => {
          peerRecoveryAttemptResolversRef.current.set(peerId, resolve);
          requestPeerOffer(peerId, manager, socket, true, 15_000);
        });
      }
    });

    peerRecoveryRef.current = recovery;
    recovery.notifyConnectivityChanged();
    return () => {
      recovery.dispose();
      for (const timeout of peerAttemptTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      peerAttemptTimeoutsRef.current.clear();
      activePeerAttemptsRef.current.clear();
      for (const resolve of peerRecoveryAttemptResolversRef.current.values()) resolve(false);
      peerRecoveryAttemptResolversRef.current.clear();
      if (peerRecoveryRef.current === recovery) peerRecoveryRef.current = null;
      if (peerCapacityRef.current === capacity) peerCapacityRef.current = null;
    };
  }, [identity?.id, contactsLoaded]);

  useEffect(() => {
    peerRecoveryRef.current?.notifyConnectivityChanged();
  }, [connectedPeerIds]);

  useEffect(() => {
    async function bootstrap() {
      let loadedIdentity: IdentityRecord | null = null;
      let profileForObject: Pick<typeof myProfile, 'displayName' | 'bio'> = myProfileRef.current;
      const stored = await loadIdentity();
      if (stored) {
        const id = stored.id ?? (await deriveFingerprint(stored.publicKey));
        loadedIdentity = { ...stored, id };
        await ensureTurnIceServers();
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
              ? fingerprintToHumanName(loadedIdentity?.id ?? rawDisplayName)
              : rawDisplayName;

            const restoredProfile = {
              displayName: sanitizedDisplayName,
              bio: typeof parsed.bio === 'string' ? parsed.bio : '',
              feedMix: {
                followedAuthors: Math.max(0, parsedFeedMix.followedAuthors),
                followedLikes: Math.max(0, parsedFeedMix.followedLikes),
                discoveryRandom: Math.max(0, parsedFeedMix.discoveryRandom)
              },
              blockedPeers,
              hiddenPeers
            };
            profileForObject = restoredProfile;
            setMyProfile(restoredProfile);
          }
        } catch {
          addLog('Saved profile settings could not be parsed; using defaults.');
        }
      }
      if (loadedIdentity) {
        await publishLocalIdentityProfile(loadedIdentity, profileForObject, false);
        setIdentity(loadedIdentity);
        addLog(`Identity loaded: ${loadedIdentity.id}`);
      }
    }
    void bootstrap().catch((error: unknown) => {
      addLog(`Identity bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, []);

  useEffect(() => {
    async function loadLocalData() {
      const cs = await loadContacts();
      const loadedContacts = await Promise.all(dedupeContactsByFingerprint(cs || []).map(async (contact) => {
        const cachedProfile = contact.identityObject;
        if (!cachedProfile) return contact;
        if (isObjectExpired(cachedProfile)
          || !(await validateIdentityObject(cachedProfile))
          || await deriveFingerprint(cachedProfile.author) !== contact.fingerprint) {
          const { identityObject: _cachedProfile, ...contactWithoutCachedProfile } = contact;
          return { ...contactWithoutCachedProfile, displayName: undefined };
        }
        return {
          ...contact,
          publicKey: cachedProfile.author,
          displayName: cachedProfile.payload.display_name
        };
      }));
      contactsRef.current = loadedContacts;
      setContacts(loadedContacts);
      setContactsLoaded(true);
      addLog(`Contacts loaded: ${loadedContacts.length}`);
      const store = objectStoreRef.current;
      if (store) {
        try {
          for (const profile of await getLatestIdentityObjects(store)) {
            await updateContactFromIdentityObject(profile);
          }
        } catch (error) {
          addLog(`Cached signed profiles could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    void loadLocalData().catch((error: unknown) => {
      addLog(`Contacts could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    });
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
          const peerIds = Array.isArray(message.peers)
            ? message.peers.filter((peerId): peerId is string => typeof peerId === 'string')
            : [];
          const peerListMessage = { ...message, peers: peerIds };
          const isRecoveryResponse = resolveOnlinePeerList(peerListMessage);
          await handlePeerList(
            peerIds.filter((peerId) => !blockedPeersRef.current.has(peerId)),
            !isRecoveryResponse
          );
          peerRecoveryRef.current?.notifyConnectivityChanged();
          return;
        }

        if (message.type === 'discovery-result') {
          handleDiscoveryResult(message.packet);
          return;
        }

        if (message.type === 'peer-discovery-result') {
          handlePeerDiscoveryResult(message.packet);
          return;
        }

        if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
          const peerId = message.from;
          if (peerId === identityRef.current?.id) {
            addLog(`Ignoring signalling message from self: ${message.type}`);
            return;
          }
          if (!isValidPeerFingerprint(peerId) || blockedPeersRef.current.has(peerId)) {
            addLog(`Ignoring signalling message from invalid or blocked peer: ${peerId}`);
            return;
          }
          if (message.type === 'offer') {
            if (!startPeerAttemptTimeout(peerId, 30_000, 'inbound')) {
              addLog(`Ignoring inbound offer from ${peerId}: connection capacity is full`);
              return;
            }
          } else if (
            !objectTransportRef.current?.connectedPeers().includes(peerId)
            && !activePeerAttemptsRef.current.has(peerId)
          ) {
            addLog(`Ignoring ${message.type} from ${peerId} without an admitted connection attempt`);
            return;
          }
          const manager = ensurePeerManager(peerId);
          if (manager) {
            try {
              await manager.handleSignal(message, socket);
            } catch (error) {
              if (peerManagersRef.current[peerId] !== manager) return;
              recordPeerAttemptFailure(peerId);
              settlePeerRecoveryAttempt(peerId, false);
              addLog(`Peer ${peerId} signalling negotiation failed: ${error instanceof Error ? error.message : String(error)}`);
              closeAndRemoveAuthenticatedPeerManager(peerId, manager);
              peerRecoveryRef.current?.notifyConnectivityChanged();
            }
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

      let initiatedAttempts = 0;
      dedupeContactsByFingerprint(contactsRef.current).forEach((contact) => {
        if (!contact.fingerprint || contact.fingerprint === identity.id) return;
        if (!contact.online) return;
        if (activePeerAttemptsRef.current.has(contact.fingerprint) || initiatedAttempts >= 2) return;
        const manager = ensurePeerManager(contact.fingerprint);
        if (!manager) return;

        const shouldReconnect = manager.needsReplacement() || !manager.isDataChannelOpen();

        if (shouldReconnect && !manager.isNegotiating() && contact.lastConnectionStatus !== 'signalling' && contact.lastConnectionStatus !== 'connecting') {
          addLog(`Reconnect attempt to ${contact.fingerprint}`);
          requestPeerOffer(contact.fingerprint, manager, socket);
          initiatedAttempts += 1;
        }
      });
    }, 30000);

    return () => window.clearInterval(interval);
  }, [identity]);

  useEffect(() => {
    if (!identity?.id) return;
    void handleRefreshHomeFeed();
  }, [identity?.id]);

  useEffect(() => {
    if (!identity?.id) return;
    const interval = window.setInterval(() => {
      void refreshTurnIceServers();
    }, 10 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [identity?.id]);

  useEffect(() => {
    if (!identity?.id || signallingStatus !== 'connected') return;
    void handleFetchDiscovery();
    const store = objectStoreRef.current;
    if (!store) return;
    void getLatestIdentityObject(store, identity.publicKey)
      .then(async (profile) => {
        if (profile) await publishIdentityProfileToDiscovery(profile);
      })
      .catch((error: unknown) => addLog(`Failed to load signed identity profile for discovery publication: ${error instanceof Error ? error.message : String(error)}`));
  }, [identity?.id, signallingStatus]);

  useEffect(() => {
    const activePage = conversationPostId ? null : page;
    if (activePageRef.current === activePage) return;
    activePageRef.current = activePage;

    if (!identity?.id) return;
    if (activePage === 'discover' && signallingStatus === 'connected') void handleFetchDiscovery();
  }, [page, conversationPostId, identity?.id, signallingStatus]);

  useEffect(() => {
    if (!identity?.id || page !== 'home' || conversationPostId) return;
    void handleRefreshHomeFeed();
  }, [page, conversationPostId, identity?.id, contacts.length]);

  useEffect(() => {
    if (!identity?.id || !contactsLoaded || connectedPeerIds.length > 0 || signallingStatus !== 'connected' || peerPoolRequestedRef.current) return;
    const socket = signallingSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    peerPoolRequestedRef.current = true;
    void fetchPeerPool(socket).then((peerIds) => {
      setPossiblePeerIds(peerIds.filter((peerId) => peerId !== identity.id && !blockedPeersRef.current.has(peerId)));
      addLog(`Loaded ${peerIds.length} possible peers from discovery`);
    }).catch((error: unknown) => {
      addLog(`Peer pool request failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [identity?.id, contactsLoaded, connectedPeerIds.length, signallingStatus]);

  useEffect(() => {
    if (!identity?.id || !contactsLoaded || signallingStatus !== 'connected' || popularPeersRequestedRef.current) return;
    const socket = signallingSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    popularPeersRequestedRef.current = true;
    void fetchPopularPeers(socket).then(async (peers) => {
      const verifiedPeers = await validatePopularPeerProfiles(peers);
      setPopularPeers(verifiedPeers.filter((peer) => peer.peer_id !== identity.id && !blockedPeersRef.current.has(peer.peer_id)));
    }).catch((error: unknown) => {
      addLog(`Popular peers request failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [identity?.id, contactsLoaded, contacts, signallingStatus]);

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
    if (!identity) return false;
    const normalized = address.trim();
    if (!normalized) return false;
    const peerId = parsePeerId(normalized);
    if (normalized.startsWith('@') && !peerId) {
      addLog('Could not add peer: the supplied @handle is invalid.');
      return false;
    }
    const blockedPeerAddress = peerId ?? normalized;
    if (blockedPeersRef.current.has(blockedPeerAddress)) {
      addLog(`Refusing to add blocked peer address: ${blockedPeerAddress}`);
      return false;
    }

    let fingerprint = peerId ?? normalized;
    let publicKey = peerId ?? normalized;

    if (!peerId && !normalized.includes(':') && !normalized.startsWith('myc:') && normalized.length > 40) {
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
      followed: true,
      follower: existing?.follower,
      online: existing?.online ?? false,
      connected: existing?.connected ?? false,
      lastConnectionStatus: existing?.lastConnectionStatus,
      lastSeen: existing?.lastSeen,
      profile: existing?.profile,
      lastReadAt: existing?.lastReadAt
    };

    await saveContact(contact);
    setContacts((prev) => {
      const filtered = prev.filter((entry) => entry.fingerprint !== fingerprint);
      const next = dedupeContactsByFingerprint([...filtered, contact]);
      contactsRef.current = next;
      return next;
    });

    addLog(`Added peer address ${fingerprint}`);
    if (!existing?.followed) {
      addLog(`Following ${fingerprint}`);
    }

    const socket = signallingSocketRef.current;
    const manager = ensurePeerManager(fingerprint);
    if (socket && socket.readyState === WebSocket.OPEN && manager) {
      if (manager.isDataChannelOpen()) {
        await sendPeerMetadata(manager, fingerprint, true);
      } else {
        requestPeerOffer(fingerprint, manager, socket);
      }
      addLog(`Attempting connection to ${fingerprint}`);
    } else {
      addLog('Peer added. Waiting for signalling connection to connect.');
    }
    return true;
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
        await sendPeerMetadata(manager, fingerprint, updated.followed);
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
      const store = objectStoreRef.current;
      if (!store) throw new Error('Object store is unavailable');
      const chain = await cachePostChain(target.object, target.source ?? 'peer');
      if (chain.stopReason === 'invalid-object' || chain.storageFailures.includes(objectId)) {
        addLog(`Like cancelled: target post ${objectId} could not be validated and cached`);
        return;
      }
      const isLiked = getRecommendationSummary(objectId).recommended_by_me;
      const sequence = await recommendationSequenceStoreRef.current!.next(identity.publicKey);
      const recommendation = await createSignedRecommendationObject(objectId, isLiked ? 'withdraw' : 'recommend', sequence, createObjectIdentity(identity));
      await objectStoreRef.current?.put(recommendation);
      recommendationIndexRef.current.add(recommendation);
      setRecommendationRevision((revision) => revision + 1);
      setPostViews((prev) => upsertLocalPostView(prev, target));
      setDiscoveryPosts((prev) => upsertLocalPostView(prev, target));
      await localPostMetadataStoreRef.current?.put(localPostMetadata(target));
      const socket = signallingSocketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          await publishObject(recommendation, socket);
          addLog(`Published ${isLiked ? 'recommendation withdrawal' : 'recommendation'} to discovery`);
        } catch (error) {
          addLog(`Discovery recommendation publish failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        addLog('Discovery recommendation publish skipped: not connected to signalling server');
      }
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

  const submitDeleteRequest = async (target: DistributedObject) => {
    try {
      if (!identity) throw new Error('A local identity is required to delete an object');
      const store = objectStoreRef.current;
      if (!store || !isDeletionAwareObjectStore(store)) {
        throw new Error('Deletion-aware object storage is unavailable');
      }
      const request = await createDeleteRequest(target, createObjectIdentity(identity));
      if (!(await acceptDeleteRequest(request, store))) {
        throw new Error('The Delete Request was not accepted by local storage');
      }
      await handleAcceptedDeleteRequest(request);
      addLog(`Created and applied Delete Request ${request.object_id} for ${target.object_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfileNotice(`Could not delete this object: ${message}`);
      addLog(`Delete Request failed for ${target.object_id}: ${message}`);
    }
  };

  const handleDeletePost = async (objectId: string) => {
    const store = objectStoreRef.current;
    if (!store) return;
    const target = await store.get(objectId)
      ?? [...postViews, ...discoveryPosts, ...discoveryReplyPosts]
        .find((view) => view.object.object_id === objectId)?.object
      ?? null;
    if (!target) {
      setProfileNotice('This post is no longer available to delete.');
      return;
    }
    await submitDeleteRequest(target);
  };

  const handleDeleteMessage = async (objectId: string) => {
    const target = await objectStoreRef.current?.get(objectId);
    if (!target) {
      setProfileNotice('This message is no longer available to delete.');
      return;
    }
    await submitDeleteRequest(target);
  };

  async function handleCreatePost(
    publishToDiscovery = false,
    replyTo?: string,
    replyContent?: string,
    selectedMentions: readonly PostMention[] = []
  ) {
    if (!identity) return;
    const isReply = Boolean(replyTo);
    const content = (isReply ? replyContent : newPostContent)?.trim() ?? '';
    if (!content) return;
    if (content.length > MAX_POST_CONTENT_LENGTH) {
      addLog(`Post cancelled: content exceeds the ${MAX_POST_CONTENT_LENGTH.toLocaleString()} character limit.`);
      return;
    }
    const mentions = isReply ? [] : mentionsPresentInText(content, selectedMentions);
    const tags = isReply ? [] : newPostTags.split(',').map((t) => t.trim()).filter(Boolean);
    const objectStore = objectStoreRef.current;
    if (!objectStore) throw new Error('Object store is unavailable');
    let replyTarget = replyTo
      ? [...postViews, ...discoveryPosts].find((post) => post.object.object_id === replyTo)
      : undefined;
    if (replyTo) {
      if (!/^[0-9a-f]{64}$/.test(replyTo)) {
        addLog(`Reply cancelled: invalid parent object ID ${replyTo}`);
        return;
      }
      let parentObject = await objectStore.get(replyTo);
      if (!parentObject && replyTarget) parentObject = replyTarget.object;
      if (!parentObject) parentObject = await resolvePostParentFromPeers(replyTo);
      if (!parentObject || parentObject.object_id !== replyTo || parentObject.object_type !== 'mycelium.post') {
        addLog(`Reply cancelled: parent post ${replyTo} is unavailable`);
        return;
      }
      const parentChain = await cachePostChain(parentObject, replyTarget?.source ?? 'peer');
      if (parentChain.stopReason === 'invalid-object' || parentChain.storageFailures.includes(replyTo)) {
        addLog(`Reply cancelled: parent post ${replyTo} could not be validated and cached`);
        return;
      }
      if (!replyTarget || replyTarget.object.object_id !== replyTo) {
        replyTarget = createLocalPostView(
          parentObject as PostObject,
          await resolvePostAuthorFingerprint(parentObject.author),
          { source: 'peer' }
        );
      }
    }
    const objectIdentity = createObjectIdentity(identity);
    const imageSizes = await checkExternalImageSizes(content);
    const postObject = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: new Date().toISOString(),
      payload: createPostObjectPayload(content, tags, mentions, replyTo, replyTarget?.authorFingerprint, imageSizes),
      replication_policy: {}
    }, objectIdentity) as PostObject;
    await objectStore.put(postObject);
    const postChain = await ensurePostChainCached(postObject, objectStore, resolvePostParentFromPeers);
    logPostChainResult(postObject.object_id, postChain);

    const localPostView = createLocalPostView(postObject, identity.id, { source: 'local' });
    recordNewEligibleHomePosts([localPostView]);
    setPostViews((prev) => upsertLocalPostView(prev, localPostView));
    await localPostMetadataStoreRef.current?.put(localPostMetadata(localPostView));

    addLog(`Created and stored object post ${postObject.object_id}`);
    if (!isReply) {
      setNewPostContent('');
      setNewPostTags('');
    }

    if (replyTo) {
      const targetPost = replyTarget;
      const targetPeer = targetPost
        ? targetPost.authorFingerprint
        : undefined;
      if (targetPost && targetPeer && identity) {
        const replyIdentity = createObjectIdentity(identity);
        const replyObject = await createSignedObject({
          object_type: 'mycelium.reply',
          created_at: new Date().toISOString(),
          payload: createReplyObjectPayload(replyTo, targetPeer, postObject.object_id, content),
          replication_policy: {}
        }, replyIdentity);
        const replyResult = await sendReplyToAuthor(identity.id, replyObject, objectTransportRef.current!, targetPeer, (packet) => signString(identity.privateKey, canonicalize(packet)));
        addLog(replyResult.sent
          ? `Pushed reply object ${replyObject.object_id} to ${targetPeer}`
          : `Reply object ${replyObject.object_id} author ${targetPeer} is not connected`);
      }
    }

    const objectTransport = objectTransportRef.current;
    const directlySharedMentionPeers = new Set<string>();
    for (const peerId of objectTransport?.connectedPeers() ?? []) {
      const contact = contacts.find((c) => c.fingerprint === peerId);
      const isMentionTarget = mentions.some((mention) => mention.peerId === peerId);
      if (((contact?.followed && contact.connected) || isMentionTarget) && objectTransport) {
        if (isMentionTarget) directlySharedMentionPeers.add(peerId);
        try {
          const sentCount = await sendObjectBatches(
            identity.id,
            peerId,
            postChain.objects,
            objectTransport,
            (packet) => signString(identity.privateKey, canonicalize(packet))
          );
          addLog(`Shared canonical post chain (${sentCount} objects) ending ${postObject.object_id} with connected ${isMentionTarget ? 'mentioned peer' : 'followed peer'} ${peerId}`);
        } catch (error) {
          addLog(`Failed to share post chain ending ${postObject.object_id} with ${peerId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const directMentionTargets = [...new Set(mentions
      .map((mention) => mention.peerId)
      .filter((peerId) => !directlySharedMentionPeers.has(peerId)))];
    if (objectTransport && directMentionTargets.length > 0) {
      const results = await sendObjectToPeers(
        identity.id,
        postObject,
        directMentionTargets,
        objectTransport,
        (packet) => signString(identity.privateKey, canonicalize(packet))
      );
      for (const result of results) {
        addLog(result.sent
          ? `Pushed mentioned post ${postObject.object_id} directly to ${result.peerId}`
          : `Mentioned post ${postObject.object_id} direct delivery ${result.reachable ? `failed: ${result.error ?? 'unknown transport error'}` : 'skipped: peer is not connected'} for ${result.peerId}`);
      }
    }

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

  const allCachedPosts = mergeLocalPostViews(postViews, discoveryPosts);
  const visibleConversationPosts = allCachedPosts.filter((post) => !isHiddenPost(post) && !isBlockedPost(post));
  const locallyKnownReplyCounts = useMemo(() => {
    const cachedPosts = mergeLocalPostViews(mergeLocalPostViews(postViews, discoveryPosts), discoveryReplyPosts);
    const visiblePosts = cachedPosts.filter((post) => !isHiddenPost(post) && !isBlockedPost(post));
    return buildLocalDirectReplyCounts(visiblePosts);
  }, [postViews, discoveryPosts, discoveryReplyPosts, blockedPeerSet, hiddenPostIds, hiddenDiscoveryIds]);
  const activeConversationPost = conversationPostId
    ? allCachedPosts.find((post) => post.object.object_id === conversationPostId)
    : undefined;

  useEffect(() => {
    if (!conversationPostId || !activeConversationPost || !identity) return;
    let cancelled = false;
    setConversationAncestry({ postId: conversationPostId, loading: true });

    const resolveParentPost = async (parentId: string): Promise<LocalPostView | null> => {
      const cachedView = allCachedPosts.find((candidate) => candidate.object.object_id === parentId);
      if (cachedView) return cachedView;

      const store = objectStoreRef.current;
      if (!store) throw new Error('Object store is unavailable');
      let object = await store.get(parentId);
      if (!object) {
        const transport = objectTransportRef.current;
        const peers = transport?.connectedPeers().slice(0, 4) ?? [];
        let retrievalError: unknown;
        for (const peerId of peers) {
          if (!transport) break;
          try {
            object = await findObject(
              identity.id,
              peerId,
              parentId,
              transport,
              store,
              2,
              (request) => handleAcceptedDeleteRequest(request, false),
              (supplierPeerId, validatedObject) => observeValidatedObjectSupply(supplierPeerId, validatedObject, addLog)
            );
          } catch (error) {
            retrievalError = error;
            addLog(`Parent FIND via ${peerId} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (object) break;
        }
        if (!object && retrievalError) throw retrievalError;
      }
      if (!object || object.object_type !== 'mycelium.post') return null;

      const metadataStore = localPostMetadataStoreRef.current;
      const metadata = await metadataStore?.get(parentId);
      const authorFingerprint = metadata?.authorFingerprint ?? await resolvePostAuthorFingerprint(object.author);
      const parentView = createLocalPostView(object as PostObject, authorFingerprint, {
        ...(metadata?.source ? { source: metadata.source } : { source: 'peer' as const }),
        ...(metadata?.notInterested === undefined ? {} : { notInterested: metadata.notInterested }),
        ...(metadata?.hidden === undefined ? {} : { hidden: metadata.hidden })
      });
      if (metadataStore) await metadataStore.put(localPostMetadata(parentView));
      setPostViews((previous) => upsertLocalPostView(previous, parentView));
      return parentView;
    };

    void loadPostAncestry(activeConversationPost, allCachedPosts, resolveParentPost).then((result) => {
      if (!cancelled) setConversationAncestry({ postId: conversationPostId, loading: false, result });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setConversationAncestry({ postId: conversationPostId, loading: false, error: true });
      addLog(`Conversation ancestry retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      cancelled = true;
    };
  }, [conversationPostId, activeConversationPost?.object.object_id, identity?.id]);

  const visibleHomePosts = useMemo(() => {
    const followedContacts = contacts.filter((contact) => contact.followed);
    const followedAuthorKeys = new Set([
      ...followedContacts.flatMap((contact) => [contact.fingerprint, contact.publicKey]),
      ...(identity ? [identity.id, identity.publicKey] : [])
    ]);
    const followedKeyDiagnostics = [...new Set(followedContacts.map((contact) => contact.publicKey).filter(Boolean))]
      .slice(0, 3)
      .map((publicKey) => `${publicKey.slice(0, 12)}…:${followedAuthorKeys.has(publicKey)}`);
    addLog(`Home feed followed keys: contacts=${followedContacts.length} sample=${followedKeyDiagnostics.join(',') || 'none'}`);
    const authoredByFollowed = (post: LocalPostView) =>
      followedAuthorKeys.has(post.object.author) || followedAuthorKeys.has(post.authorFingerprint);
    const followedPostCount = postViews.filter(authoredByFollowed).length;
    const visiblePostPool = mergeLocalPostViews(postViews, discoveryPosts)
      .filter((post) => !isHiddenPost(post) && !isBlockedPost(post));
    const afterFilterCount = postViews.filter((post) =>
      authoredByFollowed(post) && !isHiddenPost(post) && !isBlockedPost(post)
    ).length;
    const baseline = selectFollowedPosts(visiblePostPool, followedAuthorKeys);
    const recommendationCandidates = selectRecommendationCandidates(
      visiblePostPool,
      getRecommendationSummary,
      {
        capacity: Math.floor(baseline.length * 20 / 70),
        localIdentity: identity?.publicKey ?? '',
        feedDay: new Date().toISOString().slice(0, 10),
        followedAuthorKeys,
        alreadySelectedIds: new Set(baseline.map((post) => post.object.object_id)),
        isHidden: isHiddenPost,
        isBlocked: isBlockedPost
      }
    );
    const selectedIds = new Set([
      ...baseline.map((post) => post.object.object_id),
      ...recommendationCandidates.map((post) => post.object.object_id)
    ]);
    homeFeedInjectionCandidatesRef.current = {
      recommendations: recommendationCandidates,
      discovery: [...visibleDiscoveryPosts]
        .filter((post) => !selectedIds.has(post.object.object_id))
        .sort((left, right) =>
          (locallyKnownReplyCounts.get(right.object.object_id) ?? 0) - (locallyKnownReplyCounts.get(left.object.object_id) ?? 0)
          || Date.parse(right.object.created_at) - Date.parse(left.object.created_at)
          || left.object.object_id.localeCompare(right.object.object_id)
        )
    };
    const computedHomePosts = composeHomeFeed({
      baseline,
      recommendations: recommendationCandidates,
      discovery: visibleDiscoveryPosts,
      injections: homeFeedInjectionSchedulerRef.current?.getState().injections ?? [],
      getRecommendationSummary,
      replyCounts: locallyKnownReplyCounts
    });
    if (computedHomePosts.length > 0) {
      addLog(`Selector computed: final=${computedHomePosts.length} first-injectedAt=${computedHomePosts[0].injectedAt} first-created=${computedHomePosts[0].object.created_at.slice(0, 19)}`);
    }
    addLog(`Home feed selector: total posts=${postViews.length} followed=${followedPostCount} after-filter=${afterFilterCount} final=${computedHomePosts.length}`);
    return computedHomePosts;
  }, [postViews, discoveryPosts, contacts, identity, blockedPeerSet, hiddenPostIds, hiddenDiscoveryIds, recommendationRevision, homeFeedInjectionRevision, locallyKnownReplyCounts]);

  const homeFeedInjectionCandidateRevision = [
    ...homeFeedInjectionCandidatesRef.current.recommendations.map((post) => post.object.object_id),
    '::',
    ...homeFeedInjectionCandidatesRef.current.discovery.map((post) => post.object.object_id)
  ].join('|');
  useEffect(() => {
    flushPendingHomeFeedInjections();
  }, [homeFeedInjectionCandidateRevision, identity?.id, flushPendingHomeFeedInjections]);

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

  function currentNavigationState(): AppNavigationState {
    const storedState = readAppNavigationState(window.history.state);
    return {
      ...storedState,
      page,
      conversationPostId,
      focusedReplyId: conversationFocusPostId,
      profileContactId,
      relationshipOwnerId,
      relationshipTab,
      chatContactId,
      conversationReturnScrollTop: conversationPostId
        ? conversationReturnScrollTopRef.current
        : storedState.conversationReturnScrollTop
    };
  }

  function commitNavigation(target: AppNavigationState, mode: 'push' | 'replace' = 'push') {
    const pageContainer = document.getElementById('page-content');
    const current = currentNavigationState();
    const currentScrollTop = pageContainer?.scrollTop ?? current.scrollTop;
    const savedCurrent = { ...current, scrollTop: currentScrollTop };
    window.history.replaceState(
      withAppNavigationState(window.history.state, savedCurrent),
      '',
      window.location.href
    );

    if (mode === 'push') {
      const sameDestination = target.page === current.page
        && target.conversationPostId === current.conversationPostId
        && target.focusedReplyId === current.focusedReplyId
        && target.profileContactId === current.profileContactId
        && target.relationshipOwnerId === current.relationshipOwnerId
        && target.chatContactId === current.chatContactId;
      if (sameDestination) return;
      window.history.pushState(
        withAppNavigationState(window.history.state, target),
        '',
        window.location.href
      );
    } else {
      window.history.replaceState(
        withAppNavigationState(window.history.state, target),
        '',
        window.location.href
      );
    }

    setPage(target.page);
    setConversationPostId(target.conversationPostId);
    setConversationFocusPostId(target.focusedReplyId);
    setProfileContactId(target.profileContactId);
    profileContactIdRef.current = target.profileContactId;
    setRelationshipOwnerId(target.relationshipOwnerId);
    setRelationshipTab(target.relationshipTab);
    setChatContactId(target.chatContactId);
    if (target.chatContactId) setSelectedContactId(target.chatContactId);
    conversationReturnScrollTopRef.current = target.conversationReturnScrollTop ?? 0;
    pendingScrollRestoreRef.current = target.scrollTop;
    setNavigationRevision((revision) => revision + 1);
  }

  function handlePageChange(nextPage: PageKey) {
    const pageContainer = document.getElementById('page-content');
    const currentScrollTop = pageContainer?.scrollTop ?? 0;
    setPageScrollPositions((previous) => ({ ...previous, [page]: currentScrollTop }));
    commitNavigation({
      page: nextPage,
      conversationPostId: null,
      focusedReplyId: null,
      profileContactId: null,
      relationshipOwnerId: null,
      relationshipTab,
      chatContactId: null,
      scrollTop: pageScrollPositions[nextPage] ?? 0,
      conversationReturnScrollTop: null
    });
  }

  function handleBackToMessages() {
    commitNavigation({
      ...currentNavigationState(),
      page: 'messages',
      conversationPostId: null,
      focusedReplyId: null,
      profileContactId: null,
      relationshipOwnerId: null,
      chatContactId: null,
      scrollTop: pageScrollPositions.messages ?? 0,
      conversationReturnScrollTop: null
    }, 'replace');
  }

  function handleOpenRelationships(ownerId: string, tab: RelationshipTab) {
    commitNavigation({
      ...currentNavigationState(),
      page: 'relationships',
      conversationPostId: null,
      focusedReplyId: null,
      profileContactId: null,
      relationshipOwnerId: ownerId,
      relationshipTab: tab,
      chatContactId: null,
      scrollTop: pageScrollPositions.relationships ?? 0,
      conversationReturnScrollTop: null
    });
  }

  function handleRelationshipTabChange(tab: RelationshipTab) {
    if (tab === relationshipTab) return;
    commitNavigation({
      ...currentNavigationState(),
      relationshipTab: tab
    }, 'replace');
  }

  function handleOpenConversation(postId: string, focusedReplyId?: string) {
    const current = currentNavigationState();
    const returnScrollTop = current.conversationPostId
      ? conversationReturnScrollTopRef.current
      : document.getElementById('page-content')?.scrollTop ?? 0;
    commitNavigation({
      ...current,
      conversationPostId: postId,
      focusedReplyId: focusedReplyId ?? null,
      scrollTop: 0,
      conversationReturnScrollTop: returnScrollTop
    });
  }

  function handleLeaveConversation() {
    if (!conversationPostId) return;
    const current = currentNavigationState();
    commitNavigation({
      ...current,
      conversationPostId: null,
      focusedReplyId: null,
      scrollTop: conversationReturnScrollTopRef.current,
      conversationReturnScrollTop: null
    });
  }

  function handleOpenParentConversation(parentPostId: string, currentPostId: string) {
    handleOpenConversation(parentPostId, currentPostId);
  }

  const handleToggleHeader = () => {
    setCollapsedHeader((prev) => !prev);
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
    if (!pageContainer) return;
    if (conversationPostId && conversationFocusPostId) {
      pendingScrollRestoreRef.current = null;
      return;
    }
    const pendingScrollTop = pendingScrollRestoreRef.current;
    pageContainer.scrollTop = pendingScrollTop ?? pageScrollPositions[page] ?? 0;
    pendingScrollRestoreRef.current = null;
  }, [identity, page, conversationPostId, conversationFocusPostId, navigationRevision, pageScrollPositions]);

  async function handleRefreshHomeFeed() {
    if (!identity) return;

    const socket = signallingSocketRef.current;
    const followedPeers = contactsRef.current.filter((contact) => contact.followed && contact.fingerprint !== identity.id);

    if (!socket || socket.readyState !== WebSocket.OPEN || followedPeers.length === 0) {
      return;
    }

    for (const contact of followedPeers) {
      const manager = peerManagersRef.current[contact.fingerprint] ?? ensurePeerManager(contact.fingerprint);
      if (!manager) continue;

      if (!manager.isDataChannelOpen() && contact.online) {
        const channelState = manager.getDataChannelState();
        if (channelState === 'closed' || channelState === 'missing') {
          requestPeerOffer(contact.fingerprint, manager, socket);
          addLog(`Reconnecting to ${contact.fingerprint} to fetch home updates`);
        }
      }
    }

    const connectedFollowedPeers = followedPeers
      .filter((contact) => peerManagersRef.current[contact.fingerprint]?.isDataChannelOpen())
      .map((contact) => contact.fingerprint);
    let nextPeerIndex = 0;
    const workers = Array.from({ length: Math.min(3, connectedFollowedPeers.length) }, async () => {
      while (nextPeerIndex < connectedFollowedPeers.length) {
        const index = nextPeerIndex++;
        await syncFeedPeer(connectedFollowedPeers[index]);
      }
    });
    await Promise.all(workers);

    localStorage.setItem('myceliumLastHomeSync', new Date().toISOString());
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
      const validated = await validateDiscoveryObjects(items);
      const createView = async (object: PostObject): Promise<LocalPostView> => {
        const knownContact = contactsRef.current.find((contact) =>
          contact.fingerprint === object.author || contact.publicKey === object.author
        );
        const authorFingerprint = knownContact?.fingerprint || (isValidPeerFingerprint(object.author) ? object.author : await deriveFingerprint(object.author).catch(() => object.author));
        return createLocalPostView(object, authorFingerprint, {
          source: 'discovery'
        });
      };
      const [verifiedPosts, verifiedReplies] = await Promise.all([
        Promise.all(validated.posts.map(createView)),
        Promise.all(validated.replies.map(createView))
      ]);
      const recommendationChanges = recommendationIndexRef.current.addAll(validated.recommendations);
      if (recommendationChanges > 0) setRecommendationRevision((revision) => revision + 1);
      const discoveryStore = objectStoreRef.current;
      if (discoveryStore) {
        const knownPostIds = new Set((await Promise.all(
          verifiedPosts.map(async (view) => await discoveryStore.get(view.object.object_id) ? view.object.object_id : null)
        )).filter((postId): postId is string => postId !== null));
        for (const recommendation of validated.recommendations) {
          try {
            await discoveryStore.put(recommendation);
          } catch (error) {
            addLog(`Discovery recommendation storage failed for ${recommendation.object_id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const expanded = await expandObjectsWithPostChains(
          verifiedPosts.map((view) => view.object),
          discoveryStore,
          resolvePostParentFromPeers
        );
        const newlyCachedPostIds = new Set(expanded.chains.flatMap((chain) => chain.newlyCachedObjectIds));
        expanded.chains.forEach((chain) => {
          if (!chain.complete || chain.storageFailures.length > 0) {
            logPostChainResult(chain.objects[chain.objects.length - 1]?.object_id ?? 'unknown', chain);
          }
        });
        verifiedPosts
          .filter((view) => newlyCachedPostIds.has(view.object.object_id))
          .forEach((view) => void notifyNewlyAcceptedObject(view.object));
        recordNewEligibleHomePosts(verifiedPosts.filter((view) => !knownPostIds.has(view.object.object_id)));
      }
      void replyUnread.discover([...verifiedPosts, ...verifiedReplies].map((post) => post.object));
      setDiscoveryReplyPosts((previous) => mergeLocalPostViews(previous, verifiedReplies));
      setDiscoveryPosts((prev) => {
        const merged = mergeLocalPostViews(prev, verifiedPosts);
        return merged.sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime());
      });
      addLog(`Discovery result: received=${items.length} posts=${verifiedPosts.length} replies=${verifiedReplies.length} recommendations=${validated.recommendations.length} unsupported=${validated.unsupportedCount} invalid=${validated.invalidCount}`);
    } catch (err: any) {
      const message = err?.message || String(err);
      addLog(`Discovery fetch failed (${signalEndpoint}): ${message}`);
    }
  }

  async function handleCreateIdentity() {
    await ensureTurnIceServers();
    const keys = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(keys.publicKey);
    const privateKey = await exportPrivateKey(keys.privateKey);
    const identityId = await deriveFingerprint(publicKey);
    const identityRecord = await ensureIdentityEncryptionKeyPair({ key: 'local', publicKey, privateKey, id: identityId });
    await saveIdentity(identityRecord);
    await publishLocalIdentityProfile({ ...identityRecord, id: identityId }, myProfileRef.current);
    setIdentity(identityRecord as IdentityRecord);
  }

  async function handleExportIdentity(passphrase: string) {
    if (!identity) return;

    let encryptedPayload: VaultBlob | undefined;
    if (passphrase.length > 0) {
      try {
        encryptedPayload = await encryptJsonPayload(createIdentityBackupPayload(identity), passphrase);
      } catch (error) {
        addLog(`Identity backup encryption failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error('Could not encrypt the identity backup.');
      }
    }

    const exportPayload = {
      ...(encryptedPayload
        ? { format: 'mycelium-encrypted-identity-backup', encryptedPayload }
        : createIdentityBackupPayload(identity))
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

  async function handleExportLocalObservations() {
    const observations = await exportLocalObservations();
    const blob = new Blob([JSON.stringify(observations, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mycelium-local-observations.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_E2E_TEST_API !== 'true' || !identity) return;
    const findObjectsByQuery = async (
      peerId: string,
      objectType: string,
      authorConnected?: boolean,
      ttl = 1
    ) => {
      const localIdentity = identityRef.current;
      const transport = objectTransportRef.current;
      if (!localIdentity || !transport || !transport.connectedPeers().includes(peerId)) {
        throw new Error(`FIND target ${peerId} is not connected`);
      }
      const requestId = createPacketId();
      const packet = await buildFindPacket(
        localIdentity.id,
        peerId,
        [],
        undefined,
        requestId,
        ttl,
        localIdentity.id,
        new Date(Date.now() + 15_000).toISOString(),
        {
          object_type: objectType,
          ...(authorConnected === undefined ? {} : { author_connected: authorConnected }),
          limit: 50
        }
      );
      const findTransport = wrapFindTransport({
        objectTransport: transport,
        signPacket: (unsignedPacket) => signString(localIdentity.privateKey, canonicalize(unsignedPacket))
      });
      const response = await new Promise<{ peerId: string; packet: FindResponsePacket }>((resolve, reject) => {
        let settled = false;
        let timeout = 0;
        const unsubscribe = transport.onPacket((sourcePeerId, responsePacket) => {
          if (settled || sourcePeerId !== peerId || responsePacket.type !== 'FIND_RESPONSE'
            || responsePacket.payload.requestId !== requestId) return;
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          resolve({ peerId: sourcePeerId, packet: responsePacket as FindResponsePacket });
        });
        timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          reject(new Error(`FIND request ${requestId} timed out at ${peerId}`));
        }, 15_000);
        void findTransport.send(peerId, packet).catch((error: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          reject(error);
        });
      });
      const candidates = Array.isArray(response.packet.payload.objects)
        ? response.packet.payload.objects
        : response.packet.payload.object ? [response.packet.payload.object] : [];
      return {
        responderPeerId: response.peerId,
        requestId,
        authors: candidates.map((object) => object.author)
      };
    };
    window.__MYCELIUM_E2E__ = {
      state: () => ({
        identityId: identityRef.current?.id ?? '',
        connectedPeers: objectTransportRef.current?.connectedPeers() ?? [],
        signallingStatus: signallingStatusRef.current,
        followingPeerIds: contactsRef.current.filter((contact) => contact.followed).map((contact) => contact.fingerprint),
        contacts: contactsRef.current.map((contact) => ({
          peerId: contact.fingerprint,
          followed: contact.followed,
          follower: contact.follower === true
        })),
        logs: logsRef.current.map((entry) => entry.text)
      }),
      connectPeer: async (peerId) => {
        const socket = signallingSocketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Signalling is not connected');
        const manager = ensurePeerManager(peerId);
        if (!manager) throw new Error(`Could not create peer manager for ${peerId}`);
        requestPeerOffer(peerId, manager, socket, true);
      },
      disconnectPeer: (peerId) => closeAndRemoveAuthenticatedPeerManager(peerId),
      sendAuthenticatedProfile: async (peerId) => {
        const manager = peerManagersRef.current[peerId];
        if (!manager?.isDataChannelOpen()) throw new Error(`Peer ${peerId} is not connected`);
        await sendPeerMetadata(manager, peerId);
      },
      discoverConnectedPeerProfiles: async () => {
        const discoveredPeerIds = await discoverConnectedPeerProfiles();
        return {
          discoveredPeerIds,
          connectedPeerIds: objectTransportRef.current?.connectedPeers() ?? [],
          activeAttemptPeerIds: [...activePeerAttemptsRef.current]
        };
      },
      followPeer: async (peerId, followed) => {
        const contact = contactsRef.current.find((candidate) => (
          candidate.fingerprint === peerId || candidate.publicKey === peerId
        ));
        if (Boolean(contact?.followed) !== followed) await handleToggleFollow(peerId);
      },
      identityProfiles: async () => {
        const store = objectStoreRef.current;
        if (!store) throw new Error('Object store is not ready');
        return Promise.all((await getLatestIdentityObjects(store)).map(async (profile) => ({
          peerId: await deriveFingerprint(profile.author),
          author: profile.author,
          objectId: profile.object_id
        })));
      },
      findIdentityProfiles: (peerId, authorConnected, ttl = 1) =>
        findObjectsByQuery(peerId, IDENTITY_OBJECT_TYPE, authorConnected, ttl),
      findObjectsByQuery,
      findObject: async (objectId, peerId) => {
        const localIdentity = identityRef.current;
        const store = objectStoreRef.current;
        const transport = objectTransportRef.current;
        if (!localIdentity || !store || !transport) throw new Error('Object transport is not ready');
        let requestId = '';
        const found = await findObject(
          localIdentity.id,
          peerId,
          objectId,
          transport,
          store,
          2,
          undefined,
          (supplierPeerId, object) => observeValidatedObjectSupply(supplierPeerId, object, addLog),
          (startedRequestId) => { requestId = startedRequestId; }
        );
        return found
          ? { found: true, objectId: found.object_id, requestId }
          : { found: false, requestId };
      },
      createLocalTestPost: async (content) => {
        const localIdentity = identityRef.current;
        const store = objectStoreRef.current;
        if (!localIdentity || !store) throw new Error('Identity or object store is not ready');
        const object = await createSignedObject({
          object_type: 'mycelium.post',
          created_at: new Date().toISOString(),
          payload: createPostObjectPayload(content, []),
          replication_policy: {}
        }, createObjectIdentity(localIdentity)) as PostObject;
        await store.put(object);
        return object.object_id;
      },
      objectIdForPost: async (content) => {
        const objects = await objectStoreRef.current?.query();
        return objects?.find((object) => {
          if (object.object_type !== 'mycelium.post' || !object.payload
            || typeof object.payload !== 'object' || Array.isArray(object.payload)) return false;
          return object.payload.content === content;
        })?.object_id ?? null;
      },
      deleteObject: async (objectId) => {
        const store = objectStoreRef.current;
        if (!store) throw new Error('Object store is not ready');
        await store.delete(objectId);
      },
      sendObject: async (objectId, peerId) => {
        const localIdentity = identityRef.current;
        const store = objectStoreRef.current;
        const transport = objectTransportRef.current;
        if (!localIdentity || !store || !transport) throw new Error('Object transport is not ready');
        const object = await store.get(objectId);
        if (!object) throw new Error(`Object ${objectId} is not stored locally`);
        const signer: PacketSigner = (packet) => signString(localIdentity.privateKey, canonicalize(packet));
        await transport.send(peerId, await buildObjectStorePacket(localIdentity.id, peerId, object, signer));
      },
      sendInvalidObject: async (objectId, peerId) => {
        const localIdentity = identityRef.current;
        const store = objectStoreRef.current;
        const transport = objectTransportRef.current;
        if (!localIdentity || !store || !transport) throw new Error('Object transport is not ready');
        const object = await store.get(objectId);
        if (!object) throw new Error(`Object ${objectId} is not stored locally`);
        const signer: PacketSigner = (packet) => signString(localIdentity.privateKey, canonicalize(packet));
        const packet = await buildObjectStorePacket(localIdentity.id, peerId, {
          ...object,
          signature: `${object.signature}invalid`
        }, signer);
        await transport.send(peerId, packet);
      }
    };
    return () => {
      delete window.__MYCELIUM_E2E__;
    };
  }, [identity?.id]);

  function createIdentityBackupPayload(identityRecord: IdentityRecord) {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      identity: identityBackupFields(identityRecord),
      profile: {
        displayName: myProfile.displayName.trim() || fingerprintToHumanName(identityRecord.id),
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
        lastReadAt: contact.lastReadAt,
        profile: contact.profile
          ? {
              ...contact.profile,
              displayName: contact.profile.displayName?.trim() || undefined,
              bio: contact.profile.bio?.trim() || undefined
            }
          : undefined
      }))
    };
  }

  async function handleImportIdentity(file: File, passphrase: string) {
    try {
      let imported = JSON.parse(await file.text());
      if (imported?.format === 'mycelium-encrypted-identity-backup') {
        try {
          imported = await decryptJsonPayload(imported.encryptedPayload as VaultBlob, passphrase);
        } catch {
          throw new Error('Unable to unlock the encrypted backup. Check the passphrase or backup file.');
        }
      }
      const importedIdentity = imported?.identity ?? imported;

      if (importedIdentity?.publicKey && importedIdentity?.privateKey && importedIdentity?.id) {
        await ensureTurnIceServers();
        const nextIdentity = await ensureIdentityEncryptionKeyPair({
            key: importedIdentity.key ?? 'local',
            publicKey: importedIdentity.publicKey,
            privateKey: importedIdentity.privateKey,
            id: importedIdentity.id,
            encryptionPublicKey: typeof importedIdentity.encryptionPublicKey === 'string' ? importedIdentity.encryptionPublicKey : undefined,
            encryptionPrivateKey: typeof importedIdentity.encryptionPrivateKey === 'string' ? importedIdentity.encryptionPrivateKey : undefined
          });

          await saveIdentity(nextIdentity);
          setIdentity(nextIdentity as IdentityRecord);

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
          await publishLocalIdentityProfile({
            ...nextIdentity,
            id: typeof nextIdentity.id === 'string' ? nextIdentity.id : await deriveFingerprint(nextIdentity.publicKey)
          }, nextProfile);

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
                lastReadAt: typeof contact.lastReadAt === 'string' && Number.isFinite(Date.parse(contact.lastReadAt))
                  ? contact.lastReadAt
                  : undefined,
              })).filter((contact: Contact) => Boolean(contact.fingerprint && contact.publicKey))
            : [];

          const restoredContacts = dedupeContactsByFingerprint(importedContacts);
          setContacts(restoredContacts);
          await Promise.all(restoredContacts.map(async (contact) => saveContact(contact)));

        addLog('Identity imported successfully');
      } else {
        throw new Error('Invalid identity backup file format.');
      }
    } catch (error) {
      addLog(`Identity import failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
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
    setIdentity(null);
    dmServiceRef.current = null;
    if (dmOutboxIntervalRef.current !== null) {
      window.clearInterval(dmOutboxIntervalRef.current);
      dmOutboxIntervalRef.current = null;
    }
    setContacts([]);
    setPostViews([]);
    setDiscoveryPosts([]);
    setSelectedContactId(null);
    setChatContactId(null);
    setActivePeerId(null);
    setConnectionStatus('idle');
    setSignallingStatus('idle');
    commitNavigation({
      page: 'home',
      conversationPostId: null,
      focusedReplyId: null,
      profileContactId: null,
      relationshipOwnerId: null,
      relationshipTab: 'following',
      chatContactId: null,
      scrollTop: 0,
      conversationReturnScrollTop: null
    }, 'replace');
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
    const knownContact = contactsRef.current.find((contact) => (
      contact.fingerprint === peerId || contact.publicKey === peerId
    ));
    const chatId = knownContact?.fingerprint ?? peerId;
    setSelectedContactId(chatId);
    const current = currentNavigationState();
    commitNavigation({
      ...current,
      page: 'chat',
      conversationPostId: null,
      focusedReplyId: null,
      profileContactId: null,
      relationshipOwnerId: null,
      chatContactId: chatId,
      scrollTop: pageScrollPositions.chat ?? 0,
      conversationReturnScrollTop: null
    });
    addLog(`Selected contact ${chatId}`);
    const socket = signallingSocketRef.current;
    const manager = ensurePeerManager(chatId);
    const targetContact = knownContact;
    if (socket && socket.readyState === WebSocket.OPEN && manager && !targetContact?.connected) {
      requestPeerOffer(chatId, manager, socket);
      addLog(`Opening encrypted conversation and connecting to ${chatId}`);
    }
  }

  async function handleOpenPeerProfile(peerId: string) {
    if (!peerId) return;

    if (peerId === identity?.id) {
      const current = currentNavigationState();
      commitNavigation({
        ...current,
        page: 'myProfile',
        conversationPostId: null,
        focusedReplyId: null,
        profileContactId: null,
        relationshipOwnerId: null,
        chatContactId: null,
        scrollTop: pageScrollPositions.myProfile ?? 0,
        conversationReturnScrollTop: null
      });
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
      };
      await saveContact(resolvedContact);
      setContacts((prev) => dedupeContactsByFingerprint([...prev, resolvedContact!]));
    }

    const cachedProfile = await loadProfile(peerId);
    if (cachedProfile && !resolvedContact.profile && !resolvedContact.identityObject) {
      resolvedContact = { ...resolvedContact, displayName: cachedProfile.displayName ?? resolvedContact.displayName, profile: cachedProfile };
      await saveContact(resolvedContact);
      setContacts((prev) => prev.map((item) => (item.fingerprint === peerId ? resolvedContact! : item)));
    }

    const current = currentNavigationState();
    commitNavigation({
      ...current,
      page: 'profile',
      conversationPostId: null,
      focusedReplyId: null,
      profileContactId: peerId,
      relationshipOwnerId: null,
      chatContactId: null,
      scrollTop: pageScrollPositions.profile ?? 0,
      conversationReturnScrollTop: null
    });
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
      if (manager.isDataChannelOpen()) void syncFeedPeer(peerId);
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
    if (!identity || !contactsLoaded || addPeerInviteHandledRef.current) return;
    addPeerInviteHandledRef.current = true;

    const invite = parseAddPeerInvitePath(window.location.pathname);
    if (!invite) return;
    if (!invite.peerId) {
      addLog(`Invalid follow link for peer "${invite.handle}".`);
      window.history.replaceState(window.history.state, '', '/');
      return;
    }
    if (blockedPeersRef.current.has(invite.peerId)) {
      addLog(`Refusing follow link for blocked peer ${invite.peerId}.`);
      window.history.replaceState(window.history.state, '', '/');
      return;
    }

    void handleOpenPeerProfile(invite.peerId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      addLog(`Could not open profile from follow link ${invite.handle}: ${message}`);
      window.history.replaceState(window.history.state, '', '/');
    });
  }, [identity, contactsLoaded]);

  useEffect(() => {
    const handleShutdown = () => {
      Object.values(peerManagersRef.current).forEach((manager) => manager.closeConnection());
    };

    window.addEventListener('beforeunload', handleShutdown);
    window.addEventListener('pagehide', handleShutdown);

    return () => {
      window.removeEventListener('beforeunload', handleShutdown);
      window.removeEventListener('pagehide', handleShutdown);
      handleShutdown();
    };
  }, []);

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
      const found = await findObject(
        identity.id,
        peerId,
        objectId,
        transport,
        store,
        2,
        (request) => handleAcceptedDeleteRequest(request, false),
        (supplierPeerId, object) => observeValidatedObjectSupply(supplierPeerId, object, addLog)
      );
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
      const found = await findObject(
        identity.id,
        peerId,
        missingObjectId,
        transport,
        store,
        2,
        (request) => handleAcceptedDeleteRequest(request, false),
        (supplierPeerId, object) => observeValidatedObjectSupply(supplierPeerId, object, addLog)
      );
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
      const found = await findObject(
        identity.id,
        objectTestPeerId,
        objectId,
        transport,
        store,
        2,
        (request) => handleAcceptedDeleteRequest(request, false),
        (supplierPeerId, object) => observeValidatedObjectSupply(supplierPeerId, object, addLog)
      );
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
      const found = await findObjects(
        identity.id,
        objectTestPeerId,
        objectIds,
        transport,
        store,
        2,
        1000,
        (request) => handleAcceptedDeleteRequest(request, false)
      );
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
  const activeChatContact = chatContactId
    ? contacts.find((contact) => contact.fingerprint === chatContactId || contact.publicKey === chatContactId)
      ?? {
        publicKey: chatContactId,
        fingerprint: chatContactId,
        addedAt: '',
        followed: false
      }
    : undefined;
  const getDmIdentity = useCallback(() => identity ? ({
    id: identity.id,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    encryptionPrivateKey: identity.encryptionPrivateKey
  }) : null, [identity]);
  const resolveDmSenderEncryptionKey = useCallback((publicKey: string) => {
    const contact = contactsRef.current.find((candidate) => candidate.publicKey === publicKey);
    return contact ? getContactEncryptionKey(contact) : null;
  }, []);
  const isDmContactKnown = useCallback((publicKey: string) => (
    contactsRef.current.some((contact) => contact.publicKey === publicKey)
  ), []);

  useEffect(() => {
    if (!identity || page !== 'messages' || !objectStoreRef.current) {
      setConversationListLoading(false);
      return;
    }

    let active = true;
    let requestRevision = 0;
    const store = objectStoreRef.current;
    const myPublicKey = identity.publicKey;
    const refresh = async () => {
      const revision = ++requestRevision;
      setConversationListLoading(true);
      try {
        const summaries = await listConversations({ store, myPublicKey });
        if (!active || revision !== requestRevision) return;
        setConversationSummaries(summaries);
        setConversationPreviews({});
        setConversationListError(null);
        setConversationPreviewError(null);

        const dmIdentity = getDmIdentity();
        const outbox = outboxStoreRef.current;
        if (!dmIdentity || !outbox) {
          setConversationPreviewError('Message previews are unavailable for this identity.');
          return;
        }

        const previewResults = await Promise.all(summaries.map(async (summary) => {
          try {
            const message = await previewConversation({
              store,
              identity: dmIdentity,
              counterparty: summary.counterparty,
              resolveSenderEncryptionKey: resolveDmSenderEncryptionKey,
              getOutboxEntry: (objectId) => outbox.get(objectId)
            });
            return {
              counterparty: summary.counterparty,
              text: message?.deleted
                ? '[Deleted message]'
                : message?.status === 'ok' ? message.text : null,
              error: null as string | null
            };
          } catch (error) {
            return {
              counterparty: summary.counterparty,
              text: null,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }));
        if (!active || revision !== requestRevision) return;
        setConversationPreviews(Object.fromEntries(
          previewResults.flatMap((result) => result.text === null
            ? []
            : [[result.counterparty, result.text] as const])
        ));
        const failedPreview = previewResults.find((result) => result.error !== null);
        setConversationPreviewError(failedPreview
          ? `Could not load a message preview for ${failedPreview.counterparty}: ${failedPreview.error}`
          : null);
      } catch (error) {
        if (!active || revision !== requestRevision) return;
        setConversationListError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active && revision === requestRevision) setConversationListLoading(false);
      }
    };

    void refresh();
    const unsubscribe = dmEventsRef.current.onDmArrived((object) => {
      if (object.object_type === 'mycelium.dm' && object.recipient === myPublicKey) void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [identity?.publicKey, page, navigationRevision]);

  if (!identity) {
    return (
      <LandingPage
        onCreateIdentity={handleCreateIdentity}
        onImportIdentity={handleImportIdentity}
      />
    );
  }

  return (
    <DmUnreadProvider
      store={objectStoreRef.current}
      myPublicKey={identity.publicKey}
      contacts={contacts}
      events={dmEventsRef.current}
      saveContact={saveContact}
      updateContact={(updatedContact) => {
        const nextContacts = contactsRef.current.map((contact) => (
          contact.publicKey === updatedContact.publicKey ? updatedContact : contact
        ));
        contactsRef.current = nextContacts;
        setContacts((previous) => previous.map((contact) => (
          contact.publicKey === updatedContact.publicKey ? updatedContact : contact
        )));
      }}
    >
    <ExternalImageLimitContext.Provider value={externalImageLimitMb}>
    <div className="app-shell">
      <aside className="app-sidebar">
        <TabBar
          active={
            page === 'relationships'
              ? 'myProfile'
              : page === 'chat'
                ? 'messages'
                : page === 'messages' || page === 'discover' || page === 'myProfile' || page === 'settings'
              ? page
              : 'home'
          }
          onChange={handlePageChange}
          replyUnreadCount={replyUnread.unreadCount}
        />
      </aside>

      <div className="app-main-column">
        <AppHeader
          collapsed={collapsedHeader}
          onToggleCollapse={handleToggleHeader}
          connectionStatus={connectionStatus}
          signallingStatus={signallingStatus}
          connectedPeers={connectedPeersCount}
          connectedPeerIds={connectedPeerIds}
          contacts={contacts}
          syncStatus={syncStatus}
          myFingerprint={identity?.id}
          onPeerProfileClick={handleOpenPeerProfile}
          onHomeClick={() => handlePageChange('home')}
        />

        <main id="page-content" className={`page-content${page === 'chat' ? ' chat-active' : ''}`}>
        {conversationPostId ? (
          activeConversationPost ? (
            <ConversationPage
              post={activeConversationPost}
              posts={visibleConversationPosts}
              replyCounts={locallyKnownReplyCounts}
              contacts={contacts}
              myPeerId={identity.id}
              myPublicKey={identity.publicKey}
              focusedPostId={conversationFocusPostId}
              deletionTombstones={deletionTombstones}
              ancestry={conversationAncestry?.postId === conversationPostId
                ? conversationAncestry
                : { postId: conversationPostId, loading: true }}
              onLeave={handleLeaveConversation}
              onOpenPost={handleOpenConversation}
              onOpenParent={handleOpenParentConversation}
              onAuthorClick={handleOpenPeerProfile}
              onLike={handleLikePost}
              onDislike={handleDislikePost}
              onHide={page === 'discover' ? handleHideDiscoveryPost : handleHidePost}
              onDelete={handleDeletePost}
              onReply={(postId, content, publishToDiscovery) => {
                if (content && content.trim()) {
                  void handleCreatePost(Boolean(publishToDiscovery), postId, content);
                }
              }}
              publishToDiscovery={publishToDiscovery}
              getRecommendationSummary={getRecommendationSummary}
            />
          ) : (
            <section className="page-view conversation-page">
              <header className="conversation-header">
                <button className="btn secondary conversation-back" type="button" onClick={handleLeaveConversation} aria-label="Return to previous view">
                  <span aria-hidden="true">←</span>
                  <span>Return</span>
                </button>
                <h2>Post</h2>
              </header>
              <p className="note">This post is no longer available in the posts loaded on this device.</p>
            </section>
          )
        ) : (
          <>
        {page === 'home' && (
          <HomePage
            posts={visibleHomePosts}
            onDiagnosticLog={addLog}
            replyCounts={locallyKnownReplyCounts}
            contacts={contacts}
            mentionContacts={visibleContacts}
            myPublicKey={identity.publicKey}
            contactsLoaded={contactsLoaded}
            popularPeers={popularPeers}
            onFollowPeer={(peerId) => { void handleToggleFollow(peerId); }}
            postText={newPostContent}
            onPostTextChange={setNewPostContent}
            onSubmitPost={(publishToDiscovery, mentions) => {
              void handleCreatePost(publishToDiscovery, undefined, undefined, mentions);
            }}
            publishToDiscovery={publishToDiscovery}
            canCreatePost={Boolean(identity)}
            onAuthorClick={handleOpenPeerProfile}
            myPeerId={identity.id}
            myDisplayName={myProfile.displayName}
            onOpenPost={handleOpenConversation}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onReply={(postId, content, publishToDiscovery) => {
              if (content && content.trim()) {
                void handleCreatePost(Boolean(publishToDiscovery), postId, content);
              }
            }}
            onHide={handleHidePost}
            onDelete={handleDeletePost}
          />
        )}

        {page === 'messages' && (
          <MessagesPage
            contacts={visibleContacts}
            myPublicKey={identity.publicKey}
            myPeerId={identity.id}
            conversations={conversationSummaries}
            previews={conversationPreviews}
            loading={conversationListLoading}
            error={conversationListError}
            previewError={conversationPreviewError}
            onOpenChat={handleSelectContact}
            onViewProfile={handleOpenPeerProfile}
            replies={replyUnread.replies}
            onOpenReply={(parentPostId, replyPostId) => handleOpenConversation(
              parentPostId,
              replyPostId && allCachedPosts.some((post) => post.object.object_id === replyPostId)
                ? replyPostId
                : undefined
            )}
            onMarkReplyRead={replyUnread.markRead}
            onMarkAllRepliesRead={replyUnread.markAllRead}
          />
        )}

        {page === 'relationships' && relationshipOwnerId && (
          <RelationshipsPage
            ownerId={relationshipOwnerId}
            myPeerId={identity.id}
            initialTab={relationshipTab}
            contacts={visibleContacts}
            onTabChange={handleRelationshipTabChange}
            onViewProfile={handleOpenPeerProfile}
            onToggleFollow={handleToggleFollow}
          />
        )}

        {page === 'discover' && (
          <DiscoverPage
            discoveryPosts={discoverFeedPosts}
            replyCounts={locallyKnownReplyCounts}
            contacts={visibleContacts}
            suggestedPeerIds={possiblePeerIds}
            popularPeers={popularPeers}
            myPeerId={identity.id}
            myPublicKey={identity.publicKey}
            myDisplayName={myProfile.displayName}
            onAuthorClick={handleOpenPeerProfile}
            onOpenPost={handleOpenConversation}
            onFollow={handleToggleFollow}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onHide={handleHideDiscoveryPost}
            onDelete={handleDeletePost}
            onBlock={handleBlockPeer}
            getRecommendationSummary={getRecommendationSummary}
          />
        )}

        {page === 'profile' && activeProfileContact && (
          <ProfilePage
            contact={activeProfileContact}
            posts={profilePosts}
            likedPosts={likedProfilePosts}
            contacts={visibleContacts}
            replyCounts={locallyKnownReplyCounts}
            myPeerId={identity.id}
            onOpenRelationships={(tab) => handleOpenRelationships(activeProfileContact.fingerprint, tab)}
            notice={profileNotice}
            onFollowToggle={() => handleToggleFollow(activeProfileContact.publicKey)}
            onBlock={() => handleBlockPeer(activeProfileContact.fingerprint)}
            onMessage={() => handleSelectContact(activeProfileContact.fingerprint)}
            onAuthorClick={handleOpenPeerProfile}
            onOpenPost={handleOpenConversation}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onHide={handleHidePost}
            onDelete={handleDeletePost}
            getRecommendationSummary={getRecommendationSummary}
          />
        )}

        {page === 'myProfile' && myProfileContact && (
          <ProfilePage
            contact={myProfileContact}
            posts={postViews.filter((post) => (post.authorFingerprint === identity?.id || post.object.author === identity?.publicKey) && !isHiddenPost(post)).sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime())}
            likedPosts={postViews.filter((post) => getRecommendationSummary(post.object.object_id).recommended_by_me && post.object.author !== identity?.publicKey && !isHiddenPost(post)).sort((a, b) => new Date(b.object.created_at).getTime() - new Date(a.object.created_at).getTime())}
            contacts={visibleContacts}
            replyCounts={locallyKnownReplyCounts}
            followingCount={visibleContacts.filter((contact) => contact.followed).length}
            followerCount={visibleContacts.filter((contact) => contact.follower).length}
            onOpenRelationships={(tab) => handleOpenRelationships(identity.id, tab)}
            onAuthorClick={handleOpenPeerProfile}
            onLike={handleLikePost}
            onDislike={handleDislikePost}
            onHide={handleHidePost}
            onDelete={handleDeletePost}
            onOpenPost={handleOpenConversation}
            getRecommendationSummary={getRecommendationSummary}
            isOwnProfile
            profileSettingsOpen={profileSettingsOpen}
            onToggleProfileSettings={() => setProfileSettingsOpen((prev) => !prev)}
            profileSettings={
              <div className="card profile-edit-card">
                <div className="profile-display-field">
                  <span>Generated handle</span>
                  <span className="monospace break-word">@{fingerprintToHumanName(identity.id)}</span>
                </div>
                <label>
                  Display Name
                  <input
                    value={myProfile.displayName}
                    onChange={(e) => setMyProfile((prev) => ({ ...prev, displayName: e.target.value }))}
                    placeholder="Optional"
                  />
                </label>
                <label>
                  Bio
                  <textarea value={myProfile.bio} onChange={(e) => setMyProfile((prev) => ({ ...prev, bio: e.target.value }))} placeholder="Write a short bio" />
                </label>
                <div className="row">
                  <button className="btn" onClick={() => {
                    const nextDisplayName = myProfile.displayName.trim();

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
                    if (identity) {
                      void publishLocalIdentityProfile(identity, persistedProfile)
                        .catch((error: unknown) => addLog(`Failed to publish signed profile: ${error instanceof Error ? error.message : String(error)}`));
                    }
                    contacts.forEach((contact) => {
                      if (!contact.connected) return;
                      const manager = peerManagersRef.current[contact.fingerprint];
                      if (manager) {
                        void sendPeerMetadata(manager, contact.fingerprint)
                          .catch((error: unknown) => addLog(`Failed to send profile to ${contact.fingerprint}: ${error instanceof Error ? error.message : String(error)}`));
                      }
                    });
                  }}>Save Profile</button>
                </div>
                <div className="blocked-peers-settings">
                  <CollapsibleSection
                    title="Blocked Peers"
                    summary={`${myProfile.blockedPeers.length}`}
                    isOpen={blockedPeersOpen}
                    onToggle={() => setBlockedPeersOpen((open) => !open)}
                  >
                    <BlockedPeerList
                      peerIds={myProfile.blockedPeers}
                      onUnblock={handleUnblockPeer}
                      onViewProfile={handleOpenPeerProfile}
                    />
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

        {page === 'chat' && activeChatContact && identity && objectStoreRef.current && outboxStoreRef.current && (
          <DmChatPage
            contact={activeChatContact}
            counterparty={activeChatContact.publicKey}
            getIdentity={getDmIdentity}
            store={objectStoreRef.current}
            outbox={outboxStoreRef.current}
            resolveSenderEncryptionKey={resolveDmSenderEncryptionKey}
            dmService={dmServiceRef.current}
            events={dmEventsRef.current}
            isContactKnown={isDmContactKnown}
            connectionText={activeChatContact.connected ? 'Connected' : activeChatContact.online ? 'Online' : 'Offline'}
            myPeerId={identity.id}
            onViewProfile={handleOpenPeerProfile}
            onBackToMessages={handleBackToMessages}
            onDeleteMessage={handleDeleteMessage}
          />
        )}

        {page === 'settings' && (
          <SettingsPage
            identityId={identity?.id ?? ''}
            publicKey={identity?.publicKey ?? ''}
            logs={logs}
            onClearLogs={() => setLogs([])}
            signalEndpoint={signalEndpoint}
            discoveryEndpoint={discoveryEndpoint}
            connectionStatus={connectionStatus}
            signallingStatus={signallingStatus}
            connectedPeers={connectedPeersCount}
            syncStatus={syncStatus}
            recommendationFrequency={homeFeedInjectionFrequencies.recommendation}
            discoveryFrequency={homeFeedInjectionFrequencies.discovery}
            onSaveInjectionFrequencies={handleSaveInjectionFrequencies}
            publishToDiscovery={publishToDiscovery}
            onSavePublishToDiscovery={handleSavePublishToDiscovery}
            objectStorageLimitMb={objectStorageLimitMb}
            objectStorageUsedBytes={objectStorageUsedBytes}
            onSaveObjectStorageLimit={handleSaveObjectStorageLimit}
            externalImageLimitMb={externalImageLimitMb}
            onSaveExternalImageLimit={handleSaveExternalImageLimit}
            webPushNotificationPreferences={webPushNotificationPreferences}
            onSaveWebPushNotificationPreference={handleSaveWebPushNotificationPreference}
            onWebPushChanged={refreshConnectedPeerProfiles}
            onExportIdentity={handleExportIdentity}
            onExportLocalObservations={handleExportLocalObservations}
            onImportIdentity={handleImportIdentity}
            onCreateIdentity={handleCreateIdentity}
            onClearIdentity={handleClearIdentity}
            onAddPeerAddress={handleAddPeerByAddress}
            onResetApp={() => {
              setHiddenPostIds(new Set());
              setHiddenDiscoveryIds(new Set());
              setCollapsedHeader(true);
              localStorage.removeItem('hiddenPosts');
              localStorage.removeItem('hiddenDiscovery');
            }}
          />
        )}
          </>
        )}
        </main>
      </div>
    </div>
    </ExternalImageLimitContext.Provider>
    </DmUnreadProvider>
  );
}

export default App;
