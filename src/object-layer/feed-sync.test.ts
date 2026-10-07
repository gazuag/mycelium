import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_FEED_CURSOR, syncFeedFromPeer } from './feed-sync';
import type { DistributedObject, FeedCursor } from './types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncFeedFromPeer', () => {
  it('starts from the initial sentinel and saves the first page cursor', async () => {
    const newest = objectAt(3);
    const saved: FeedCursor[] = [];
    const result = await syncFeedFromPeer({
      peerId: 'first-sync',
      loadCursor: () => null,
      saveCursor: (_peerId, cursor) => { saved.push(cursor); },
      requestPage: async (_peerId, after) => {
        expect(after).toEqual(INITIAL_FEED_CURSOR);
        return page([newest], cursorFor(newest), false);
      },
      storeObjects: async () => {}
    });

    expect(saved).toEqual([cursorFor(newest)]);
    expect(result).toEqual({ pages: 1, objects: 1, hasMore: false, error: false });
  });

  it('fetches multiple pages until has_more is false and saves the final cursor', async () => {
    const first = objectAt(1);
    const second = objectAt(2);
    const cursors: Array<FeedCursor | null> = [];
    const saved: FeedCursor[] = [];
    const responses = [page([first], cursorFor(first), true), page([second], cursorFor(second), false)];
    let responseIndex = 0;

    const result = await syncFeedFromPeer({
      peerId: 'multi-page',
      loadCursor: () => null,
      saveCursor: (_peerId, cursor) => { saved.push(cursor); },
      requestPage: async (_peerId, after) => {
        cursors.push(after);
        return responses[responseIndex++];
      },
      storeObjects: async () => {}
    });

    expect(cursors).toEqual([INITIAL_FEED_CURSOR, cursorFor(first)]);
    expect(saved).toEqual([cursorFor(first), cursorFor(second)]);
    expect(result).toEqual({ pages: 2, objects: 2, hasMore: false, error: false });
  });

  it('stores each page before saving its cursor', async () => {
    const object = objectAt(1);
    const events: string[] = [];

    await syncFeedFromPeer({
      peerId: 'store-before-cursor',
      loadCursor: () => null,
      saveCursor: () => { events.push('save'); },
      requestPage: async () => page([object], cursorFor(object), false),
      storeObjects: async () => { events.push('store'); }
    });

    expect(events).toEqual(['store', 'save']);
  });

  it('keeps the old cursor and reports an error when storing fails', async () => {
    const oldCursor = cursorAt(1);
    const nextObject = objectAt(2);
    const saveCursor = vi.fn();
    const result = await syncFeedFromPeer({
      peerId: 'store-failure',
      loadCursor: () => oldCursor,
      saveCursor,
      requestPage: async () => page([nextObject], cursorFor(nextObject), false),
      storeObjects: async () => { throw new Error('storage unavailable'); }
    });

    expect(saveCursor).not.toHaveBeenCalled();
    expect(result).toEqual({ pages: 1, objects: 0, hasMore: false, error: true });
  });

  it('keeps the last successfully saved cursor when a later request fails', async () => {
    const first = objectAt(2);
    const initialCursor = cursorAt(1);
    const saved: FeedCursor[] = [];
    let calls = 0;

    const result = await syncFeedFromPeer({
      peerId: 'request-failure',
      loadCursor: () => initialCursor,
      saveCursor: (_peerId, cursor) => { saved.push(cursor); },
      requestPage: async () => {
        calls += 1;
        if (calls === 1) return page([first], cursorFor(first), true);
        throw new Error('request failed');
      },
      storeObjects: async () => {}
    });

    expect(saved).toEqual([cursorFor(first)]);
    expect(result).toEqual({ pages: 1, objects: 1, hasMore: true, error: true });
  });

  it('never moves a cursor backwards', async () => {
    const oldCursor = cursorAt(5);
    const olderObject = objectAt(4);
    const saveCursor = vi.fn();

    const result = await syncFeedFromPeer({
      peerId: 'backwards-cursor',
      loadCursor: () => oldCursor,
      saveCursor,
      requestPage: async () => page([olderObject], cursorFor(olderObject), false),
      storeObjects: async () => {}
    });

    expect(saveCursor).not.toHaveBeenCalled();
    expect(result).toEqual({ pages: 1, objects: 1, hasMore: false, error: false });
  });

  it('stops at maxPages and resumes the next run from its saved cursor', async () => {
    const first = objectAt(1);
    const second = objectAt(2);
    let savedCursor: FeedCursor | null = null;
    const requested: Array<FeedCursor | null> = [];
    const run = (object: DistributedObject, hasMore: boolean) => syncFeedFromPeer({
      peerId: 'page-budget',
      loadCursor: () => savedCursor,
      saveCursor: (_peerId, cursor) => { savedCursor = cursor; },
      requestPage: async (_peerId, after) => {
        requested.push(after);
        return page([object], cursorFor(object), hasMore);
      },
      storeObjects: async () => {},
      maxPages: 1
    });

    const firstRun = await run(first, true);
    const secondRun = await run(second, false);

    expect(firstRun).toEqual({ pages: 1, objects: 1, hasMore: true, error: false });
    expect(secondRun).toEqual({ pages: 1, objects: 1, hasMore: false, error: false });
    expect(requested).toEqual([INITIAL_FEED_CURSOR, cursorFor(first)]);
    expect(savedCursor).toEqual(cursorFor(second));
  });

  it('stops when a page is empty', async () => {
    const requestPage = vi.fn(async () => page([], null, true));

    const result = await syncFeedFromPeer({
      peerId: 'empty-page',
      loadCursor: () => null,
      saveCursor: () => {},
      requestPage,
      storeObjects: async () => {}
    });

    expect(requestPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pages: 1, objects: 0, hasMore: false, error: false });
  });

  it('shares one in-flight run for overlapping calls from the same peer', async () => {
    const object = objectAt(1);
    let resolveRequest!: (value: ReturnType<typeof page>) => void;
    const requestResult = new Promise<ReturnType<typeof page>>((resolve) => { resolveRequest = resolve; });
    const requestPage = vi.fn(() => requestResult);
    const options = {
      peerId: 'single-flight',
      loadCursor: () => null,
      saveCursor: () => {},
      requestPage,
      storeObjects: async () => {}
    };

    const firstRun = syncFeedFromPeer(options);
    const overlappingRun = syncFeedFromPeer(options);
    expect(overlappingRun).toBe(firstRun);
    await Promise.resolve();
    expect(requestPage).toHaveBeenCalledTimes(1);
    resolveRequest(page([object], cursorFor(object), false));
    await expect(Promise.all([firstRun, overlappingRun])).resolves.toEqual([
      { pages: 1, objects: 1, hasMore: false, error: false },
      { pages: 1, objects: 1, hasMore: false, error: false }
    ]);
  });

  it('does not log objects or their contents', async () => {
    const secretText = 'never-log-this-feed-object';
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const object = { ...objectAt(1), payload: { content: secretText } };

    await syncFeedFromPeer({
      peerId: 'no-object-logging',
      loadCursor: () => null,
      saveCursor: () => {},
      requestPage: async () => page([object], cursorFor(object), false),
      storeObjects: async () => {}
    });

    for (const spy of [log, warn, error]) {
      expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secretText);
    }
  });

  it('does not write myceliumHomeSync localStorage cursor keys', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(appSource).not.toContain('myceliumHomeSync');
  });
});

function cursorAt(minute: number): FeedCursor {
  return { created_at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), object_id: `object-${minute}` };
}

function objectAt(minute: number): DistributedObject {
  return {
    object_id: `object-${minute}`,
    object_type: 'mycelium.post',
    author: 'author',
    created_at: cursorAt(minute).created_at,
    payload: {},
    signature: 'signature',
    replication_policy: {}
  };
}

function cursorFor(object: DistributedObject): FeedCursor {
  return { created_at: object.created_at, object_id: object.object_id };
}

function page(objects: DistributedObject[], next_cursor: FeedCursor | null, has_more: boolean) {
  return { objects, next_cursor, has_more };
}
