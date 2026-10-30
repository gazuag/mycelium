import { isObjectExpired } from '../object-layer/envelope';
import { DM_OBJECT_TYPE, type DmObjectIdentity } from '../object-layer/dm-object';
import { openDm } from '../object-layer/dm-inbox';
import type { DistributedObject, ObjectStore } from '../object-layer/types';

export const WEB_PUSH_NOTIFICATION_PREFERENCES_STORAGE_KEY = 'myceliumWebPushNotificationPreferences';
export const WEB_PUSH_NOTIFICATION_DEDUPE_STORAGE_KEY = 'myceliumWebPushNotifiedEvents';

export type WebPushNotificationCategory = 'directMessages' | 'replies' | 'followedPosts';

export interface WebPushNotificationPreferences {
  readonly directMessages: boolean;
  readonly replies: boolean;
  readonly followedPosts: boolean;
}

export type WebPushNotificationIdentity = DmObjectIdentity;

export interface ClassifiedWebPushNotification {
  readonly category: WebPushNotificationCategory;
  readonly dedupeId: string;
}

export interface DeferredWebPushNotification {
  readonly status: 'deferred';
}

export type WebPushNotificationClassification = ClassifiedWebPushNotification | DeferredWebPushNotification | null;

export const DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES: WebPushNotificationPreferences = {
  directMessages: true,
  replies: true,
  followedPosts: true
};

export const DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES: WebPushNotificationPreferences = {
  directMessages: false,
  replies: false,
  followedPosts: false
};

const NOTIFICATION_COPY: Record<WebPushNotificationCategory, { title: string; body: string }> = {
  directMessages: { title: 'New message', body: 'You received a new direct message.' },
  replies: { title: 'New reply', body: 'Someone replied to one of your posts.' },
  followedPosts: { title: 'New post', body: 'Someone you follow shared a new post.' }
};

const MAX_NOTIFICATION_DEDUPE_IDS = 500;
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const pendingNotificationKeys = new Set<string>();

export function parseWebPushNotificationPreferences(value: unknown): WebPushNotificationPreferences {
  if (value === null) return DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES;
  if (typeof value !== 'string') return DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES;
    return {
      directMessages: typeof parsed.directMessages === 'boolean'
        ? parsed.directMessages
        : false,
      replies: typeof parsed.replies === 'boolean'
        ? parsed.replies
        : false,
      followedPosts: typeof parsed.followedPosts === 'boolean'
        ? parsed.followedPosts
        : false
    };
  } catch {
    return DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES;
  }
}

export function updateWebPushNotificationPreference(
  preferences: WebPushNotificationPreferences,
  category: WebPushNotificationCategory,
  enabled: boolean
): WebPushNotificationPreferences {
  return { ...preferences, [category]: enabled };
}

export async function classifyNewlyAcceptedObjectNotification(
  object: DistributedObject,
  options: {
    readonly identity: WebPushNotificationIdentity;
    readonly followedAuthorKeys: ReadonlySet<string>;
    readonly store: Pick<ObjectStore, 'get'>;
    readonly isTombstoned: (objectId: string) => Promise<boolean>;
    readonly resolveSenderEncryptionKey: (author: string) => string | null;
  }
): Promise<WebPushNotificationClassification> {
  const { identity, followedAuthorKeys, store, isTombstoned, resolveSenderEncryptionKey } = options;
  if (isObjectExpired(object)
    || object.author === identity.id
    || object.author === identity.publicKey
    || await isTombstoned(object.object_id)) return null;

  if (object.object_type === DM_OBJECT_TYPE) {
    if (object.recipient !== identity.publicKey) return null;
    const opened = await openDm({
      object,
      identity,
      resolveSenderEncryptionKey
    });
    if (opened.status === 'ok') {
      return { category: 'directMessages', dedupeId: object.object_id };
    }
    return opened.status === 'unverified' || opened.status === 'unavailable'
      ? { status: 'deferred' }
      : null;
  }

  if (object.object_type !== 'mycelium.post') return null;
  const payload = isRecord(object.payload) ? object.payload : null;
  if (!payload) return null;

  const targetId = payload.reply_to;
  if (typeof targetId === 'string' && OBJECT_ID_PATTERN.test(targetId)) {
    const parent = await store.get(targetId);
    if (parent?.object_type === 'mycelium.post'
      && (parent.author === identity.id || parent.author === identity.publicKey)
      && !isObjectExpired(parent)
      && !(await isTombstoned(parent.object_id))) {
      return { category: 'replies', dedupeId: object.object_id };
    }
  }

  if (object.object_type === 'mycelium.post' && followedAuthorKeys.has(object.author)) {
    return { category: 'followedPosts', dedupeId: object.object_id };
  }
  return null;
}

export async function showWebPushNotificationOnce(
  registration: Partial<Pick<ServiceWorkerRegistration, 'showNotification'>>,
  category: WebPushNotificationCategory,
  dedupeId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'>
): Promise<boolean> {
  if (typeof registration.showNotification !== 'function') return false;
  const dedupeKey = dedupeId;
  if (pendingNotificationKeys.has(dedupeKey)) return false;
  let shownIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(WEB_PUSH_NOTIFICATION_DEDUPE_STORAGE_KEY) ?? '[]');
    if (Array.isArray(parsed)) {
      shownIds = parsed.filter((item): item is string => typeof item === 'string').slice(-MAX_NOTIFICATION_DEDUPE_IDS);
    }
  } catch {
    shownIds = [];
  }
  if (shownIds.includes(dedupeKey)) return false;

  const copy = NOTIFICATION_COPY[category];
  pendingNotificationKeys.add(dedupeKey);
  try {
    await registration.showNotification(copy.title, {
      body: copy.body,
      tag: `mycelium-${dedupeKey}`
    });
    try {
      storage.setItem(WEB_PUSH_NOTIFICATION_DEDUPE_STORAGE_KEY, JSON.stringify(
        [...shownIds.filter((item) => item !== dedupeKey), dedupeKey].slice(-MAX_NOTIFICATION_DEDUPE_IDS)
      ));
    } catch {
      // Notification display should not depend on optional local deduplication storage.
    }
    return true;
  } finally {
    pendingNotificationKeys.delete(dedupeKey);
  }
}

export function createPushWakeOutboxFlusher(
  flush: () => Promise<unknown>,
  now: () => number = Date.now,
  cooldownMs = 30_000
): () => Promise<unknown> | null {
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<unknown> | null = null;
  return () => {
    if (inFlight) return inFlight;
    if (now() - lastAttemptAt < cooldownMs) return null;
    lastAttemptAt = now();
    inFlight = flush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
