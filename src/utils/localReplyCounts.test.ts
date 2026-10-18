import { describe, expect, it } from 'vitest';
import { createLocalPostView, type LocalPostView } from '../object-layer';
import { buildLocalDirectReplyCounts } from './localReplyCounts';

function makePost(id: string, parentId?: string): LocalPostView {
  return createLocalPostView({
    object_id: id.repeat(64),
    object_type: 'mycelium.post',
    author: 'author-key',
    created_at: '2026-08-25T00:00:00.000Z',
    payload: { content: id, ...(parentId ? { reply_to: parentId } : {}) },
    replication_policy: {},
    signature: 'signature'
  }, 'aa:bb:cc:dd:ee:ff:00:11');
}

describe('buildLocalDirectReplyCounts', () => {
  it('counts only direct replies and supports zero, one, and multiple locally available replies', () => {
    const root = makePost('a');
    const directOne = makePost('b', root.object.object_id);
    const directTwo = makePost('c', root.object.object_id);
    const grandchild = makePost('d', directOne.object.object_id);

    const noReplies = buildLocalDirectReplyCounts([root]);
    const oneReply = buildLocalDirectReplyCounts([root, directOne]);
    const multipleReplies = buildLocalDirectReplyCounts([root, directOne, directTwo, grandchild]);

    expect(noReplies.get(root.object.object_id) ?? 0).toBe(0);
    expect(oneReply.get(root.object.object_id)).toBe(1);
    expect(multipleReplies.get(root.object.object_id)).toBe(2);
    expect(multipleReplies.get(directOne.object.object_id)).toBe(1);
  });

  it('counts a duplicated signed reply object only once', () => {
    const root = makePost('e');
    const reply = makePost('f', root.object.object_id);

    expect(buildLocalDirectReplyCounts([root, reply, reply]).get(root.object.object_id)).toBe(1);
  });

  it('does not count a reply with a malformed parent object ID', () => {
    const invalidReply = makePost('g', 'not-an-object-id');

    expect(buildLocalDirectReplyCounts([invalidReply]).size).toBe(0);
  });
});
