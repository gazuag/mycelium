import { isObjectExpired } from './envelope';
import type { OutboxEntry, OutboxStore } from './local-store';
import type { DistributedObject, ObjectStore } from './types';

const DEFAULT_MAX_PER_FLUSH = 50;
const DEFAULT_OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECENT_SEND_ATTEMPTS = 500;

export interface OutboxServiceConfig {
  readonly maxPerFlush?: number;
}

export interface CreateOutboxServiceOptions {
  readonly outbox: OutboxStore;
  readonly objectStore: Pick<ObjectStore, 'get'>;
  readonly sendDirect: (peerId: string, object: DistributedObject) => Promise<boolean>;
  readonly replicate: (object: DistributedObject, alreadyAttemptedTo: Set<string>) => Promise<string[]>;
  readonly resolveRecipientPeerId: (recipientSigningKey: string) => string | null;
  readonly connectedPeers: () => string[];
  readonly now?: () => Date;
  readonly config?: OutboxServiceConfig;
}

export interface OutboxFlushResult {
  readonly processed: number;
  readonly completed: number;
}

export function createOutboxService({
  outbox,
  objectStore,
  sendDirect,
  replicate,
  resolveRecipientPeerId,
  connectedPeers,
  now = () => new Date(),
  config = {}
}: CreateOutboxServiceOptions): {
  enqueue(object: DistributedObject): Promise<void>;
  flush(): Promise<OutboxFlushResult>;
  getEntry(objectId: string): Promise<OutboxEntry | null>;
  getAttemptedTo(objectId: string): readonly string[];
} {
  const maxPerFlush = config.maxPerFlush ?? DEFAULT_MAX_PER_FLUSH;
  let inFlight: Promise<OutboxFlushResult> | null = null;

  const enqueue = async (object: DistributedObject): Promise<void> => {
    const createdAt = Date.parse(object.created_at);
    const expiresAt = object.expires_at
      ?? new Date(createdAt + DEFAULT_OUTBOX_TTL_MS).toISOString();
    await outbox.add({
      object_id: object.object_id,
      created_at: object.created_at,
      expires_at: expiresAt,
      replication_send_attempted: false,
      direct_send_attempted: false,
      attempts: 0,
      last_attempt_at: null
    });
  };

  const performFlush = async (): Promise<OutboxFlushResult> => {
    await outbox.pruneExpired(now());
    const entries = await outbox.listPending(maxPerFlush);
    let processed = 0;
    let completed = 0;

    for (const originalEntry of entries) {
      processed += 1;
      try {
        const attemptedPeersThisFlush = new Set<string>();
        const {
          delivered_direct: legacyDeliveredDirect,
          replicated_to: legacyReplicatedTo,
          ...persistedEntry
        } = originalEntry;
        let entry = {
          ...persistedEntry,
          replication_send_attempted: originalEntry.replication_send_attempted
            ?? Boolean(legacyReplicatedTo?.length),
          direct_send_attempted: originalEntry.direct_send_attempted ?? legacyDeliveredDirect ?? false
        };
        let object: DistributedObject | null;
        try {
          object = await objectStore.get(entry.object_id);
        } catch {
          if (await recordAttempt(entry)) completed += 1;
          continue;
        }

        if (!object || isObjectExpired(object, now())) {
          await outbox.remove(entry.object_id);
          completed += 1;
          continue;
        }

        if (object.recipient) {
          try {
            const recipientPeerId = resolveRecipientPeerId(object.recipient);
            if (recipientPeerId && connectedPeers().includes(recipientPeerId)) {
              attemptedPeersThisFlush.add(recipientPeerId);
              entry = { ...entry, direct_send_attempted: true };
              await sendDirect(recipientPeerId, object);
            }
          } catch {
            // A direct-send failure does not prevent replica attempts.
          }
        }

        try {
          const attemptedPeers = await replicate(object, new Set());
          attemptedPeers.forEach((peerId) => attemptedPeersThisFlush.add(peerId));
          entry = {
            ...entry,
            replication_send_attempted: entry.replication_send_attempted || attemptedPeers.length > 0
          };
        } catch {
          // Keep any successful direct-send state and retry this entry on a later flush.
        }
        if (attemptedPeersThisFlush.size > 0) {
          rememberAttemptedTo(entry.object_id, [...attemptedPeersThisFlush]);
        }

        const attemptedAt = now();
        entry = {
          ...entry,
          attempts: entry.attempts + 1,
          last_attempt_at: attemptedAt.toISOString()
        };
        if (isComplete(entry, attemptedAt)) {
          await outbox.remove(entry.object_id);
          completed += 1;
        } else {
          await outbox.update(entry);
        }
      } catch {
        try {
          if (await recordAttempt(originalEntry)) completed += 1;
        } catch {
          // Continue processing other entries even if this entry cannot be updated.
        }
      }
    }

    return { processed, completed };
  };

  const flush = (): Promise<OutboxFlushResult> => {
    if (inFlight) return inFlight;
    inFlight = performFlush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const getEntry = (objectId: string): Promise<OutboxEntry | null> => outbox.get(objectId);

  const getAttemptedTo = (objectId: string): readonly string[] => (
    lastAttemptedTo.get(objectId) ?? []
  );

  function rememberAttemptedTo(objectId: string, peerIds: string[]) {
    lastAttemptedTo.delete(objectId);
    lastAttemptedTo.set(objectId, peerIds);
    if (lastAttemptedTo.size > MAX_RECENT_SEND_ATTEMPTS) {
      const oldestObjectId = lastAttemptedTo.keys().next().value;
      if (oldestObjectId !== undefined) lastAttemptedTo.delete(oldestObjectId);
    }
  }

  async function recordAttempt(entry: OutboxEntry): Promise<boolean> {
    const attemptedAt = now();
    const updated: OutboxEntry = {
      ...entry,
      attempts: entry.attempts + 1,
      last_attempt_at: attemptedAt.toISOString()
    };
    if (isComplete(updated, attemptedAt)) {
      await outbox.remove(entry.object_id);
      return true;
    }
    await outbox.update(updated);
    return false;
  }

  const lastAttemptedTo = new Map<string, readonly string[]>();

  return { enqueue, flush, getEntry, getAttemptedTo };
}

function isComplete(entry: OutboxEntry, now: Date): boolean {
  return Date.parse(entry.expires_at) <= now.getTime();
}
