import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createSignedObject } from './envelope';
import { createObjectIdentity } from './identity';
import { fetchAllPages, syncInbox } from './inbox-sync';
import type { DistributedObject, FindQueryCriteria, ObjectContent, ObjectIdentity, ObjectStore } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const MY_PUBLIC_KEY = 'inbox-recipient';
const NOW = new Date('2026-10-04T12:00:00.000Z');
let signingIdentity: ObjectIdentity;

beforeAll(async () => {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  signingIdentity = createObjectIdentity({ id: 'inbox-sync-test', publicKey, privateKey });
});

async function createInboxObject(options: {
  id: string;
  createdAt?: string;
  recipient?: string;
  expiresAt?: string;
}): Promise<DistributedObject> {
  const content: ObjectContent = {
    object_type: 'mycelium.dm',
    created_at: options.createdAt ?? '2026-10-04T10:00:00.000Z',
    recipient: options.recipient ?? MY_PUBLIC_KEY,
    ...(options.expiresAt === undefined ? {} : { expires_at: options.expiresAt }),
    payload: { id: options.id },
    replication_policy: {}
  };
  return createSignedObject(content, signingIdentity);
}

function pageObject(id: string, createdAt: string): DistributedObject {
  return {
    object_id: id,
    object_type: 'test',
    author: 'author',
    created_at: createdAt,
    payload: {},
    signature: '',
    replication_policy: {}
  };
}

function createStore(put: (object: DistributedObject) => Promise<boolean> = async () => true): ObjectStore {
  return {
    put,
    get: async () => null,
    delete: async () => undefined,
    query: async () => []
  };
}

function completePage(objects: DistributedObject[], hasMore = false) {
  return { objects, complete: true, paginationSupported: true, hasMore };
}

