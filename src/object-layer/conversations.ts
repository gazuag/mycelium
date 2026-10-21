import { isObjectExpired } from './envelope';
import { isDeletionAwareObjectStore } from './deletion';
import * as dmInbox from './dm-inbox';
import type { DmObjectIdentity } from './dm-object';
import type { SenderEncryptionKeyResolver } from './dm-inbox';
import type { DeletionTombstone, DistributedObject, ObjectStore } from './types';
import { decodeMarkdownMessage, type ExternalImageSize } from '../markdown/external-content';

export type ConversationDirection = 'in' | 'out';
export type ConversationMessageStatus = 'ok' | 'unverified' | 'key_changed' | 'invalid';

export interface ConversationSummary {
  readonly counterparty: string;
  readonly lastAt: string;
  readonly lastObjectId: string;
  readonly lastDirection: ConversationDirection;
  readonly count: number;
}

export interface ConversationMessage {
  readonly objectId: string;
  readonly direction: ConversationDirection;
  readonly createdAt: string;
  readonly status: ConversationMessageStatus;
  readonly text: string | null;
  readonly imageSizes?: readonly ExternalImageSize[];
  readonly deleted?: true;
  readonly delivery?: 'pending' | 'attempted';
}

export interface ConversationOutboxEntry {
  readonly direct_send_attempted?: boolean;
  readonly delivered_direct?: boolean;
  readonly replication_send_attempted?: boolean;
  readonly replicated_to?: string[];
}

export interface ConversationReadOptions {
  readonly store: ObjectStore;
  readonly identity: DmObjectIdentity;
  readonly counterparty: string;
  readonly resolveSenderEncryptionKey: SenderEncryptionKeyResolver;
  readonly getOutboxEntry: (objectId: string) => Promise<ConversationOutboxEntry | null>;
  readonly limit?: number;
}

export async function listConversations({
  store,
  myPublicKey
}: {
  store: ObjectStore;
  myPublicKey: string;
}): Promise<ConversationSummary[]> {
  const objects = await dmInbox.listDmsForIdentity({ store, myPublicKey });
  const groups = new Map<string, DistributedObject[]>();
  const tombstones = isDeletionAwareObjectStore(store)
    ? (await store.queryDeletionTombstones()).filter((item) => item.target_object_type === 'mycelium.dm')
    : [];

  for (const object of objects) {
    const counterparty = object.author === myPublicKey ? object.recipient : object.author;
    if (!counterparty || counterparty === myPublicKey) continue;
    const group = groups.get(counterparty) ?? [];
    group.push(object);
    groups.set(counterparty, group);
  }

  const summaries = [...groups.entries()]
    .map(([counterparty, messages]) => {
      const newest = [...messages].sort(compareNewestFirst)[0];
      return {
        counterparty,
        lastAt: newest.created_at,
        lastObjectId: newest.object_id,
        lastDirection: directionFor(newest, myPublicKey),
        count: messages.length
      };
    });
  const summaryByPeer = new Map(summaries.map((summary) => [summary.counterparty, summary]));
  for (const tombstone of tombstones) {
    const counterparty = tombstone.target_author === myPublicKey
      ? tombstone.target_recipient
      : tombstone.target_author;
    if (!counterparty || counterparty === myPublicKey) continue;
    const previous = summaryByPeer.get(counterparty);
    const isNewer = !previous
      || Date.parse(tombstone.target_created_at) > Date.parse(previous.lastAt)
      || (tombstone.target_created_at === previous.lastAt
        && tombstone.target_object_id.localeCompare(previous.lastObjectId) > 0);
    summaryByPeer.set(counterparty, {
      counterparty,
      lastAt: isNewer ? tombstone.target_created_at : previous.lastAt,
      lastObjectId: isNewer ? tombstone.target_object_id : previous.lastObjectId,
      lastDirection: isNewer
        ? tombstone.target_author === myPublicKey ? 'out' : 'in'
        : previous.lastDirection,
      count: (previous?.count ?? 0) + 1
    });
  }

  return [...summaryByPeer.values()]
    .sort((left, right) => (
      Date.parse(right.lastAt) - Date.parse(left.lastAt)
      || right.lastObjectId.localeCompare(left.lastObjectId)
    ));
}

