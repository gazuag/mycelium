import { describe, expect, it, vi } from 'vitest';
import type { DistributedObject, JsonValue } from '../object-layer/types';
import {
  classifyNewlyAcceptedObjectNotification,
  createPushWakeOutboxFlusher,
  DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES,
  DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES,
  parseWebPushNotificationPreferences,
  showWebPushNotificationOnce,
  updateWebPushNotificationPreference,
  WEB_PUSH_NOTIFICATION_DEDUPE_STORAGE_KEY
} from './web-push-notifications';

const LOCAL_ID = 'local-peer';
const LOCAL_KEY = 'local-signing-key';
const TARGET_ID = 'a'.repeat(64);
const REPLY_ID = 'b'.repeat(64);
const IDENTITY = {
  id: LOCAL_ID,
  publicKey: LOCAL_KEY,
  encryptionPublicKey: 'AQID'
};

function object(
  objectId: string,
  objectType: string,
  author: string,
  payload: JsonValue = {}
): DistributedObject {
  return {
    object_id: objectId,
    object_type: objectType,
    author,
    created_at: '2026-10-22T10:00:00.000Z',
    payload,
    signature: 'signature',
    replication_policy: {}
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values
  };
}

describe('Web Push notification preferences', () => {
  it('defaults each independent category to enabled and updates one category at a time', () => {
    expect(parseWebPushNotificationPreferences(null)).toEqual(DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES);
    for (const category of ['directMessages', 'replies', 'followedPosts'] as const) {
      const disabled = updateWebPushNotificationPreference(DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES, category, false);
      expect(disabled[category]).toBe(false);
      expect(Object.entries(disabled).filter(([key]) => key !== category).every(([, value]) => value === true)).toBe(true);
      const enabled = updateWebPushNotificationPreference(disabled, category, true);
      expect(enabled).toEqual(DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES);
    }
  });

  it('loads valid local preferences and safely defaults malformed fields', () => {
    expect(parseWebPushNotificationPreferences('{"directMessages":false,"replies":true,"followedPosts":false}'))
      .toEqual({ directMessages: false, replies: true, followedPosts: false });
    expect(parseWebPushNotificationPreferences('{"directMessages":false,"replies":"no"}'))
      .toEqual({ directMessages: false, replies: false, followedPosts: false });
    expect(parseWebPushNotificationPreferences('{')).toEqual(DISABLED_WEB_PUSH_NOTIFICATION_PREFERENCES);
  });
});

describe('classification of newly accepted objects', () => {
  const emptyStore = { get: vi.fn(async () => null) };
  const notTombstoned = vi.fn(async () => false);
  const options = {
    identity: IDENTITY,
    followedAuthorKeys: new Set(['followed-signing-key']),
    store: emptyStore,
    isTombstoned: notTombstoned,
    resolveSenderEncryptionKey: (author: string) => author === 'sender-key' ? 'AQID' : null
  };

  it('classifies only a valid, addressed direct message', async () => {
    const dm = {
      ...object('c'.repeat(64), 'mycelium.dm', 'sender-key', {
      v: 1,
      sender_enc_key: 'AQID',
      recipient_enc_key: IDENTITY.encryptionPublicKey,
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
      nonce: 'AAAAAAAAAAAAAAAA'
      }),
      recipient: LOCAL_KEY
    };
    await expect(classifyNewlyAcceptedObjectNotification(dm, options))
      .resolves.toEqual({ category: 'directMessages', dedupeId: dm.object_id });
    await expect(classifyNewlyAcceptedObjectNotification({ ...dm, recipient: 'someone-else' }, options))
      .resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification({
      ...dm,
      payload: { ...(dm.payload as object), recipient_enc_key: 'BAUG' }
    }, options)).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(dm, {
      ...options,
      resolveSenderEncryptionKey: () => null
    })).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification({ ...dm, author: LOCAL_KEY }, options))
      .resolves.toBeNull();
  });

  it('classifies a reply only when its verified target is a live local post', async () => {
    const target = object(TARGET_ID, 'mycelium.post', LOCAL_KEY);
    const reply = object(REPLY_ID, 'mycelium.post', 'reply-author', { reply_to: TARGET_ID });
    const store = { get: vi.fn(async (id: string) => id === TARGET_ID ? target : null) };
    const replyOptions = { ...options, store };

    await expect(classifyNewlyAcceptedObjectNotification(reply, replyOptions))
      .resolves.toEqual({ category: 'replies', dedupeId: REPLY_ID });
    await expect(classifyNewlyAcceptedObjectNotification(
      { ...reply, payload: { reply_to: 'not-an-object-id' } },
      replyOptions
    )).resolves.toBeNull();
    const deletedOptions = { ...replyOptions, isTombstoned: vi.fn(async (id: string) => id === TARGET_ID) };
    await expect(classifyNewlyAcceptedObjectNotification(reply, deletedOptions)).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(
      object(REPLY_ID, 'mycelium.post', 'reply-author', { reply_to: TARGET_ID }),
      { ...options, store: { get: vi.fn(async () => object(TARGET_ID, 'mycelium.post', 'other-key')) } }
    )).resolves.toBeNull();
  });

  it('uses the signed reply notice target while deduplicating against its canonical reply post', async () => {
    const target = object(TARGET_ID, 'mycelium.post', LOCAL_KEY);
    const replyNotice = object(REPLY_ID, 'mycelium.reply', 'reply-author', {
      reply_to: TARGET_ID,
      reply_to_author: LOCAL_ID,
      reply_post_id: 'd'.repeat(64)
    });
    await expect(classifyNewlyAcceptedObjectNotification(replyNotice, {
      ...options,
      store: { get: vi.fn(async () => target) }
    })).resolves.toEqual({ category: 'replies', dedupeId: 'd'.repeat(64) });
  });

  it('classifies followed-user posts and ignores self-authored, deleted, and unrelated objects', async () => {
    const post = object(REPLY_ID, 'mycelium.post', 'followed-signing-key');
    await expect(classifyNewlyAcceptedObjectNotification(post, options))
      .resolves.toEqual({ category: 'followedPosts', dedupeId: REPLY_ID });
    await expect(classifyNewlyAcceptedObjectNotification(
      { ...post, author: LOCAL_ID },
      options
    )).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(
      object(REPLY_ID, 'mycelium.delete-request', 'followed-signing-key'),
      options
    )).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(
      post,
      { ...options, isTombstoned: vi.fn(async () => true) }
    )).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(
      object(REPLY_ID, 'mycelium.post', 'unfollowed-signing-key'),
      options
    )).resolves.toBeNull();
  });
});

