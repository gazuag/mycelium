import { isObjectExpired, validateDistributedObject } from './envelope';
import type { DistributedObject, FindQueryCriteria, ObjectStore } from './types';

export type InboxFetchPage = (criteria: FindQueryCriteria) => Promise<DistributedObject[]>;

export async function fetchAllPages({
  fetchPage,
  criteria,
  pageSize = 500,
  maxPages = 20
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

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(pageCriteria);
    let newObjectCount = 0;
    for (const object of page) {
      if (seenObjectIds.has(object.object_id)) continue;
      seenObjectIds.add(object.object_id);
      objects.push(object);
      newObjectCount += 1;
    }

    if (page.length < pageSize) break;
    if (newObjectCount === 0) {
      truncated = true;
      break;
    }
    if (pageNumber === maxPages - 1) {
      truncated = true;
      break;
    }

    const oldestObject = page.reduce((oldest, object) =>
      Date.parse(object.created_at) < Date.parse(oldest.created_at) ? object : oldest
    );
    pageCriteria = { ...baseCriteria, created_before: oldestObject.created_at };
  }

  return { objects, truncated };
}

export async function syncInbox({
  myPublicKey,
  cursor,
  store,
  fetchPage,
  now = () => new Date(),
  overlapMs = 48 * 60 * 60 * 1000
}: {
  myPublicKey: string;
  cursor: string | null;
  store: ObjectStore;
  fetchPage: InboxFetchPage;
  now?: () => Date;
  overlapMs?: number;
}): Promise<{ stored: DistributedObject[]; cursor: string | null; truncated: boolean }> {
  const criteria: FindQueryCriteria = {
    recipient: myPublicKey,
    order: 'created_at_desc',
    limit: 500,
    ...(cursor === null ? {} : { created_after: new Date(Date.parse(cursor) - overlapMs).toISOString() })
  };
  const { objects, truncated } = await fetchAllPages({ fetchPage, criteria });
  const currentTime = now();
  const accepted: DistributedObject[] = [];

  for (const object of objects) {
    if (object.recipient !== myPublicKey || isObjectExpired(object, currentTime)) continue;
    if (!(await validateDistributedObject(object))) continue;
    accepted.push(object);
  }

  const stored: DistributedObject[] = [];
  for (const object of accepted) {
    if (await store.put(object)) stored.push(object);
  }

  if (truncated || accepted.length === 0) return { stored, cursor, truncated };

  const newestAcceptedTime = Math.max(...accepted.map((object) => Date.parse(object.created_at)));
  const boundedTime = Math.min(newestAcceptedTime, currentTime.getTime());
  const previousTime = cursor === null ? Number.NEGATIVE_INFINITY : Date.parse(cursor);
  const nextCursor = new Date(Math.max(previousTime, boundedTime)).toISOString();
  return { stored, cursor: nextCursor, truncated };
}