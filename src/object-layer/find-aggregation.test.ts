import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterTombstonedObjects,
  FindAggregation,
  forwardFindRequestToChild,
  sendFindPacketToConnectedPeer,
  validateFindResponseObjects
} from './transport';
import type { DeletionAwareObjectStore, DeletionTombstone, DistributedObject, FindResponsePacket, ObjectIdentity, ObjectTransport } from './types';
import { webcrypto } from 'node:crypto';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from './identity';
import { createSignedObject } from './envelope';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

function object(objectId: string): DistributedObject {
  return {
    object_id: objectId,
    object_type: 'test',
    author: 'author',
    created_at: '2026-10-06T00:00:00.000Z',
    payload: {},
    signature: 'signature',
    replication_policy: {}
  };
}

function findResponse(objects: DistributedObject[]): FindResponsePacket {
  return {
    protocol: 'mycelium',
    version: 1,
    id: 'response-id',
    type: 'FIND_RESPONSE',
    timestamp: '2026-10-06T00:00:00.000Z',
    sender: 'responder',
    recipient: 'requester',
    payload: {
      objects,
      object_id: objects[0]?.object_id ?? '',
      requestId: 'request-id'
    },
    signature: 'signature'
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createValidObject(): Promise<DistributedObject> {
  const keys = await generateIdentityKeyPair();
  const identity: ObjectIdentity = createObjectIdentity({
    id: 'find-tombstone-author',
    publicKey: await exportPublicKey(keys.publicKey),
    privateKey: await exportPrivateKey(keys.privateKey)
  });
  return createSignedObject({
    object_type: 'mycelium.find-tombstone-test',
    created_at: '2026-10-06T00:00:00.000Z',
    payload: { value: 'valid stale payload' },
    replication_policy: {}
  }, identity);
}

function deletionAwareStore(tombstones: ReadonlyMap<string, DeletionTombstone>): DeletionAwareObjectStore {
  return {
    put: async () => false,
    get: async () => null,
    delete: async () => undefined,
    query: async () => [],
    getDeletionTombstone: async (objectId) => tombstones.get(objectId) ?? null,
    queryDeletionTombstones: async () => [...tombstones.values()],
    applyDeletionTombstone: async () => false
  };
}

describe('FIND aggregation completion', () => {
  it('filters a stale child FIND result when a local tombstone exists', async () => {
    const staleObject = await createValidObject();
    const response = findResponse([staleObject]);
    const tombstone: DeletionTombstone = {
      target_object_id: staleObject.object_id,
      target_object_type: 'mycelium.post',
      target_author: staleObject.author,
      target_created_at: staleObject.created_at,
      delete_request_id: 'd'.repeat(64),
      deleted_at: '2026-10-06T00:01:00.000Z'
    };
    const store = deletionAwareStore(new Map([[staleObject.object_id, tombstone]]));
    const validated = await validateFindResponseObjects(
      response,
      'request-id',
      new Set([staleObject.object_id])
    );
    const filtered = await filterTombstonedObjects(validated, store);
    const returned: DistributedObject[][] = [];
    const aggregation = new FindAggregation(
      [staleObject.object_id],
      Date.now() + 5000,
      async (objects) => { returned.push(objects); }
    );
    aggregation.addChild('child-peer');

    await aggregation.addChildObjects('child-peer', filtered);

    expect(validated).toEqual([staleObject]);
    expect(filtered).toEqual([]);
    expect(returned).toEqual([[]]);
  });

  it('allows valid child FIND results through when no local tombstone exists', async () => {
    const object = await createValidObject();
    const response = findResponse([object]);
    const store = deletionAwareStore(new Map());
    const validated = await validateFindResponseObjects(
      response,
      'request-id',
      new Set([object.object_id])
    );
    const filtered = await filterTombstonedObjects(validated, store);
    const returned: DistributedObject[][] = [];
    const aggregation = new FindAggregation(
      [object.object_id],
      Date.now() + 5000,
      async (objects) => { returned.push(objects); }
    );
    aggregation.addChild('child-peer');

    await aggregation.addChildObjects('child-peer', filtered);

    expect(filtered).toEqual([object]);
    expect(returned).toEqual([[object]]);
  });

  it('catches onComplete rejection from the deadline and clears aggregation timers', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const aggregation = new FindAggregation(
      ['missing-object'],
      Date.now() + 100,
      async () => { throw new Error('private transport details'); }
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(aggregation.isComplete()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(warning).toHaveBeenCalledExactlyOnceWith('FIND aggregation completion callback failed');
  });

  it('does not invoke completion again after a later completion trigger', async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn(async () => undefined);
    const aggregation = new FindAggregation(['missing-object'], Date.now() + 5000, onComplete);
    aggregation.addChild('peer-a');

    await aggregation.addChildObjects('peer-a', []);
    await aggregation.addChildObjects('peer-a', []);
    await vi.runAllTimersAsync();

    expect(onComplete).toHaveBeenCalledOnce();
    expect(aggregation.isComplete()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not throw when the upstream peer is gone at completion time', async () => {
    const send = vi.fn(async () => undefined);
    const transport: ObjectTransport = {
      connectedPeers: () => [],
      send,
      onPacket: () => () => undefined
    };
    const packet = findResponse([object('found-object')]);
    const aggregation = new FindAggregation(['found-object'], Date.now() + 5000, async () => {
      expect(await sendFindPacketToConnectedPeer(transport, 'disconnected-peer', packet)).toBe(false);
    });
    aggregation.addChild('peer-a');

    await expect(aggregation.addChildObjects('peer-a', [object('found-object')])).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(aggregation.isComplete()).toBe(true);
  });

  it('delivers the merged response on normal completion', async () => {
    const sent: FindResponsePacket[] = [];
    const transport: ObjectTransport = {
      connectedPeers: () => ['requester'],
      send: async (_peerId, packet) => { sent.push(packet as FindResponsePacket); },
      onPacket: () => () => undefined
    };
    const first = object('first-object');
    const second = object('second-object');
    const aggregation = new FindAggregation(
      [first.object_id, second.object_id],
      Date.now() + 5000,
      async (objects) => {
        const packet = findResponse(objects);
        expect(await sendFindPacketToConnectedPeer(transport, 'requester', packet)).toBe(true);
      }
    );
    aggregation.addChild('peer-a');

    await aggregation.addChildObjects('peer-a', [first, second]);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.objects.map((entry) => entry.object_id)).toEqual([
      'first-object',
      'second-object'
    ]);
  });

  it('marks a child failed after a rejected forward and completes the aggregation', async () => {
    const onComplete = vi.fn(async () => undefined);
    const aggregation = new FindAggregation(['missing-object'], Date.now() + 5000, onComplete);
    aggregation.addChild('peer-a');

    const forwarded = await forwardFindRequestToChild(aggregation, 'peer-a', async () => {
      throw new Error('peer transport closed');
    });

    expect(forwarded).toBe(false);
    expect(aggregation.isComplete()).toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith([], 'all-children-responded-or-failed', false);
  });

  it('retains partial child objects but marks the aggregate incomplete', async () => {
    const onComplete = vi.fn(async () => undefined);
    const aggregation = new FindAggregation([], Date.now() + 5000, onComplete, undefined, true);
    aggregation.addChild('partial-peer');
    aggregation.addChild('complete-peer');

    await aggregation.addChildObjects('partial-peer', [object('partial-result')], false);
    await aggregation.addChildObjects('complete-peer', []);

    expect(onComplete).toHaveBeenCalledWith([object('partial-result')], 'all-children-responded-or-failed', false);
    expect(aggregation.allChildrenResponded()).toBe(false);
    expect(aggregation.isComplete()).toBe(true);
  });

  it('marks a cursor aggregation incomplete when a child does not confirm cursor support', async () => {
    const aggregation = new FindAggregation([], Date.now() + 5000, async () => undefined, undefined, true, true);
    aggregation.addChild('legacy-peer');

    await aggregation.addChildObjects('legacy-peer', [], true, false);

    expect(aggregation.allChildrenResponded()).toBe(false);
    expect(aggregation.allChildrenSupportPagination()).toBe(false);
  });

  it('preserves child has_more through aggregation completion', async () => {
    const onComplete = vi.fn(async () => undefined);
    const result = object('available-on-next-page');
    const aggregation = new FindAggregation([], Date.now() + 5000, onComplete, undefined, true, true);
    aggregation.addChild('peer-a');

    await aggregation.addChildObjects('peer-a', [result], true, true, true);

    expect(onComplete).toHaveBeenCalledWith([result], 'all-children-responded-or-failed', true);
    expect(aggregation.hasMore()).toBe(true);
  });
});
