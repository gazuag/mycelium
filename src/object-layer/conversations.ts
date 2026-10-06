import { isObjectExpired } from './envelope';
import * as dmInbox from './dm-inbox';
import type { DmObjectIdentity } from './dm-object';
import type { SenderEncryptionKeyResolver } from './dm-inbox';
import type { DistributedObject, ObjectStore } from './types';

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
  readonly delivery?: 'pending' | 'sent';
}

export interface ConversationOutboxEntry {
  readonly delivered_direct: boolean;
  readonly replicated_to: string[];
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

  for (const object of objects) {
    const counterparty = object.author === myPublicKey ? object.recipient : object.author;
    if (!counterparty || counterparty === myPublicKey) continue;
    const group = groups.get(counterparty) ?? [];
    group.push(object);
    groups.set(counterparty, group);
  }

  return [...groups.entries()]
    .map(([counterparty, messages]) => {
      const newest = [...messages].sort(compareNewestFirst)[0];
      return {
        counterparty,
        lastAt: newest.created_at,
        lastObjectId: newest.object_id,
        lastDirection: directionFor(newest, myPublicKey),
        count: messages.length
      };
    })
    .sort((left, right) => (
      Date.parse(right.lastAt) - Date.parse(left.lastAt)
      || right.lastObjectId.localeCompare(left.lastObjectId)
    ));
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
  return await Promise.all(newest.map((object) => buildMessage({
    object,
    identity,
    resolveSenderEncryptionKey,
    getOutboxEntry
  })));
}

export async function previewConversation(
  options: ConversationReadOptions
): Promise<ConversationMessage | null> {
  const { store, identity, counterparty, resolveSenderEncryptionKey, getOutboxEntry } = options;
  const objects = await getConversationObjects(store, identity.publicKey, counterparty);
  const newest = objects.sort(compareNewestFirst)[0];
  if (!newest) return null;
  return await buildMessage({ object: newest, identity, resolveSenderEncryptionKey, getOutboxEntry });
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

  const base: ConversationMessage = {
    objectId: object.object_id,
    direction,
    createdAt: object.created_at,
    status: opened.status,
    text: opened.status === 'ok' ? opened.plaintext : null
  };
  if (direction === 'in') return base;

  const entry = await getOutboxEntry(object.object_id);
  const delivery: 'pending' | 'sent' = entry
    && !entry.delivered_direct
    && entry.replicated_to.length === 0
    ? 'pending'
    : 'sent';
  return { ...base, delivery };
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
