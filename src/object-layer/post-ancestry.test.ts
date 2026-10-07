import { describe, expect, it, vi } from 'vitest';
import { createLocalPostView } from './post-state';
import type { LocalPostView } from './types';
import { loadPostAncestry, MAX_POST_ANCESTRY_DEPTH } from './post-ancestry';

const authorFingerprint = 'aa:bb:cc:dd:ee:ff:00:11';

function makePost(id: string, parentId?: string): LocalPostView {
  const objectId = /^[0-9a-f]{64}$/.test(id) ? id : id.repeat(64);
  const parentObjectId = parentId
    ? /^[0-9a-f]{64}$/.test(parentId) ? parentId : parentId.repeat(64)
    : undefined;
  return createLocalPostView({
    object_id: objectId,
    object_type: 'mycelium.post',
    author: 'author-key',
    created_at: '2026-08-25T00:00:00.000Z',
    payload: { content: id, ...(parentObjectId ? { reply_to: parentObjectId } : {}) },
    replication_policy: {},
    signature: 'signature'
  }, authorFingerprint);
}

describe('loadPostAncestry', () => {
  it('returns only the selected post when it has no parent', async () => {
    const selected = makePost('a');
    const resolve = vi.fn();

    const result = await loadPostAncestry(selected, [selected], resolve);

    expect(result).toEqual({ ancestors: [], stopReason: 'no-parent' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('uses a locally available parent without retrieval', async () => {
    const parent = makePost('a');
    const selected = makePost('b', 'a');
    const resolve = vi.fn();

    const result = await loadPostAncestry(selected, [selected, parent], resolve);

    expect(result.ancestors).toEqual([parent]);
    expect(result.stopReason).toBe('no-parent');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('retrieves a missing local parent through the supplied FIND resolver', async () => {
    const parent = makePost('a');
    const selected = makePost('b', 'a');
    const resolve = vi.fn(async (objectId: string) => objectId === parent.object.object_id ? parent : null);

    const result = await loadPostAncestry(selected, [selected], resolve);

    expect(resolve).toHaveBeenCalledWith(parent.object.object_id);
    expect(result.ancestors).toEqual([parent]);
  });

  it('returns multi-generation ancestors oldest-to-newest', async () => {
    const grandparent = makePost('a');
    const parent = makePost('b', 'a');
    const selected = makePost('c', 'b');
    const result = await loadPostAncestry(
      selected,
      [selected],
      async (objectId) => [grandparent, parent].find((post) => post.object.object_id === objectId) ?? null
    );

    expect(result.ancestors).toEqual([grandparent, parent]);
    expect(result.stopReason).toBe('no-parent');
  });

  it('stops gracefully when a parent cannot be found', async () => {
    const selected = makePost('b', 'a');

    const result = await loadPostAncestry(selected, [selected], async () => null);

    expect(result).toEqual({ ancestors: [], stopReason: 'missing' });
  });

  it('does not send malformed parent references to the resolver', async () => {
    const selected = createLocalPostView({
      ...makePost('b').object,
      payload: { content: 'malformed reply', reply_to: 'not-an-object-id' }
    }, authorFingerprint);
    const resolve = vi.fn();

    const result = await loadPostAncestry(selected, [selected], resolve);

    expect(result.stopReason).toBe('missing');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('terminates cyclic relationships and caps ancestry depth', async () => {
    const first = makePost('a', 'b');
    const second = makePost('b', 'a');
    const cycle = await loadPostAncestry(first, [first], async () => second);
    expect(cycle.ancestors).toEqual([second]);
    expect(cycle.stopReason).toBe('cycle');

    const posts = Array.from({ length: MAX_POST_ANCESTRY_DEPTH + 2 }, (_, index) => {
      const id = (index + 1).toString(16).padStart(64, '0');
      const parentId = index === MAX_POST_ANCESTRY_DEPTH + 1
        ? undefined
        : (index + 2).toString(16).padStart(64, '0');
      return makePost(id, parentId);
    });
    const selected = posts[0];
    const byId = new Map(posts.map((post) => [post.object.object_id, post]));
    const depthResult = await loadPostAncestry(selected, [selected], async (objectId) => byId.get(objectId) ?? null);

    expect(depthResult.ancestors).toHaveLength(MAX_POST_ANCESTRY_DEPTH);
    expect(depthResult.stopReason).toBe('depth-limit');
  });

  it('retrieves only ancestors and never searches for replies', async () => {
    const parent = makePost('a');
    const selected = makePost('b', 'a');
    const unrelatedReply = makePost('c', 'b');
    const resolve = vi.fn(async (objectId: string) => objectId === parent.object.object_id ? parent : null);

    await loadPostAncestry(selected, [selected, unrelatedReply], resolve);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(parent.object.object_id);
  });
});
