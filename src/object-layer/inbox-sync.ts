import { isObjectExpired, validateDistributedObject } from './envelope';
import { DM_TTL_MS } from './dm-object';
import { compareObjectsByCreatedAtDesc } from './transport';
import type { DistributedObject, FindQueryCriteria, ObjectStore } from './types';

const MAX_INBOX_PAGES = 20;
const INBOX_PAGE_SIZE = 500;
const BACKFILL_SLICE_MS = 24 * 60 * 60 * 1000;

export interface InboxBackfillState {
  readonly cursor: string;
  readonly end: string;
}

export type InboxPage = DistributedObject[] | {
  objects: DistributedObject[];
  complete: boolean;
  paginationSupported?: boolean;
  hasMore?: boolean;
};
export type InboxFetchPage = (criteria: FindQueryCriteria) => Promise<InboxPage>;

export async function fetchAllPages({
  fetchPage,
  criteria,
  pageSize = INBOX_PAGE_SIZE,
  maxPages = MAX_INBOX_PAGES
}: {
  fetchPage: InboxFetchPage;
  criteria: FindQueryCriteria;
  pageSize?: number;
  maxPages?: number;
}): Promise<{ objects: DistributedObject[]; truncated: boolean }> {
  const baseCriteria: FindQueryCriteria = { ...criteria, order: 'created_at_desc', limit: pageSize };
  const objects: DistributedObject[] = [];
  const seenObjectIds = new Set<string>();
  let pageCriteria = baseCriteria;
  let truncated = maxPages <= 0;
  let complete = true;
  const requiresPaginationMetadata = baseCriteria.order === 'created_at_desc' && baseCriteria.limit !== undefined;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const pageResult = await fetchPage(pageCriteria);
    const page = Array.isArray(pageResult) ? pageResult : pageResult.objects;
    if (!Array.isArray(pageResult) && !pageResult.complete) {
      complete = false;
    }
    if (requiresPaginationMetadata && !Array.isArray(pageResult)
      && (!pageResult.paginationSupported || typeof pageResult.hasMore !== 'boolean')) {
      complete = false;
    }
    let newObjectCount = 0;
    for (const object of page) {
      if (seenObjectIds.has(object.object_id)) continue;
      seenObjectIds.add(object.object_id);
      objects.push(object);
      newObjectCount += 1;
    }

    if (!complete) break;
    const hasMore = Array.isArray(pageResult)
      ? page.length >= pageSize
      : pageResult.hasMore === true;
    if (!hasMore) break;
    if (newObjectCount === 0) {
      truncated = true;
      break;
    }
    if (pageNumber === maxPages - 1) {
      truncated = true;
      break;
    }

    const lastObject = page.reduce((last, object) =>
      compareObjectsByCreatedAtDesc(object, last) > 0 ? object : last
    );
    pageCriteria = {
      ...baseCriteria,
      page_before: { created_at: lastObject.created_at, object_id: lastObject.object_id }
    };
  }

  return { objects, truncated: truncated || !complete };
}

export async function syncInbox({
  myPublicKey,
  cursor,
  backfillState = null,
  store,
  fetchPage,
  now = () => new Date(),
  overlapMs = 48 * 60 * 60 * 1000
}: {
  myPublicKey: string;
  cursor: string | null;
  backfillState?: InboxBackfillState | null;
  store: ObjectStore;
  fetchPage: InboxFetchPage;
  now?: () => Date;
  overlapMs?: number;
}): Promise<{
  stored: DistributedObject[];
  cursor: string | null;
  backfillState: InboxBackfillState | null;
  incrementalComplete: boolean;
  backfillComplete: boolean;
  truncated: boolean;
}> {
  const currentTime = now();
  const incrementalCriteria: FindQueryCriteria = {
    recipient: myPublicKey,
    order: 'created_at_desc',
    limit: INBOX_PAGE_SIZE,
    ...(cursor === null ? {} : { created_after: new Date(Date.parse(cursor) - overlapMs).toISOString() })
  };
  const storedIds = new Set<string>();
  const incremental = await fetchAndStore(incrementalCriteria);
  const incrementalComplete = !incremental.truncated;
  const stored = [...incremental.stored];
  stored.forEach((object) => storedIds.add(object.object_id));
  const previousTime = cursor === null ? Number.NEGATIVE_INFINITY : Date.parse(cursor);
  let nextCursor = cursor;

  const oldestRetainedTime = currentTime.getTime() - DM_TTL_MS;
  let activeBackfill = backfillState;
  if (!activeBackfill || Date.parse(activeBackfill.end) < oldestRetainedTime) {
    const end = currentTime.toISOString();
    activeBackfill = {
      cursor: new Date(oldestRetainedTime).toISOString(),
      end
    };
  }
  const backfillStart = Math.max(Date.parse(activeBackfill.cursor), oldestRetainedTime);
  const backfillEnd = Date.parse(activeBackfill.end);
  if (backfillStart >= backfillEnd) activeBackfill = null;

  let backfillComplete = true;
  let nextBackfillState = activeBackfill;
  if (activeBackfill) {
    const startTime = Math.max(Date.parse(activeBackfill.cursor), oldestRetainedTime);
    const endTime = Math.min(startTime + BACKFILL_SLICE_MS, Date.parse(activeBackfill.end));
    const backfillCriteria: FindQueryCriteria = {
      recipient: myPublicKey,
      order: 'created_at_desc',
      limit: INBOX_PAGE_SIZE,
      created_after: new Date(startTime - 1).toISOString(),
      created_before: new Date(endTime).toISOString()
    };
    const backfill = await fetchAndStore(backfillCriteria);
    stored.push(...backfill.stored);
    backfillComplete = !backfill.truncated;
    if (backfillComplete) {
      nextBackfillState = endTime >= Date.parse(activeBackfill.end)
        ? null
        : { cursor: new Date(endTime).toISOString(), end: activeBackfill.end };
    }
  }
  if (incrementalComplete && backfillComplete) {
    nextCursor = new Date(Math.max(previousTime, currentTime.getTime())).toISOString();
  }

  return {
    stored,
    cursor: nextCursor,
    backfillState: nextBackfillState,
    incrementalComplete,
    backfillComplete,
    truncated: !incrementalComplete || !backfillComplete
  };

  async function fetchAndStore(criteria: FindQueryCriteria): Promise<{
    stored: DistributedObject[];
    truncated: boolean;
  }> {
    const { objects, truncated } = await fetchAllPages({ fetchPage, criteria });
    const accepted: DistributedObject[] = [];
    for (const object of objects) {
      if (object.recipient !== myPublicKey || isObjectExpired(object, currentTime)) continue;
      if (!(await validateDistributedObject(object))) continue;
      accepted.push(object);
    }
    const stored: DistributedObject[] = [];
    for (const object of accepted) {
      if (storedIds.has(object.object_id)) continue;
      storedIds.add(object.object_id);
      if (await store.put(object)) stored.push(object);
    }
    return { stored, truncated };
  }
}