import { compareFeedKey } from './feed-page';
import type { DistributedObject, FeedCursor } from './types';

export interface FeedSyncPage {
  readonly objects: DistributedObject[];
  readonly next_cursor: FeedCursor | null;
  readonly has_more: boolean;
}

export interface FeedSyncOptions {
  readonly peerId: string;
  readonly loadCursor: (peerId: string) => FeedCursor | null | Promise<FeedCursor | null>;
  readonly saveCursor: (peerId: string, cursor: FeedCursor) => void | Promise<void>;
  readonly requestPage: (
    peerId: string,
    after: FeedCursor | null,
    limit?: number
  ) => Promise<FeedSyncPage>;
  readonly storeObjects: (objects: DistributedObject[]) => Promise<void>;
  readonly limit?: number;
  readonly maxPages?: number;
}

export interface FeedSyncResult {
  readonly pages: number;
  readonly objects: number;
  readonly hasMore: boolean;
  readonly error: boolean;
}

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 10;
export const INITIAL_FEED_CURSOR: FeedCursor = {
  created_at: '0001-01-01T00:00:00.000Z',
  object_id: ''
};
const inFlightByPeer = new Map<string, Promise<FeedSyncResult>>();

export function syncFeedFromPeer(options: FeedSyncOptions): Promise<FeedSyncResult> {
  const running = inFlightByPeer.get(options.peerId);
  if (running) return running;

  const sync = runFeedSync(options).finally(() => {
    if (inFlightByPeer.get(options.peerId) === sync) {
      inFlightByPeer.delete(options.peerId);
    }
  });
  inFlightByPeer.set(options.peerId, sync);
  return sync;
}

async function runFeedSync(options: FeedSyncOptions): Promise<FeedSyncResult> {
  const limit = normalizePositiveInteger(options.limit, DEFAULT_PAGE_LIMIT);
  const maxPages = normalizePositiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
  let cursor: FeedCursor | null;
  try {
    cursor = await options.loadCursor(options.peerId);
  } catch {
    return { pages: 0, objects: 0, hasMore: false, error: true };
  }
  let pages = 0;
  let objects = 0;
  let hasMore = false;

  while (pages < maxPages) {
    let page: FeedSyncPage;
    try {
      page = await options.requestPage(options.peerId, cursor ?? INITIAL_FEED_CURSOR, limit);
    } catch {
      return { pages, objects, hasMore, error: true };
    }

    pages += 1;
    if (page.objects.length === 0) {
      return { pages, objects, hasMore: false, error: false };
    }

    try {
      await options.storeObjects(page.objects);
    } catch {
      return { pages, objects, hasMore: page.has_more, error: true };
    }
    objects += page.objects.length;

    const nextCursor = page.next_cursor;
    let advancesCursor = false;
    if (nextCursor !== null && (cursor === null || compareFeedKey(nextCursor, cursor) > 0)) {
      try {
        await options.saveCursor(options.peerId, nextCursor);
      } catch {
        return { pages, objects, hasMore: page.has_more, error: true };
      }
      cursor = nextCursor;
      advancesCursor = true;
    }

    hasMore = page.has_more;
    if (!hasMore) return { pages, objects, hasMore: false, error: false };

    if (!advancesCursor) {
      return { pages, objects, hasMore: true, error: true };
    }
  }

  return { pages, objects, hasMore, error: false };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