export async function countUnread({
    store,
    myPublicKey,
    counterparty,
    since
}: {
    store: ObjectStore;
    myPublicKey: string;
    counterparty: string;
    since: string | null;
}): Promise<number> {
    const objects = await store.query({
      object_type: 'mycelium.dm',
      author: counterparty,
      recipient: myPublicKey
    });
    const sinceTime = since === null ? null : Date.parse(since);
    return objects.filter((object) => (
      object.object_type === 'mycelium.dm'
      && object.author === counterparty
      && object.recipient === myPublicKey
      && !isObjectExpired(object)
      && (sinceTime === null || Date.parse(object.created_at) > sinceTime)
    )).length;
}

export async function countUnreadByCounterparty({
    store,
    myPublicKey,
    sinceByCounterparty
}: {
    store: ObjectStore;
    myPublicKey: string;
    sinceByCounterparty: ReadonlyMap<string, string | null>;
}): Promise<Map<string, number>> {
    const counts = new Map([...sinceByCounterparty.keys()].map((counterparty) => [counterparty, 0]));
    if (counts.size === 0) return counts;

    const objects = await store.query({ object_type: 'mycelium.dm', recipient: myPublicKey });
    for (const object of objects) {
      if (!sinceByCounterparty.has(object.author)
        || object.object_type !== 'mycelium.dm'
        || object.author === myPublicKey
        || object.recipient !== myPublicKey
        || isObjectExpired(object)) continue;
      const since = sinceByCounterparty.get(object.author) ?? null;
      const sinceTime = since === null ? null : Date.parse(since);
      if (sinceTime === null || Date.parse(object.created_at) > sinceTime) {
        counts.set(object.author, (counts.get(object.author) ?? 0) + 1);
      }
    }
    return counts;
}

export async function newestIncomingDmAt({
    store,
    myPublicKey,
    counterparty
}: {
    store: ObjectStore;
    myPublicKey: string;
    counterparty: string;
}): Promise<string | null> {
    const objects = await store.query({
      object_type: 'mycelium.dm',
      author: counterparty,
      recipient: myPublicKey
    });
    return objects
      .filter((object) => object.object_type === 'mycelium.dm'
        && object.author === counterparty
        && object.recipient === myPublicKey
        && !isObjectExpired(object))
      .sort(compareNewestFirst)[0]?.created_at ?? null;
}

export async function loadConversation({
  store,
  identity,
  counterparty,
  resolveSenderEncryptionKey,
  getOutboxEntry,
  limit = 200
}: ConversationReadOptions): Promise<ConversationMessage[]> {
  const objects = await getConversationObjects(store, identity.publicKey, counterparty);
  const ordered = objects.sort(compareOldestFirst);
  const startIndex = Math.max(0, ordered.length - Math.max(0, Math.trunc(limit)));
  const newest = ordered.slice(startIndex);
  const messages = await Promise.all(newest.map((object) => buildMessage({
    object,
    identity,
    resolveSenderEncryptionKey,
    getOutboxEntry
  })));
  messages.push(...(await conversationTombstones(store, identity.publicKey, counterparty)).map((item) => ({
    objectId: item.target_object_id,
    direction: item.target_author === identity.publicKey ? 'out' as const : 'in' as const,
    createdAt: item.target_created_at,
    status: 'ok' as const,
    text: null,
    deleted: true as const
  })));
  return messages
    .sort(compareMessagesOldestFirst)
    .slice(-Math.max(0, Math.trunc(limit)));
}

