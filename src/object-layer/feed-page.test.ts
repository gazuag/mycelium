import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createSignedObject } from './envelope';
import { createObjectIdentity } from './identity';
import { compareFeedKey, queryFeedPage, type FeedCursor } from './feed-page';
import type { DistributedObject, ObjectIdentity, ObjectStore } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

let authorIdentity: ObjectIdentity;
let otherIdentity: ObjectIdentity;

beforeAll(async () => {
  authorIdentity = await makeIdentity('author');
  otherIdentity = await makeIdentity('other');
});

describe('queryFeedPage', () => {
  it('orders posts and recommendations together by the combined feed key', async () => {
    const store = createMemoryStore();
    const post = await makeObject(authorIdentity, 'mycelium.post', at(1), 'post');
    const recommendation = await makeObject(authorIdentity, 'mycelium.recommendation', at(2), 'recommendation');
    const laterPost = await makeObject(authorIdentity, 'mycelium.post', at(3), 'later-post');
    await add(store, laterPost, recommendation, post);

    const page = await queryFeedPage(store, authorIdentity.publicKey, { limit: 10 });

    expect(page.objects.map(({ object_id }) => object_id)).toEqual([post.object_id, recommendation.object_id, laterPost.object_id]);
    expect(page.next_cursor).toEqual(cursor(laterPost));
  });

  it('uses object_id to order equal timestamps without skipping or duplicating a page boundary', async () => {
    const store = createMemoryStore();
    const objects = await Promise.all(
      ['a', 'b', 'c', 'd'].map((marker) => makeObject(authorIdentity, 'mycelium.post', at(1), marker))
    );
    await add(store, ...objects);
    const expected = [...objects].sort((left, right) => compareFeedKey(cursor(left), cursor(right)));
    const first = await queryFeedPage(store, authorIdentity.publicKey, { after: { created_at: at(0), object_id: '' }, limit: 2 });
    const second = await queryFeedPage(store, authorIdentity.publicKey, { after: first.next_cursor, limit: 2 });

    expect(first.objects.map(({ object_id }) => object_id)).toEqual(expected.slice(0, 2).map(({ object_id }) => object_id));
    expect(second.objects.map(({ object_id }) => object_id)).toEqual(expected.slice(2).map(({ object_id }) => object_id));
    expect(new Set([...first.objects, ...second.objects].map(({ object_id }) => object_id)).size).toBe(4);
    expect(compareFeedKey(cursor(expected[0]), cursor(expected[1]))).toBeLessThan(0);
  });

  it('returns the newest no-cursor window in ascending order with has_more false', async () => {
    const store = createMemoryStore();
    const objects = await makeChronologicalObjects(5);
    await add(store, ...objects);

    const page = await queryFeedPage(store, authorIdentity.publicKey, { limit: 2 });

    expect(page.objects.map(({ object_id }) => object_id)).toEqual(objects.slice(-2).map(({ object_id }) => object_id));
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toEqual(cursor(objects[4]));
  });

  it('returns strictly newer core objects oldest first when given a cursor', async () => {
    const store = createMemoryStore();
    const objects = await makeChronologicalObjects(5);
    await add(store, ...objects);

    const page = await queryFeedPage(store, authorIdentity.publicKey, { after: cursor(objects[1]), limit: 2 });

    expect(page.objects.map(({ object_id }) => object_id)).toEqual([objects[2].object_id, objects[3].object_id]);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toEqual(cursor(objects[3]));
  });

  it('serves disjoint consecutive keyset pages for sequential requests', async () => {
    const store = createMemoryStore();
    const objects = await makeChronologicalObjects(5);
    await add(store, ...objects);

    const first = await queryFeedPage(store, authorIdentity.publicKey, {
      after: { created_at: at(-1), object_id: '' },
      limit: 2
    });
    const second = await queryFeedPage(store, authorIdentity.publicKey, {
      after: first.next_cursor,
      limit: 2
    });

    expect(first.objects.map(({ object_id }) => object_id)).toEqual(objects.slice(0, 2).map(({ object_id }) => object_id));
    expect(second.objects.map(({ object_id }) => object_id)).toEqual(objects.slice(2, 4).map(({ object_id }) => object_id));
    expect(first.objects.some((object) => second.objects.some((next) => next.object_id === object.object_id))).toBe(false);
  });

  it('continues at the last core key and pages all 450 mixed objects exactly once', async () => {
    const store = createMemoryStore();
    const objects = await Promise.all(Array.from({ length: 450 }, (_, index) =>
      makeObject(
        authorIdentity,
        index % 2 === 0 ? 'mycelium.post' : 'mycelium.recommendation',
        at(index),
        `mixed-${index}`
      )
    ));
    await add(store, ...objects);

    const first = await queryFeedPage(store, authorIdentity.publicKey, { after: { created_at: at(-1), object_id: '' }, limit: 200 });
    const second = await queryFeedPage(store, authorIdentity.publicKey, { after: first.next_cursor, limit: 200 });
    const third = await queryFeedPage(store, authorIdentity.publicKey, { after: second.next_cursor, limit: 200 });
    const all = [...first.objects, ...second.objects, ...third.objects];

    expect(first.has_more).toBe(true);
    expect(second.has_more).toBe(true);
    expect(third.has_more).toBe(false);
    expect(first.objects).toHaveLength(200);
    expect(second.objects).toHaveLength(200);
    expect(third.objects).toHaveLength(50);
    expect(all.map(({ object_id }) => object_id)).toEqual(objects.map(({ object_id }) => object_id));
    expect(new Set(all.map(({ object_id }) => object_id)).size).toBe(450);
    expect(first.next_cursor).toEqual(cursor(objects[199]));
    expect(second.next_cursor).toEqual(cursor(objects[399]));
    expect(third.next_cursor).toEqual(cursor(objects[449]));
  });

  it('does not advance past unreturned recommendations when posts fit under the page cap', async () => {
    const store = createMemoryStore();
    const post = await makeObject(authorIdentity, 'mycelium.post', at(0), 'only-post');
    const recommendations = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      makeObject(authorIdentity, 'mycelium.recommendation', at(index + 1), `rec-${index}`)
    ));
    await add(store, post, ...recommendations);

    const first = await queryFeedPage(store, authorIdentity.publicKey, { after: { created_at: at(-1), object_id: '' }, limit: 3 });
    const second = await queryFeedPage(store, authorIdentity.publicKey, { after: first.next_cursor, limit: 3 });

    expect(first.objects.map(({ object_id }) => object_id)).toEqual([post.object_id, recommendations[0].object_id, recommendations[1].object_id]);
    expect(first.next_cursor).toEqual(cursor(recommendations[1]));
    expect(first.has_more).toBe(true);
    expect(second.objects.map(({ object_id }) => object_id)).toEqual(recommendations.slice(2).map(({ object_id }) => object_id));
    expect(second.next_cursor).toEqual(cursor(recommendations[4]));
  });

  it('attaches referenced older posts as extras without moving the cursor', async () => {
    const store = createMemoryStore();
    const olderPost = await makeObject(authorIdentity, 'mycelium.post', at(0), 'referenced-post');
    const recommendation = await makeObject(authorIdentity, 'mycelium.recommendation', at(5), 'recommendation', olderPost.object_id);
    await add(store, olderPost, recommendation);

    const page = await queryFeedPage(store, authorIdentity.publicKey, { after: null, limit: 1 });

    expect(page.objects.map(({ object_id }) => object_id)).toEqual([recommendation.object_id, olderPost.object_id]);
    expect(page.next_cursor).toEqual(cursor(recommendation));
    expect(page.has_more).toBe(false);
  });

  it('caps referenced extras and de-duplicates repeated references', async () => {
    const store = createMemoryStore();
    const posts = await Promise.all(['a', 'b'].map((marker) =>
      makeObject(otherIdentity, 'mycelium.post', at(0), `extra-${marker}`)
    ));
    const recommendations = await Promise.all([
      makeObject(authorIdentity, 'mycelium.recommendation', at(1), 'ref-a-1', posts[0].object_id),
      makeObject(authorIdentity, 'mycelium.recommendation', at(2), 'ref-a-2', posts[0].object_id),
      makeObject(authorIdentity, 'mycelium.recommendation', at(3), 'ref-b', posts[1].object_id)
    ]);
    await add(store, ...posts, ...recommendations);

    const page = await queryFeedPage(store, authorIdentity.publicKey, { after: null, limit: 3 });
    const extras = page.objects.slice(3);

    expect(extras.map(({ object_id }) => object_id)).toEqual(posts.map(({ object_id }) => object_id));
    expect(extras.length).toBeLessThanOrEqual(3);
    expect(new Set(page.objects.map(({ object_id }) => object_id)).size).toBe(page.objects.length);

    const cappedPage = await queryFeedPage(store, authorIdentity.publicKey, { after: null, limit: 2 });
    expect(cappedPage.objects).toHaveLength(4);
    expect(cappedPage.objects.slice(2)).toHaveLength(2);
  });

  it('excludes expired objects and other authors’ unreferenced posts and recommendations', async () => {
    const store = createMemoryStore();
    const validPost = await makeObject(authorIdentity, 'mycelium.post', at(1), 'valid');
    const expiredPost = await makeObject(authorIdentity, 'mycelium.post', at(2), 'expired', undefined, '2000-01-01T00:00:00.000Z');
    const otherPost = await makeObject(otherIdentity, 'mycelium.post', at(3), 'other-post');
    const otherRecommendation = await makeObject(otherIdentity, 'mycelium.recommendation', at(4), 'other-rec');
    await add(store, validPost, expiredPost, otherPost, otherRecommendation);

    const page = await queryFeedPage(store, authorIdentity.publicKey);

    expect(page.objects.map(({ object_id }) => object_id)).toEqual([validPost.object_id]);
  });

  it('defaults invalid limits and clamps valid limits to 200', async () => {
    const store = createMemoryStore();
    const objects = await makeChronologicalObjects(220);
    await add(store, ...objects);

    const clamped = await queryFeedPage(store, authorIdentity.publicKey, { limit: 500 });
    const invalid = await queryFeedPage(store, authorIdentity.publicKey, { after: cursor(objects[0]), limit: 0 });

    expect(clamped.objects).toHaveLength(200);
    expect(clamped.objects[0].object_id).toBe(objects[20].object_id);
    expect(invalid.objects).toHaveLength(100);
    expect(invalid.objects[0].object_id).toBe(objects[1].object_id);
  });

  it('returns an empty page and null cursor for an empty store', async () => {
    const page = await queryFeedPage(createMemoryStore(), authorIdentity.publicKey);

    expect(page).toEqual({ objects: [], next_cursor: null, has_more: false });
  });
});