describe('notification display and outbox wake handling', () => {
  it('shows fixed privacy-conscious copy once for a canonical event', async () => {
    const storage = memoryStorage();
    const showNotification = vi.fn(async () => undefined);
    const registration = { showNotification };
    const first = await showWebPushNotificationOnce(registration, 'directMessages', REPLY_ID, storage);
    const duplicate = await showWebPushNotificationOnce(registration, 'directMessages', REPLY_ID, storage);

    expect(first).toBe(true);
    expect(duplicate).toBe(false);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith('New message', {
      body: 'You received a new direct message.',
      tag: `mycelium-${REPLY_ID}`
    });
    expect(storage.values.get(WEB_PUSH_NOTIFICATION_DEDUPE_STORAGE_KEY)).toContain(REPLY_ID);
    expect(await showWebPushNotificationOnce({}, 'replies', REPLY_ID, storage)).toBe(false);
  });

  it('coalesces concurrent notifications for the same canonical event', async () => {
    const storage = memoryStorage();
    let finishNotification!: () => void;
    const showNotification = vi.fn(() => new Promise<void>((resolve) => { finishNotification = resolve; }));
    const registration = { showNotification };
    const first = showWebPushNotificationOnce(registration, 'replies', REPLY_ID, storage);
    const concurrent = showWebPushNotificationOnce(registration, 'replies', REPLY_ID, storage);

    expect(await concurrent).toBe(false);
    expect(showNotification).toHaveBeenCalledOnce();
    finishNotification();
    expect(await first).toBe(true);
  });

  it('coalesces concurrent wake flushes and rate-limits completed attempts', async () => {
    let now = 1_000;
    let finishFlush!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    const requestFlush = createPushWakeOutboxFlusher(flush, () => now, 30_000);

    const first = requestFlush();
    const overlapping = requestFlush();
    expect(overlapping).toBe(first);
    expect(flush).toHaveBeenCalledTimes(1);
    finishFlush();
    await first;
    expect(requestFlush()).toBeNull();

    now += 30_000;
    const next = requestFlush();
    expect(next).toBeTruthy();
    expect(flush).toHaveBeenCalledTimes(2);
    finishFlush();
    await next;
  });

  it('allows a later bounded retry after an outbox flush failure', async () => {
    let now = 1_000;
    const flush = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ processed: 0, completed: 0 });
    const requestFlush = createPushWakeOutboxFlusher(flush, () => now, 30_000);

    await expect(requestFlush()).rejects.toThrow('temporary');
    expect(requestFlush()).toBeNull();
    now += 30_000;
    await expect(requestFlush()).resolves.toEqual({ processed: 0, completed: 0 });
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
