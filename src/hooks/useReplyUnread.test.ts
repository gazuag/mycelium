import { describe, expect, it, vi } from 'vitest';
import type { DistributedObject, ObjectStore } from '../object-layer';
import { createReplyUnreadController } from './useReplyUnread';

const ownPublicKey = 'my-public-key';
const ownPostId = 'a'.repeat(64);
const otherPostId = 'b'.repeat(64);

function post(objectId: string, author: string, content: string): DistributedObject {
  return {
    object_id: objectId,
    object_type: 'mycelium.post',
    author,
    created_at: '2026-10-18T10:00:00.000Z',
    payload: { content },
    replication_policy: {},
    signature: 'signature'
  };
}

function reply(
  objectId: string,
  author: string,
  parentPostId: string,
  createdAt: string
): DistributedObject {
  return {
    object_id: objectId,
    object_type: 'mycelium.reply',
    author,
    created_at: createdAt,
    payload: { reply_to: parentPostId, content: `Reply ${objectId}` },
    replication_policy: {},
    signature: 'signature'
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values
  };
}

function makeController(objects: DistributedObject[], storage = memoryStorage()) {
  const byId = new Map(objects.map((object) => [object.object_id, object]));
  const store = {
    query: async ({ object_type }: { object_type?: string }) => objects.filter((object) => object.object_type === object_type),
    get: async (objectId: string) => byId.get(objectId) ?? null
  } as ObjectStore;
  const errors: unknown[] = [];
  const controller = createReplyUnreadController({
    store,
    identityId: 'my-peer-id',
    myPublicKey: ownPublicKey,
    resolveAuthorFingerprint: async (author) => `fingerprint:${author}`,
    onError: (error) => errors.push(error),
    storage
  });
  return { controller, storage, errors };
}

describe('reply unread notifications', () => {
  it('lists only incoming reply notices that reference the current user’s posts, newest first', async () => {
    const olderReply = reply('reply-old', 'alice-key', ownPostId, '2026-10-17T10:00:00.000Z');
    const newerReply = reply('reply-new', 'bob-key', ownPostId, '2026-10-18T10:00:00.000Z');
    const ownReply = reply('reply-own', ownPublicKey, ownPostId, '2026-10-18T11:00:00.000Z');
    const otherReply = reply('reply-other', 'eve-key', otherPostId, '2026-10-18T12:00:00.000Z');
    const { controller } = makeController([
      post(ownPostId, ownPublicKey, 'My post'),
      post(otherPostId, 'someone-elses-key', 'Another post'),
      olderReply,
      newerReply,
      ownReply,
      otherReply
    ]);

    await controller.refresh();
    const snapshot = controller.getSnapshot();
    expect(snapshot.replies.map((item) => item.id)).toEqual(['reply-new', 'reply-old']);
    expect(snapshot.replies[0]).toMatchObject({
      parentPostId: ownPostId,
      authorPublicKey: 'bob-key',
      authorFingerprint: 'fingerprint:bob-key',
      id: 'reply-new',
      replyContent: 'Reply reply-new',
      parentContent: 'My post',
      read: false
    });
    expect(snapshot.unreadCount).toBe(2);
  });

  it('persists individual and bulk read state separately from DM contacts', async () => {
    const replyOne = reply('reply-one', 'alice-key', ownPostId, '2026-10-18T10:00:00.000Z');
    const replyTwo = reply('reply-two', 'bob-key', ownPostId, '2026-10-18T11:00:00.000Z');
    const objects = [post(ownPostId, ownPublicKey, 'My post'), replyOne, replyTwo];
    const { controller, storage } = makeController(objects);

    await controller.refresh();
    controller.markRead('reply-two');
    expect(controller.getSnapshot().unreadCount).toBe(1);
    controller.markAllRead();
    expect(controller.getSnapshot().unreadCount).toBe(0);

    const reloaded = makeController(objects, storage).controller;
    reloaded.start();
    await reloaded.refresh();
    expect(reloaded.getSnapshot().replies.every((item) => item.read)).toBe(true);
    expect(storage.values.get('mycelium:reply-read:my-peer-id')).toContain('reply-one');
  });

  it('does not treat a feed-rendered post reply as a notification without a reply signal', async () => {
    const feedReply = {
      ...post('feed-reply-post', 'alice-key', 'A normal feed reply'),
      payload: { content: 'A normal feed reply', reply_to: ownPostId }
    };
    const { controller } = makeController([
      post(ownPostId, ownPublicKey, 'My post'),
      feedReply
    ]);

    await controller.refresh();
    expect(controller.getSnapshot().replies).toEqual([]);
    expect(controller.getSnapshot().unreadCount).toBe(0);
  });

  it('merges the reply signal with its newly discovered canonical post and preserves read state', async () => {
    const canonicalId = 'c'.repeat(64);
    const signal = {
      ...reply('reply-signal', 'alice-key', ownPostId, '2026-10-18T10:01:00.000Z'),
      payload: {
        reply_to: ownPostId,
        reply_to_author: 'my-peer-id',
        reply_post_id: canonicalId,
        content: 'Signal snapshot'
      }
    };
    const canonicalPost: DistributedObject = {
      ...post(canonicalId, 'alice-key', 'Canonical reply content'),
      payload: { content: 'Canonical reply content', reply_to: ownPostId }
    };
    const { controller } = makeController([post(ownPostId, ownPublicKey, 'My post'), signal, canonicalPost]);

    await controller.refresh();
    expect(controller.getSnapshot().replies).toHaveLength(1);
    controller.markRead(canonicalId);
    await controller.discover([canonicalPost]);

    expect(controller.getSnapshot().replies).toHaveLength(1);
    expect(controller.getSnapshot().replies[0]).toMatchObject({
      id: canonicalId,
      replyPostId: canonicalId,
      replyContent: 'Canonical reply content',
      read: true
    });
  });

  it('reports storage-query failures rather than silently treating them as an empty inbox', async () => {
    const error = new Error('store unavailable');
    const store = { query: async () => { throw error; }, get: async () => null } as unknown as ObjectStore;
    const onError = vi.fn();
    const controller = createReplyUnreadController({
      store,
      identityId: 'my-peer-id',
      myPublicKey: ownPublicKey,
      resolveAuthorFingerprint: async (author) => author,
      onError,
      storage: memoryStorage()
    });

    await controller.refresh();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Could not refresh replies: store unavailable' }));
  });
});
