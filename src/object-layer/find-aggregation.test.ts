import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FindAggregation,
  forwardFindRequestToChild,
  sendFindPacketToConnectedPeer
} from './transport';
import type { DistributedObject, FindResponsePacket, ObjectTransport } from './types';

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

describe('FIND aggregation completion', () => {
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
    expect(onComplete).toHaveBeenCalledWith([], 'all-children-responded-or-failed');
  });
});
