import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { exportEncryptionPrivateKey, exportEncryptionPublicKey, generateEncryptionKeyPair } from '../crypto/dm-crypto';
import { createSignedObject } from '../object-layer/envelope';
import { createObjectIdentity } from '../object-layer/identity';
import { createDmObject, type DmObjectIdentity } from '../object-layer/dm-object';
import type { ObjectContent } from '../object-layer/types';
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

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const LOCAL_ID = 'local-peer';
const LOCAL_KEY = 'local-signing-key';
const TARGET_ID = 'a'.repeat(64);
const REPLY_ID = 'b'.repeat(64);
const IDENTITY = {
  id: LOCAL_ID,
  publicKey: LOCAL_KEY,
  privateKey: 'unused-signing-private-key',
  encryptionPublicKey: 'AQID',
  encryptionPrivateKey: 'unavailable-encryption-private-key'
};

type TestIdentity = DmObjectIdentity & {
  privateKey: string;
  encryptionPrivateKey: string;
};

async function createIdentity(id: string): Promise<TestIdentity> {
  const signingKeys = await generateIdentityKeyPair();
  const encryptionKeys = await generateEncryptionKeyPair();
  return {
    id,
    publicKey: await exportPublicKey(signingKeys.publicKey),
    privateKey: await exportPrivateKey(signingKeys.privateKey),
    encryptionPublicKey: await exportEncryptionPublicKey(encryptionKeys.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(encryptionKeys.privateKey)
  };
}

async function createDm(sender: TestIdentity, recipient: TestIdentity): Promise<DistributedObject> {
  return createDmObject({
    identity: sender,
    recipientSigningKey: recipient.publicKey,
    recipientEncryptionKey: recipient.encryptionPublicKey,
    plaintext: 'private message text'
  });
}

async function resignDmWithPayload(
  dm: DistributedObject,
  sender: TestIdentity,
  payload: JsonValue
): Promise<DistributedObject> {
  const content: ObjectContent = {
    object_type: dm.object_type,
    recipient: dm.recipient,
    created_at: dm.created_at,
    ...(dm.expires_at === undefined ? {} : { expires_at: dm.expires_at }),
    payload,
    replication_policy: dm.replication_policy
  };
  return createSignedObject(content, createObjectIdentity(sender));
}

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

  it('classifies only a signed direct message with valid authenticated ciphertext', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const dm = await createDm(sender, recipient);
    const dmOptions = {
      ...options,
      identity: recipient,
      resolveSenderEncryptionKey: (author: string) => author === sender.publicKey ? sender.encryptionPublicKey : null
    };

    const classification = await classifyNewlyAcceptedObjectNotification(dm, dmOptions);
    expect(classification).toEqual({ category: 'directMessages', dedupeId: dm.object_id });
    if (classification && 'category' in classification) {
      const showNotification = vi.fn(async () => undefined);
      await showWebPushNotificationOnce(
        { showNotification },
        classification.category,
        classification.dedupeId,
        memoryStorage()
      );
      expect(showNotification).toHaveBeenCalledWith('New message', {
        body: 'You received a new direct message.',
        tag: `mycelium-${dm.object_id}`
      });
      expect(JSON.stringify(showNotification.mock.calls)).not.toContain('private message text');
    }
    await expect(classifyNewlyAcceptedObjectNotification({ ...dm, recipient: 'someone-else' }, dmOptions))
      .resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification({ ...dm, author: recipient.publicKey }, dmOptions))
      .resolves.toBeNull();

    const malformedCiphertext = Uint8Array.from(atob((dm.payload as { ciphertext: string }).ciphertext), (char) => char.charCodeAt(0));
    malformedCiphertext[0] ^= 0xff;
    const invalidDm = await resignDmWithPayload(dm, sender, {
      ...(dm.payload as object),
      ciphertext: btoa(String.fromCharCode(...malformedCiphertext))
    });
    await expect(classifyNewlyAcceptedObjectNotification(invalidDm, dmOptions)).resolves.toBeNull();
  });

  it('defers when local decryption material is unavailable and can classify after it is restored', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const dm = await createDm(sender, recipient);
    const dmOptions = {
      ...options,
      identity: { ...recipient, encryptionPrivateKey: 'temporarily-unavailable-private-key' },
      resolveSenderEncryptionKey: () => sender.encryptionPublicKey
    };

    await expect(classifyNewlyAcceptedObjectNotification(dm, dmOptions))
      .resolves.toEqual({ status: 'deferred' });
    await expect(classifyNewlyAcceptedObjectNotification(dm, {
      ...dmOptions,
      identity: recipient
    })).resolves.toEqual({ category: 'directMessages', dedupeId: dm.object_id });
  });

  it('defers until the trusted sender encryption key is available', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const dm = await createDm(sender, recipient);
    const dmOptions = { ...options, identity: recipient };
    let senderKey: string | null = null;
    const resolveSenderEncryptionKey = () => senderKey;

    await expect(classifyNewlyAcceptedObjectNotification(dm, {
      ...dmOptions,
      resolveSenderEncryptionKey
    })).resolves.toEqual({ status: 'deferred' });
    senderKey = sender.encryptionPublicKey;
    await expect(classifyNewlyAcceptedObjectNotification(dm, {
      ...dmOptions,
      resolveSenderEncryptionKey
    })).resolves.toEqual({ category: 'directMessages', dedupeId: dm.object_id });
  });

  it('classifies a reply only when its verified target is a live local post', async () => {
    const local = await createIdentity('local');
    const target = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-22T10:00:00.000Z',
      payload: { content: 'local parent' },
      replication_policy: {}
    }, createObjectIdentity(local));
    const reply = object(REPLY_ID, 'mycelium.post', 'reply-author', { reply_to: target.object_id });
    const store = { get: vi.fn(async (id: string) => id === target.object_id ? target : null) };
    const replyOptions = { ...options, identity: local, store };

    await expect(classifyNewlyAcceptedObjectNotification(reply, replyOptions))
      .resolves.toEqual({ category: 'replies', dedupeId: REPLY_ID });
    await expect(classifyNewlyAcceptedObjectNotification(
      { ...reply, payload: { reply_to: 'not-an-object-id' } },
      replyOptions
    )).resolves.toBeNull();
    const deletedOptions = {
      ...replyOptions,
      isTombstoned: vi.fn(async (id: string) => id === target.object_id)
    };
    await expect(classifyNewlyAcceptedObjectNotification(reply, deletedOptions)).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(
      object(REPLY_ID, 'mycelium.post', 'reply-author', { reply_to: target.object_id }),
      { ...replyOptions, store: { get: vi.fn(async () => object(target.object_id, 'mycelium.post', 'other-key')) } }
    )).resolves.toBeNull();
  });

  it('does not classify a reply with a missing parent as a followed-author post', async () => {
    const reply = object(REPLY_ID, 'mycelium.post', 'followed-signing-key', { reply_to: TARGET_ID });

    await expect(classifyNewlyAcceptedObjectNotification(reply, options)).resolves.toBeNull();
  });

  it('does not classify a reply with an invalid, mismatched, expired, or unverifiable parent as followed', async () => {
    const local = await createIdentity('local');
    const other = await createIdentity('other');
    const parent = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-22T10:00:00.000Z',
      payload: { content: 'local parent' },
      replication_policy: {}
    }, createObjectIdentity(local));
    const reply = object(REPLY_ID, 'mycelium.post', 'followed-signing-key', { reply_to: parent.object_id });
    const replyOptions = { ...options, identity: local };

    const cases: Array<{
      readonly name: string;
      readonly getParent: () => Promise<DistributedObject | null>;
    }> = [
      { name: 'invalid signature', getParent: async () => ({ ...parent, signature: 'invalid' }) },
      { name: 'mismatched object ID', getParent: async () => ({ ...parent, object_id: TARGET_ID }) },
      {
        name: 'expired parent',
        getParent: async () => createSignedObject({
          object_type: 'mycelium.post',
          created_at: '2026-10-22T10:00:00.000Z',
          expires_at: '2020-01-01T00:00:00.000Z',
          payload: { content: 'expired parent' },
          replication_policy: {}
        }, createObjectIdentity(local))
      }
    ];

    for (const testCase of cases) {
      const classification = await classifyNewlyAcceptedObjectNotification(reply, {
        ...replyOptions,
        store: { get: vi.fn(testCase.getParent) }
      });
      expect(classification, testCase.name).toBeNull();
    }

    const otherParent = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-22T10:00:00.000Z',
      payload: { content: 'other author parent' },
      replication_policy: {}
    }, createObjectIdentity(other));
    const replyToOtherAuthor = object(REPLY_ID, 'mycelium.post', 'followed-signing-key', {
      reply_to: otherParent.object_id
    });
    await expect(classifyNewlyAcceptedObjectNotification(replyToOtherAuthor, {
      ...replyOptions,
      store: { get: vi.fn(async () => otherParent) }
    })).resolves.toBeNull();

    await expect(classifyNewlyAcceptedObjectNotification(
      { ...reply, payload: { reply_to: null } },
      replyOptions
    )).resolves.toBeNull();
  });

  it('ignores reply notices without trusting their claimed canonical reply post', async () => {
    const target = object(TARGET_ID, 'mycelium.post', LOCAL_KEY);
    const replyNotice = object(REPLY_ID, 'mycelium.reply', 'reply-author', {
      reply_to: TARGET_ID,
      reply_to_author: LOCAL_ID,
      reply_post_id: 'd'.repeat(64)
    });
    await expect(classifyNewlyAcceptedObjectNotification(replyNotice, {
      ...options,
      store: { get: vi.fn(async () => target) }
    })).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(replyNotice, options)).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification({
      ...replyNotice,
      payload: { reply_to: 'c'.repeat(64), reply_to_author: LOCAL_ID, reply_post_id: REPLY_ID }
    }, {
      ...options,
      store: { get: vi.fn(async () => target) }
    })).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification({
      ...replyNotice,
      payload: { reply_to: TARGET_ID, reply_to_author: 'someone-else', reply_post_id: REPLY_ID }
    }, {
      ...options,
      store: { get: vi.fn(async () => target) }
    })).resolves.toBeNull();
  });

  it('notifies once for the canonical reply post after ignoring duplicate or fabricated notices', async () => {
    const local = await createIdentity('local');
    const target = await createSignedObject({
      object_type: 'mycelium.post',
      created_at: '2026-10-22T10:00:00.000Z',
      payload: { content: 'local parent' },
      replication_policy: {}
    }, createObjectIdentity(local));
    const canonicalReply = object(REPLY_ID, 'mycelium.post', 'reply-author', { reply_to: target.object_id });
    const store = { get: vi.fn(async (id: string) => id === target.object_id ? target : null) };
    const replyOptions = { ...options, identity: local, store };
    const replyNotice = object('c'.repeat(64), 'mycelium.reply', 'reply-author', {
      reply_to: target.object_id,
      reply_to_author: LOCAL_ID,
      reply_post_id: REPLY_ID
    });
    const storage = memoryStorage();
    const showNotification = vi.fn(async () => undefined);

    await expect(classifyNewlyAcceptedObjectNotification(replyNotice, replyOptions)).resolves.toBeNull();
    await expect(classifyNewlyAcceptedObjectNotification(replyNotice, replyOptions)).resolves.toBeNull();
    const classification = await classifyNewlyAcceptedObjectNotification(canonicalReply, replyOptions);
    expect(classification).toEqual({ category: 'replies', dedupeId: REPLY_ID });
    if (classification && 'category' in classification) {
      expect(await showWebPushNotificationOnce(
        { showNotification }, classification.category, classification.dedupeId, storage
      )).toBe(true);
      expect(await showWebPushNotificationOnce(
        { showNotification }, classification.category, classification.dedupeId, storage
      )).toBe(false);
    }
    expect(showNotification).toHaveBeenCalledTimes(1);
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
