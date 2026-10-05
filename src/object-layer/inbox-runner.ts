import { fetchPageFromPeers, type FindClientTransport } from './find-client';
import { syncInbox } from './inbox-sync';
import type { DistributedObject, ObjectStore } from './types';

export interface InboxRunnerOptions {
  myPublicKey: string;
  store: ObjectStore;
  transport: FindClientTransport;
  loadCursor: (identityKey: string) => Promise<string | null>;
  saveCursor: (identityKey: string, cursor: string) => Promise<unknown>;
  onStored?: (objects: DistributedObject[]) => void | Promise<void>;
  now?: () => Date;
}

export function createInboxRunner({
  myPublicKey,
  store,
  transport,
  loadCursor,
  saveCursor,
  onStored,
  now
}: InboxRunnerOptions): { syncOnce: () => Promise<{ stored: number; truncated: boolean }> } {
  const fetchPage = fetchPageFromPeers(transport, { sender: myPublicKey });

  return {
    async syncOnce() {
      const cursor = await loadCursor(myPublicKey);
      const result = await syncInbox({
        myPublicKey,
        cursor,
        store,
        fetchPage,
        ...(now ? { now } : {})
      });

      if (result.cursor !== null && !result.truncated) {
        await saveCursor(myPublicKey, result.cursor);
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