export async function previewConversation(
  options: ConversationReadOptions
): Promise<ConversationMessage | null> {
  const { store, identity, counterparty, resolveSenderEncryptionKey, getOutboxEntry } = options;
  const objects = await getConversationObjects(store, identity.publicKey, counterparty);
  const newest = objects.sort(compareNewestFirst)[0];
  const newestTombstone = (await conversationTombstones(store, identity.publicKey, counterparty))
    .sort((left, right) => Date.parse(right.target_created_at) - Date.parse(left.target_created_at)
      || right.target_object_id.localeCompare(left.target_object_id))[0];
  if (newestTombstone && (!newest
    || Date.parse(newestTombstone.target_created_at) > Date.parse(newest.created_at)
    || (newestTombstone.target_created_at === newest.created_at
      && newestTombstone.target_object_id.localeCompare(newest.object_id) > 0))) {
    return {
      objectId: newestTombstone.target_object_id,
      direction: newestTombstone.target_author === identity.publicKey ? 'out' : 'in',
      createdAt: newestTombstone.target_created_at,
      status: 'ok',
      text: null,
      deleted: true
    };
  }
  if (!newest) return null;
  return await buildMessage({ object: newest, identity, resolveSenderEncryptionKey, getOutboxEntry });
}

async function conversationTombstones(
  store: ObjectStore,
  myPublicKey: string,
  counterparty: string
): Promise<DeletionTombstone[]> {
  if (!isDeletionAwareObjectStore(store)) return [];
  return (await store.queryDeletionTombstones()).filter((item) => (
    item.target_object_type === 'mycelium.dm'
    && (
      (item.target_author === myPublicKey && item.target_recipient === counterparty)
      || (item.target_author === counterparty && item.target_recipient === myPublicKey)
    )
  ));
}

async function getConversationObjects(
  store: ObjectStore,
  myPublicKey: string,
  counterparty: string
): Promise<DistributedObject[]> {
  const objects = await dmInbox.listDmsForIdentity({ store, myPublicKey });
  return objects.filter((object) => (
    !isObjectExpired(object)
    && (
      (object.author === myPublicKey && object.recipient === counterparty)
      || (object.author === counterparty && object.recipient === myPublicKey)
    )
  ));
}

async function buildMessage({
  object,
  identity,
  resolveSenderEncryptionKey,
  getOutboxEntry
}: {
  object: DistributedObject;
  identity: DmObjectIdentity;
  resolveSenderEncryptionKey: SenderEncryptionKeyResolver;
  getOutboxEntry: ConversationReadOptions['getOutboxEntry'];
}): Promise<ConversationMessage> {
  const direction = directionFor(object, identity.publicKey);
  let opened: Awaited<ReturnType<typeof dmInbox.openDm>>;
  try {
    opened = await dmInbox.openDm({ object, identity, resolveSenderEncryptionKey });
  } catch {
    opened = { status: 'invalid' };
  }

  const markdownMessage = opened.status === 'ok'
    ? decodeMarkdownMessage(opened.plaintext)
    : null;
  const base: ConversationMessage = {
    objectId: object.object_id,
    direction,
    createdAt: object.created_at,
    status: opened.status,
    text: markdownMessage?.content ?? null,
    ...(markdownMessage ? { imageSizes: markdownMessage.imageSizes } : {})
  };
  if (direction === 'in') return base;

  const entry = await getOutboxEntry(object.object_id);
  if (!entry) return base;
  const wasAttempted = entry.direct_send_attempted === true
    || entry.delivered_direct === true
    || entry.replication_send_attempted === true
    || (entry.replicated_to?.length ?? 0) > 0;
  return { ...base, delivery: wasAttempted ? 'attempted' : 'pending' };
}

function directionFor(object: DistributedObject, myPublicKey: string): ConversationDirection {
  return object.author === myPublicKey ? 'out' : 'in';
}

function compareOldestFirst(left: DistributedObject, right: DistributedObject): number {
  return Date.parse(left.created_at) - Date.parse(right.created_at)
    || left.object_id.localeCompare(right.object_id);
}

function compareNewestFirst(left: DistributedObject, right: DistributedObject): number {
  return Date.parse(right.created_at) - Date.parse(left.created_at)
    || right.object_id.localeCompare(left.object_id);
}

function compareMessagesOldestFirst(left: ConversationMessage, right: ConversationMessage): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.objectId.localeCompare(right.objectId);
}
