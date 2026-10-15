import { describe, expect, it, vi } from 'vitest';
import { ensurePostChainCached } from './post-ancestry';
import type { DistributedObject, ObjectStore } from './types';

vi.mock('./envelope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./envelope')>();
  return { ...actual, validateDistributedObject: vi.fn(async () => true) };
});

function createPost(objectId: string, parentId: string): DistributedObject {
  return {
    object_id: objectId,
    object_type: 'mycelium.post',
    author: 'peer-a',
    created_at: new Date().toISOString(),
    payload: { content: objectId, reply_to: parentId },
    signature: 'test-signature',
    replication_policy: {}
  };
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

describe('canonical post chain cycle protection', () => {
  it('stops a structurally cyclic chain', async () => {
    const replyId = 'a'.repeat(64);
    const parentId = 'b'.repeat(64);
    const reply = createPost(replyId, parentId);
    const parent = createPost(parentId, replyId);

    const result = await ensurePostChainCached(reply, createMemoryStore(), async (objectId) => (
      objectId === parentId ? parent : null
    ));

    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe('cycle');
    expect(result.objects.map((object) => object.object_id)).toEqual([parentId, replyId]);
  });
});
