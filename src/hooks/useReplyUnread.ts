import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { DistributedObject, ObjectStore } from '../object-layer';

export interface ReplyNotification {
  readonly id: string;
  readonly parentPostId: string;
  readonly replyPostId?: string;
  readonly authorPublicKey: string;
  readonly authorFingerprint: string;
  readonly createdAt: string;
  readonly replyContent: string;
  readonly parentContent: string;
  readonly read: boolean;
  readonly kind?: 'reply' | 'mention';
  readonly mentionedHandle?: string;
}

export interface ReplyUnreadState {
  readonly replies: readonly ReplyNotification[];
  readonly unreadCount: number;
  refresh(): Promise<void>;
  discover(objects: readonly DistributedObject[]): Promise<void>;
  markRead(replyId: string): void;
  markAllRead(): void;
}

export interface ReplyUnreadController {
  getSnapshot(): ReplyUnreadState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  discover(objects: readonly DistributedObject[]): Promise<void>;
  markRead(replyId: string): void;
  markAllRead(): void;
}

interface ReplyUnreadControllerOptions {
  store: ObjectStore;
  identityId: string;
  myPublicKey: string;
  resolveAuthorFingerprint(author: string): Promise<string>;
  onError(error: unknown): void;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

const storageKey = (identityId: string) => `mycelium:reply-read:${identityId}`;
const emptyState: ReplyUnreadState = {
  replies: [],
  unreadCount: 0,
  refresh: async () => {},
  discover: async () => {},
  markRead: () => {},
  markAllRead: () => {}
};
const emptySubscribe = () => () => {};

function replyPayload(object: DistributedObject): Record<string, unknown> | null {
  return typeof object.payload === 'object' && object.payload !== null && !Array.isArray(object.payload)
    ? object.payload as Record<string, unknown>
    : null;
}

function parentContent(object: DistributedObject): string {
  const content = replyPayload(object)?.content;
  return typeof content === 'string' ? content : '';
}

function replyContent(payload: Record<string, unknown>): string {
  return typeof payload.content === 'string' ? payload.content : '';
}

function loadNotifications(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  onError: (error: unknown) => void
): ReplyNotification[] {
  try {
    const stored = storage.getItem(key);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every((value) => (
      typeof value === 'object'
      && value !== null
      && typeof (value as Partial<ReplyNotification>).id === 'string'
      && typeof (value as Partial<ReplyNotification>).parentPostId === 'string'
      && typeof (value as Partial<ReplyNotification>).authorPublicKey === 'string'
      && typeof (value as Partial<ReplyNotification>).authorFingerprint === 'string'
      && typeof (value as Partial<ReplyNotification>).createdAt === 'string'
      && typeof (value as Partial<ReplyNotification>).replyContent === 'string'
      && typeof (value as Partial<ReplyNotification>).parentContent === 'string'
      && typeof (value as Partial<ReplyNotification>).read === 'boolean'
    ))) {
      throw new Error('Stored reply read state is invalid');
    }
    return parsed as ReplyNotification[];
  } catch (error) {
    onError(new Error(`Could not load reply read state: ${error instanceof Error ? error.message : String(error)}`));
    return [];
  }
}