describe('fetchAllPages', () => {
  it('pages across three pages and deduplicates object IDs', async () => {
    const pages = [
      [pageObject('a', '2026-10-04T10:00:00.000Z'), pageObject('b', '2026-10-04T09:00:00.000Z')],
      [pageObject('b', '2026-10-04T09:00:00.000Z'), pageObject('c', '2026-10-04T08:00:00.000Z')],
      [pageObject('d', '2026-10-04T07:00:00.000Z')]
    ];
    const fetchPage = vi.fn(async (_criteria: FindQueryCriteria) => {
      const page = pages.shift() ?? [];
      return completePage(page, page.length === 2);
    });

    const result = await fetchAllPages({ fetchPage, criteria: { recipient: MY_PUBLIC_KEY }, pageSize: 2 });

    expect(result.objects.map((object) => object.object_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.truncated).toBe(false);
    expect(fetchPage.mock.calls[0][0]).toEqual({ recipient: MY_PUBLIC_KEY, order: 'created_at_desc', limit: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('pages through more than one page of tied timestamps using the compound cursor', async () => {
    const tiedAt = '2026-10-04T10:00:00.000Z';
    const objects = ['a', 'b', 'c', 'd', 'e'].map((id) => pageObject(id, tiedAt));
    const fetchPage = vi.fn(async (criteria: FindQueryCriteria) => {
      const matching = objects
        .filter((object) => !criteria.page_before
          || object.object_id.localeCompare(criteria.page_before.object_id) < 0)
        .sort((left, right) => right.object_id.localeCompare(left.object_id));
      return completePage(matching.slice(0, 2), matching.length > 2);
    });

    const result = await fetchAllPages({ fetchPage, criteria: {}, pageSize: 2 });

    expect(fetchPage.mock.calls[1][0].page_before).toEqual({ created_at: tiedAt, object_id: 'd' });
    expect(result.objects.map((object) => object.object_id)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('does not treat an old peer response as supporting a compound pagination cursor', async () => {
    const tiedAt = '2026-10-04T10:00:00.000Z';
    const page = [pageObject('e', tiedAt), pageObject('d', tiedAt)];
    const fetchPage = vi.fn(async () => ({ objects: page, complete: true }));

    const result = await fetchAllPages({ fetchPage, criteria: {}, pageSize: 2 });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.objects).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('continues when a short merged page reports more results', async () => {
    const first = pageObject('first', '2026-10-04T10:00:00.000Z');
    const second = pageObject('second', '2026-10-04T09:00:00.000Z');
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(completePage([first], true))
      .mockResolvedValueOnce(completePage([second], false));

    const result = await fetchAllPages({ fetchPage, criteria: {}, pageSize: 2 });

    expect(result.objects.map((object) => object.object_id)).toEqual(['first', 'second']);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops on a short page', async () => {
    const fetchPage = vi.fn(async () => [pageObject('a', '2026-10-04T10:00:00.000Z')]);

    const result = await fetchAllPages({ fetchPage, criteria: {}, pageSize: 2 });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
  });

  it('stops and marks truncated when a full page yields no new object IDs', async () => {
    const page = [pageObject('a', '2026-10-04T10:00:00.000Z'), pageObject('b', '2026-10-04T09:00:00.000Z')];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page);

    const result = await fetchAllPages({ fetchPage, criteria: {}, pageSize: 2 });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.objects).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('marks truncated when maxPages is reached', async () => {
    let page = 0;
    const fetchPage = vi.fn(async () => {
      page += 1;
      return [pageObject(`object-${page}`, `2026-10-04T${String(12 - page).padStart(2, '0')}:00:00.000Z`)];
    });

    const result = await fetchAllPages({ fetchPage, criteria: {}, pageSize: 1, maxPages: 2 });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.objects).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('syncInbox', () => {
  it('performs a full pull without created_after when cursor is null', async () => {
    const fetchPage = vi.fn(async (_criteria: FindQueryCriteria) => []);

    await syncInbox({ myPublicKey: MY_PUBLIC_KEY, cursor: null, store: createStore(), fetchPage, now: () => NOW });

    expect(fetchPage.mock.calls[0][0]).toEqual({ recipient: MY_PUBLIC_KEY, order: 'created_at_desc', limit: 500 });
    expect(fetchPage.mock.calls[0][0]).not.toHaveProperty('created_after');
  });

  it('uses the recent cursor window and a separate retained-history backfill slice', async () => {
    const fetchPage = vi.fn(async (_criteria: FindQueryCriteria) => []);

    await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: '2026-10-04T12:00:00.000Z',
      store: createStore(),
      fetchPage,
      now: () => NOW
    });

    expect(fetchPage.mock.calls[0][0].created_after).toBe('2026-10-02T12:00:00.000Z');
    expect(fetchPage.mock.calls[1][0].created_before).toBeDefined();
    expect(fetchPage.mock.calls[1][0].created_after).toBeDefined();
  });

  it('does not report overlap-refetched objects as newly stored', async () => {
    const object = await createInboxObject({ id: 'overlap', createdAt: '2026-10-04T11:00:00.000Z' });
    const put = vi.fn(async () => false);
    const fetchPage = vi.fn(async () => [object]);

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: '2026-10-04T11:30:00.000Z',
      store: createStore(put),
      fetchPage,
      now: () => NOW
    });

    expect(put).toHaveBeenCalledWith(object);
    expect(result.stored).toEqual([]);
    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('stores fetched objects but leaves the cursor unchanged when truncated', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';
    const object = await createInboxObject({ id: 'truncated-run', createdAt: '2026-10-04T11:00:00.000Z' });
    const put = vi.fn(async () => true);
    const fetchPage = vi.fn(async () => Array.from({ length: 500 }, () => object));

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor,
      store: createStore(put),
      fetchPage,
      now: () => NOW
    });

    expect(result.truncated).toBe(true);
    expect(result.stored).toEqual([object]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(result.cursor).toBe(cursor);
  });

  it('advances the cursor for a complete search even when no new DM is found', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';
    const object = await createInboxObject({ id: 'complete-run', createdAt: '2026-10-04T11:00:00.000Z' });

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor,
      store: createStore(),
      fetchPage: async () => [object],
      now: () => NOW
    });

    expect(result.truncated).toBe(false);
    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('deduplicates stored objects on a second run after truncation', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';
    const object = await createInboxObject({ id: 'truncated-then-retry', createdAt: '2026-10-04T11:00:00.000Z' });
    const storedIds = new Set<string>();
    const put = vi.fn(async (value: DistributedObject) => {
      if (storedIds.has(value.object_id)) return false;
      storedIds.add(value.object_id);
      return true;
    });
    const store = createStore(put);
    const truncatedFetch = async () => Array.from({ length: 500 }, () => object);

    const firstRun = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor,
      store,
      fetchPage: truncatedFetch,
      now: () => NOW
    });
    const secondRun = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: firstRun.cursor,
      store,
      fetchPage: async () => [object],
      now: () => NOW
    });

    expect(firstRun.truncated).toBe(true);
    expect(firstRun.stored).toEqual([object]);
    expect(firstRun.cursor).toBe(cursor);
    expect(secondRun.truncated).toBe(false);
    expect(secondRun.stored).toEqual([]);
    expect(secondRun.cursor).toBe(NOW.toISOString());
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('skips objects with an invalid signature', async () => {
    const valid = await createInboxObject({ id: 'bad-signature' });
    const invalid = { ...valid, payload: { id: 'tampered' } };
    const put = vi.fn(async () => true);

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: null,
      store: createStore(put),
      fetchPage: async () => [invalid],
      now: () => NOW
    });

    expect(put).not.toHaveBeenCalled();
    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('skips objects addressed to another recipient', async () => {
    const object = await createInboxObject({ id: 'wrong-recipient', recipient: 'someone-else' });
    const put = vi.fn(async () => true);

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: null,
      store: createStore(put),
      fetchPage: async () => [object],
      now: () => NOW
    });

    expect(put).not.toHaveBeenCalled();
    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('skips expired objects', async () => {
    const object = await createInboxObject({ id: 'expired', expiresAt: '2026-10-04T11:59:59.999Z' });
    const put = vi.fn(async () => true);

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: null,
      store: createStore(put),
      fetchPage: async () => [object],
      now: () => NOW
    });

    expect(put).not.toHaveBeenCalled();
    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('does not advance the cursor beyond now for future-dated objects', async () => {
    const object = await createInboxObject({ id: 'future', createdAt: '2026-10-05T12:00:00.000Z' });

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: null,
      store: createStore(),
      fetchPage: async () => [object],
      now: () => NOW
    });

    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('advances the high-water cursor to the completed search time', async () => {
    const cursor = '2026-10-04T11:30:00.000Z';
    const object = await createInboxObject({ id: 'older', createdAt: '2026-10-04T10:00:00.000Z' });

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor,
      store: createStore(),
      fetchPage: async () => [object],
      now: () => NOW
    });

    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('rethrows put failures before returning an advanced cursor', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';
    const object = await createInboxObject({ id: 'put-failure', createdAt: '2026-10-04T11:00:00.000Z' });
    const error = new Error('store write failed');
    const put = vi.fn(async () => { throw error; });
    let persistedCursor = cursor;

    await expect(syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor,
      store: createStore(put),
      fetchPage: async () => [object],
      now: () => NOW
    }).then((result) => { persistedCursor = result.cursor ?? cursor; })).rejects.toBe(error);

    expect(persistedCursor).toBe(cursor);
  });

  it('advances the cursor after a complete empty search', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor,
      store: createStore(),
      fetchPage: async () => [],
      now: () => NOW
    });

    expect(result.stored).toEqual([]);
    expect(result.cursor).toBe(NOW.toISOString());
  });

  it('retrieves a DM older than the recent overlap when a backfill slice discovers it', async () => {
    const lateMessage = await createInboxObject({
      id: 'late-handoff',
      createdAt: '2026-09-20T12:00:00.000Z'
    });
    const alreadySeenNewer = await createInboxObject({
      id: 'already-seen-newer',
      createdAt: '2026-10-04T11:00:00.000Z'
    });
    const existingIds = new Set([alreadySeenNewer.object_id]);
    const put = vi.fn(async (object: DistributedObject) => {
      if (existingIds.has(object.object_id)) return false;
      existingIds.add(object.object_id);
      return true;
    });
    const backfillState = {
      cursor: '2026-09-20T11:00:00.000Z',
      end: '2026-10-04T12:00:00.000Z'
    };
    const fetchPage = vi.fn(async (criteria: FindQueryCriteria) => (
      criteria.created_before ? [lateMessage] : [alreadySeenNewer]
    ));

    const result = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: NOW.toISOString(),
      backfillState,
      store: createStore(put),
      fetchPage,
      now: () => NOW
    });

    expect(fetchPage.mock.calls[0][0].created_after).toBe(
      new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString()
    );
    expect(fetchPage.mock.calls[1][0].created_after).toBe('2026-09-20T10:59:59.999Z');
    expect(result.stored).toEqual([lateMessage]);
    expect(result.truncated).toBe(false);
  });

  it('retains cursors on incomplete FIND and advances them after the later complete retry', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';
    const missingMessage = await createInboxObject({
      id: 'retried-after-incomplete',
      createdAt: '2026-09-20T12:00:00.000Z'
    });
    const backfillState = {
      cursor: '2026-09-20T11:00:00.000Z',
      end: '2026-10-04T12:00:00.000Z'
    };
    const store = createStore();
    const incomplete = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor,
      backfillState,
      store,
      fetchPage: async (criteria) => criteria.created_before
        ? { ...completePage([], false), complete: false }
        : completePage([]),
      now: () => NOW
    });

    expect(incomplete.truncated).toBe(true);
    expect(incomplete.cursor).toBe(cursor);
    expect(incomplete.backfillState).toEqual(backfillState);

    const complete = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: incomplete.cursor,
      backfillState: incomplete.backfillState,
      store,
      fetchPage: async (criteria) => criteria.created_before
        ? completePage([missingMessage])
        : completePage([]),
      now: () => NOW
    });

    expect(complete.truncated).toBe(false);
    expect(complete.stored).toEqual([missingMessage]);
    expect(complete.cursor).toBe(NOW.toISOString());
    expect(complete.backfillState?.cursor).toBe('2026-09-21T11:00:00.000Z');
  });

  it('keeps an empty complete FIND distinct from an incomplete search', async () => {
    const completeEmpty = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: '2026-10-04T09:00:00.000Z',
      store: createStore(),
      fetchPage: async () => completePage([]),
      now: () => NOW
    });
    const incompleteEmpty = await syncInbox({
      myPublicKey: MY_PUBLIC_KEY,
      cursor: '2026-10-04T09:00:00.000Z',
      store: createStore(),
      fetchPage: async () => ({ ...completePage([]), complete: false }),
      now: () => NOW
    });

    expect(completeEmpty.truncated).toBe(false);
    expect(completeEmpty.cursor).toBe(NOW.toISOString());
    expect(incompleteEmpty.truncated).toBe(true);
    expect(incompleteEmpty.cursor).toBe('2026-10-04T09:00:00.000Z');
  });
});