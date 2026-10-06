import { isObjectExpired } from './envelope';
import { DM_REPLICATION_BUDGET } from './dm-object';
import type { OutboxEntry, OutboxStore } from './local-store';
import type { DistributedObject, ObjectStore } from './types';

const DEFAULT_MAX_PER_FLUSH = 50;
const DEFAULT_MAX_ATTEMPTS = 200;
const DEFAULT_OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECENT_REPLICATION_RESULTS = 500;

export interface OutboxServiceConfig {
  readonly maxPerFlush?: number;
}

export interface CreateOutboxServiceOptions {
  readonly outbox: OutboxStore;
  readonly objectStore: Pick<ObjectStore, 'get'>;
  readonly sendDirect: (peerId: string, object: DistributedObject) => Promise<boolean>;
  readonly replicate: (object: DistributedObject, alreadyReplicatedTo: Set<string>) => Promise<string[]>;
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
  getReplicatedTo(objectId: string): readonly string[];
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
      replicated_to: [],
      delivered_direct: false,
      attempts: 0,
      last_attempt_at: null
    });
    if (!lastReplicatedTo.has(object.object_id)) {
      lastReplicatedTo.set(object.object_id, []);
    }
  };

  const performFlush = async (): Promise<OutboxFlushResult> => {
    await outbox.pruneExpired(now());
    const entries = await outbox.listPending(maxPerFlush);
    let processed = 0;
    let completed = 0;

    for (const originalEntry of entries) {
      processed += 1;
      try {
        let entry = originalEntry;
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

        if (object.recipient && !entry.delivered_direct) {
          try {
            const recipientPeerId = resolveRecipientPeerId(object.recipient);
            if (recipientPeerId && connectedPeers().includes(recipientPeerId)) {
              const sent = await sendDirect(recipientPeerId, object);
              if (sent) entry = { ...entry, delivered_direct: true };
            }
          } catch {
            // A direct-send failure does not prevent replica attempts.
          }
        }

        try {
          const replicatedPeers = await replicate(object, new Set(entry.replicated_to));
          entry = { ...entry, replicated_to: [...new Set([...entry.replicated_to, ...replicatedPeers])] };
          lastReplicatedTo.delete(entry.object_id);
          lastReplicatedTo.set(entry.object_id, entry.replicated_to);
          if (lastReplicatedTo.size > MAX_RECENT_REPLICATION_RESULTS) {
            const oldestObjectId = lastReplicatedTo.keys().next().value;
            if (oldestObjectId !== undefined) lastReplicatedTo.delete(oldestObjectId);
          }
        } catch {
          // Keep any successful direct-send state and retry this entry on a later flush.
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

  const getReplicatedTo = (objectId: string): readonly string[] => (
    lastReplicatedTo.get(objectId) ?? []
  );

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

  const lastReplicatedTo = new Map<string, readonly string[]>();

  return { enqueue, flush, getEntry, getReplicatedTo };
}

function isComplete(entry: OutboxEntry, now: Date): boolean {
  return entry.replicated_to.length >= DM_REPLICATION_BUDGET
    || (entry.delivered_direct && entry.replicated_to.length >= 1)
    || entry.attempts >= DEFAULT_MAX_ATTEMPTS
    || Date.parse(entry.expires_at) <= now.getTime();
}