async function makeIdentity(id: string): Promise<ObjectIdentity> {
  const keys = await generateIdentityKeyPair();
  return createObjectIdentity({
    id,
    publicKey: await exportPublicKey(keys.publicKey),
    privateKey: await exportPrivateKey(keys.privateKey)
  });
}

async function makeObject(
  identity: ObjectIdentity,
  objectType: 'mycelium.post' | 'mycelium.recommendation',
  createdAt: string,
  marker: string,
  postId?: string,
  expiresAt?: string
): Promise<DistributedObject> {
  const sequence = 1;
  return createSignedObject({
    object_type: objectType,
    created_at: createdAt,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(objectType === 'mycelium.recommendation' ? { sequence } : {}),
    payload: objectType === 'mycelium.recommendation'
      ? { marker, ...(postId ? { post_id: postId } : {}), action: 'recommend', sequence }
      : { marker },
    replication_policy: {}
  }, identity);
}

async function makeChronologicalObjects(count: number): Promise<DistributedObject[]> {
  return Promise.all(Array.from({ length: count }, (_, index) =>
    makeObject(
      authorIdentity,
      index % 2 === 0 ? 'mycelium.post' : 'mycelium.recommendation',
      at(index),
      `chronological-${index}`
    )
  ));
}

function createMemoryStore(): ObjectStore {
  const objects = new Map<string, DistributedObject>();
  return {
    put: async (object) => {
      const isNew = !objects.has(object.object_id);
      objects.set(object.object_id, object);
      return isNew;
    },
    get: async (objectId) => objects.get(objectId) ?? null,
    delete: async (objectId) => { objects.delete(objectId); },
    query: async () => [...objects.values()]
  };
}

async function add(store: ObjectStore, ...objects: DistributedObject[]): Promise<void> {
  await Promise.all(objects.map((object) => store.put(object)));
}

function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
}

function cursor(object: DistributedObject): FeedCursor {
  return { created_at: object.created_at, object_id: object.object_id };
}