export function createReplyUnreadController({
  store,
  identityId,
  myPublicKey,
  resolveAuthorFingerprint,
  onError,
  storage = localStorage
}: ReplyUnreadControllerOptions): ReplyUnreadController {
  const listeners = new Set<() => void>();
  let replies: ReplyNotification[] = [];
  let revision = 0;
  let started = false;
  let notificationsLoaded = false;

  const publish = () => {
    snapshot = {
      replies,
      unreadCount: replies.reduce((count, reply) => count + Number(!reply.read), 0),
      refresh,
      discover,
      markRead,
      markAllRead
    };
    for (const listener of listeners) listener();
  };

  const persistNotifications = () => {
    try {
      storage.setItem(storageKey(identityId), JSON.stringify(replies));
    } catch (error) {
      onError(new Error(`Could not save reply read state: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  const discover = async (objects: readonly DistributedObject[]): Promise<void> => {
    try {
      const candidates = await Promise.all(objects.map(async (object) => {
        if (object.object_type !== 'mycelium.reply' && object.object_type !== 'mycelium.post') return null;
        if (object.author === myPublicKey) return null;
        const payload = replyPayload(object);
        if (object.object_type === 'mycelium.post' && Array.isArray(payload?.mentions)) {
          const mention = payload.mentions.find((item) => (
            typeof item === 'object'
            && item !== null
            && !Array.isArray(item)
            && typeof (item as Record<string, unknown>).handle === 'string'
            && typeof (item as Record<string, unknown>).peerId === 'string'
            && (item as Record<string, unknown>).publicKey === myPublicKey
          )) as Record<string, unknown> | undefined;
          if (mention) {
            const content = payload && typeof payload.content === 'string' ? payload.content : '';
            const notification: ReplyNotification = {
              id: object.object_id,
              parentPostId: object.object_id,
              authorPublicKey: object.author,
              authorFingerprint: await resolveAuthorFingerprint(object.author),
              createdAt: object.created_at,
              replyContent: 'Mentioned you in a post',
              parentContent: content,
              read: false,
              kind: 'mention',
              mentionedHandle: mention.handle as string
            };
            return { notification, isCanonicalPost: true };
          }
        }
        if (object.object_type !== 'mycelium.reply') return null;
        const parentPostId = payload?.reply_to;
        if (typeof parentPostId !== 'string' || !/^[0-9a-f]{64}$/.test(parentPostId)) return null;
        const parent = await store.get(parentPostId);
        if (!parent || parent.object_type !== 'mycelium.post' || parent.author !== myPublicKey) return null;

        const signalReplyPostId = payload && typeof payload.reply_post_id === 'string'
          && /^[0-9a-f]{64}$/.test(payload.reply_post_id)
          ? payload.reply_post_id
          : undefined;
        const canonicalPost = signalReplyPostId ? await store.get(signalReplyPostId) : null;
        const hasCanonicalPost = canonicalPost?.object_type === 'mycelium.post'
          && canonicalPost.author === object.author;
        const canonicalContent = canonicalPost ? replyPayload(canonicalPost)?.content : undefined;
        const canonicalReplyId = signalReplyPostId;
        const notification: ReplyNotification = {
          id: canonicalReplyId ?? object.object_id,
          parentPostId,
          ...(canonicalReplyId ? { replyPostId: canonicalReplyId } : {}),
          authorPublicKey: object.author,
          authorFingerprint: await resolveAuthorFingerprint(object.author),
          createdAt: hasCanonicalPost ? canonicalPost.created_at : object.created_at,
          replyContent: hasCanonicalPost && typeof canonicalContent === 'string'
            ? canonicalContent
            : payload ? replyContent(payload) : '',
          parentContent: parentContent(parent),
          read: false,
          kind: 'reply'
        };
        return { notification, isCanonicalPost: hasCanonicalPost };
      }));

      let changed = false;
      for (const candidate of candidates) {
        if (!candidate) continue;
        const { notification, isCanonicalPost } = candidate;
        const existingIndex = replies.findIndex((reply) => reply.id === notification.id);
        if (existingIndex === -1) {
          replies = [...replies, notification];
          changed = true;
          continue;
        }

        const existing = replies[existingIndex];
        const updated: ReplyNotification = {
          ...existing,
          ...notification,
          createdAt: isCanonicalPost ? notification.createdAt : existing.createdAt,
          replyContent: isCanonicalPost || !existing.replyContent
            ? notification.replyContent || existing.replyContent
            : existing.replyContent,
          read: existing.read
        };
        if (JSON.stringify(existing) !== JSON.stringify(updated)) {
          replies = replies.map((reply, index) => index === existingIndex ? updated : reply);
          changed = true;
        }
      }

      if (!changed) return;
      replies.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      persistNotifications();
      publish();
    } catch (error) {
      onError(new Error(`Could not process discovered replies: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  const refresh = async (): Promise<void> => {
    const currentRevision = ++revision;
    try {
      const objects = await store.query({ object_type: 'mycelium.reply' });
      const posts = await store.query({ object_type: 'mycelium.post' });
      if (currentRevision !== revision) return;
      await discover([...objects, ...posts]);
    } catch (error) {
      onError(new Error(`Could not refresh replies: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  const markRead = (replyId: string) => {
    if (!replies.some((reply) => reply.id === replyId && !reply.read)) return;
    replies = replies.map((reply) => reply.id === replyId ? { ...reply, read: true } : reply);
    persistNotifications();
    publish();
  };

  const markAllRead = () => {
    const unread = replies.filter((reply) => !reply.read);
    if (unread.length === 0) return;
    replies = replies.map((reply) => ({ ...reply, read: true }));
    persistNotifications();
    publish();
  };

  let snapshot: ReplyUnreadState = {
    ...emptyState,
    refresh,
    discover,
    markRead,
    markAllRead
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (started) return;
      started = true;
      if (!notificationsLoaded) {
        replies = loadNotifications(storage, storageKey(identityId), onError);
        notificationsLoaded = true;
        publish();
      }
      void refresh();
    },
    stop() {
      started = false;
      revision += 1;
    },
    refresh,
    discover,
    markRead,
    markAllRead
  };
}

export function useReplyUnreadController({
  store,
  identityId,
  myPublicKey,
  resolveAuthorFingerprint,
  onError
}: {
  store: ObjectStore | null;
  identityId: string | null;
  myPublicKey: string | null;
  resolveAuthorFingerprint(author: string): Promise<string>;
  onError(error: unknown): void;
}): ReplyUnreadState {
  const resolveAuthorFingerprintRef = useRef(resolveAuthorFingerprint);
  const onErrorRef = useRef(onError);
  resolveAuthorFingerprintRef.current = resolveAuthorFingerprint;
  onErrorRef.current = onError;

  const controller = useMemo(() => store && identityId && myPublicKey ? createReplyUnreadController({
    store,
    identityId,
    myPublicKey,
    resolveAuthorFingerprint: (author) => resolveAuthorFingerprintRef.current(author),
    onError: (error) => onErrorRef.current(error)
  }) : null, [identityId, myPublicKey, store]);

  useEffect(() => {
    if (!controller) return;
    controller.start();
    return () => controller.stop();
  }, [controller]);

  return useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.getSnapshot ?? (() => emptyState),
    controller?.getSnapshot ?? (() => emptyState)
  );
}
