import { fetchPageFromPeers, type FindClientTransport } from './find-client';
import { syncInbox, type InboxBackfillState } from './inbox-sync';
import type { DistributedObject, ObjectStore } from './types';

export interface InboxRunnerOptions {
  myPublicKey: string;
  store: ObjectStore;
  transport: FindClientTransport;
  loadCursor: (identityKey: string) => Promise<string | null>;
  saveCursor: (identityKey: string, cursor: string) => Promise<unknown>;
  loadBackfillState?: (identityKey: string) => Promise<InboxBackfillState | null>;
  saveBackfillState?: (identityKey: string, state: InboxBackfillState | null) => Promise<unknown>;
  onStored?: (objects: DistributedObject[]) => void | Promise<void>;
  now?: () => Date;
}

export function createInboxRunner({
  myPublicKey,
  store,
  transport,
  loadCursor,
  saveCursor,
  loadBackfillState,
  saveBackfillState,
  onStored,
  now
}: InboxRunnerOptions): { syncOnce: () => Promise<{ stored: number; truncated: boolean }> } {
  const fetchPage = fetchPageFromPeers(transport, { sender: myPublicKey });

  return {
    async syncOnce() {
      const cursor = await loadCursor(myPublicKey);
      const backfillState = await loadBackfillState?.(myPublicKey) ?? null;
      const result = await syncInbox({
        myPublicKey,
        cursor,
        backfillState,
        store,
        fetchPage,
        ...(now ? { now } : {})
      });

      if (result.cursor !== null && !result.truncated) {
        await saveCursor(myPublicKey, result.cursor);
      }
      if (saveBackfillState && result.backfillState !== backfillState
        && (result.backfillComplete || backfillState === null)) {
        await saveBackfillState(myPublicKey, result.backfillState);
      }

      if (result.stored.length > 0 && onStored) {
        try {
          await onStored(result.stored);
        } catch {
          // Notification failures must not affect a completed sync.
        }
      }

      return { stored: result.stored.length, truncated: result.truncated };
    }
  };
}
