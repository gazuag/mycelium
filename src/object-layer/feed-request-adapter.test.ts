import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeedRequestAdapter, type ProcessedFeedBatchHandler } from './feed-request-adapter';
import { compareFeedKey } from './feed-page';
import { syncFeedFromPeer } from './feed-sync';
import type { DistributedObject, FeedCursor, FeedPageMetadata } from './types';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createFeedRequestAdapter', () => {
  it('resolves only for a matching request id from the requested peer', async () => {
    const harness = createHarness();
    const result = harness.adapter.requestPage('peer-a', null, 100);
    await Promise.resolve();
    const request = harness.sent[0];
    const object = makeObject();
    harness.publish('peer-b', metadata(request.requestId), [object]);
    harness.publish('peer-a', metadata('other-request'), [object]);

    harness.publish('peer-a', metadata(request.requestId), [object]);

    await expect(result).resolves.toEqual({
      objects: [object],
      next_cursor: metadata(request.requestId).next_cursor,
      has_more: true
    });
    expect(harness.unsubscribed).toBe(2);
  });

  it('ignores processed batches without page metadata or with unrelated metadata', async () => {
    const harness = createHarness();
    const result = harness.adapter.requestPage('peer-a', null, 50);
    await Promise.resolve();
    const request = harness.sent[0];
    harness.publish('peer-a', undefined, [makeObject()]);
    harness.publish('peer-a', { ...metadata(request.requestId), request_id: 'other' }, [makeObject()]);
    harness.publish('peer-b', metadata(request.requestId), [makeObject()]);
    harness.publish('peer-a', metadata(request.requestId), [makeObject()]);

    await expect(result).resolves.toMatchObject({ has_more: true });
  });

  it('rejects when a request times out', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ timeoutMs: 100 });
    const result = harness.adapter.requestPage('peer-a', null, 10);
    await Promise.resolve();
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(harness.unsubscribed).toBe(2);
  });

  it('rejects on send failure and unsubscribes', async () => {
    const harness = createHarness({ sendPacket: async () => { throw new Error('failed'); } });
    await expect(harness.adapter.requestPage('peer-a', null, 10)).rejects.toThrow('failed');
    expect(harness.unsubscribed).toBe(2);
  });

  it('rejects immediately when the requested peer disconnects', async () => {
    const harness = createHarness();
    const result = harness.adapter.requestPage('peer-a', null, 10);
    await Promise.resolve();
    harness.disconnect('peer-a');

    await expect(result).rejects.toThrow('disconnected');
    expect(harness.unsubscribed).toBe(2);
  });

  it('clears timeout and subscriptions after every terminal path', async () => {
    const harness = createHarness();
    const result = harness.adapter.requestPage('peer-a', null, 10);
    await Promise.resolve();
    const request = harness.sent[0];
    harness.publish('peer-a', metadata(request.requestId), [makeObject()]);
    await result;
    expect(harness.unsubscribed).toBe(2);

    const second = harness.adapter.requestPage('peer-b', null, 10);
    harness.adapter.dispose();
    await expect(second).rejects.toThrow('disposed');
    expect(harness.unsubscribed).toBe(4);
  });

  it('does not resolve until App processing completion is reported', async () => {
    const harness = createHarness();
    const result = harness.adapter.requestPage('peer-a', null, 10);
    await Promise.resolve();
    const request = harness.sent[0];
    let finishProcessing!: () => void;
    const processing = new Promise<void>((resolve) => { finishProcessing = resolve; });
    let resolved = false;
    void result.then(() => { resolved = true; });

    const object = makeObject();
    expect(resolved).toBe(false);
    void processing.then(() => harness.publish('peer-a', metadata(request.requestId), [object]));
    await Promise.resolve();
    expect(resolved).toBe(false);
    finishProcessing();
    await result;
    expect(resolved).toBe(true);
  });

  it('rejects when App reports batch processing failure', async () => {
    const harness = createHarness();
    const result = harness.adapter.requestPage('peer-a', null, 10);
    await Promise.resolve();
    const request = harness.sent[0];
    harness.publish('peer-a', metadata(request.requestId), [makeObject()], new Error('storage failed'));

    await expect(result).rejects.toThrow('processing failed');
    expect(harness.unsubscribed).toBe(2);
  });

  it('does not save the cursor when App batch processing fails', async () => {
    let handler: ProcessedFeedBatchHandler | null = null;
    let requestId = '';
    const adapter = createFeedRequestAdapter({
      sendPacket: async (_peerId, payload) => {
        requestId = payload.requestId;
        handler?.('peer-processing-failure', metadata(requestId), [makeObject()], new Error('store failed'));
      },
      subscribeBatches: (subscriber) => {
        handler = subscriber;
        return () => { handler = null; };
      },
      subscribeDisconnects: () => () => {}
    });
    const saveCursor = vi.fn();
    const result = await syncFeedFromPeer({
      peerId: 'peer-processing-failure',
      loadCursor: () => null,
      saveCursor,
      requestPage: adapter.requestPage,
      storeObjects: async () => {}
    });

    expect(requestId).not.toBe('');
    expect(saveCursor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: true, objects: 0 });
  });

  it('syncs 450 objects from a fake peer in pages, then receives only newer objects', async () => {
    const remoteObjects = Array.from({ length: 450 }, (_, index) => makeObject(index));
    const received = new Map<string, DistributedObject>();
    const deliveryLog: string[] = [];
    let batchSubscriber: ProcessedFeedBatchHandler | null = null;
    const adapter = createFeedRequestAdapter({
      timeoutMs: 1000,
      sendPacket: async (peerId, payload) => {
        const candidates = remoteObjects
          .filter((object) => compareFeedKey(cursorFor(object), payload.after!) > 0)
          .sort((left, right) => compareFeedKey(cursorFor(left), cursorFor(right)));
        const objects = candidates.slice(0, payload.limit);
        const hasMore = candidates.length > objects.length;
        const nextCursor = objects.length > 0 ? cursorFor(objects[objects.length - 1]) : payload.after;
        for (const object of objects) {
          deliveryLog.push(object.object_id);
          received.set(object.object_id, object);
        }
        batchSubscriber?.(peerId, {
          request_id: payload.requestId,
          next_cursor: nextCursor,
          has_more: hasMore
        }, objects);
      },
      subscribeBatches: (handler) => {
        batchSubscriber = handler;
        return () => { batchSubscriber = null; };
      },
      subscribeDisconnects: () => () => {}
    });
    let cursor: FeedCursor | null = null;
    const sync = () => syncFeedFromPeer({
      peerId: 'two-peer-e2e',
      loadCursor: () => cursor,
      saveCursor: (_peerId, value) => { cursor = value; },
      requestPage: adapter.requestPage,
      storeObjects: async () => {},
      limit: 100,
      maxPages: 10
    });

    const initial = await sync();
    expect(initial).toEqual({ pages: 5, objects: 450, hasMore: false, error: false });
    expect(received.size).toBe(450);
    expect(deliveryLog).toHaveLength(450);
    expect(new Set(deliveryLog).size).toBe(450);

    const newer = makeObject(451);
    remoteObjects.push(newer);
    const beforeSecondSync = received.size;
    const next = await sync();
    expect(next).toEqual({ pages: 1, objects: 1, hasMore: false, error: false });
    expect(received.size - beforeSecondSync).toBe(1);
    expect(received.has(newer.object_id)).toBe(true);
    expect(received.size).toBe(451);
    expect(deliveryLog).toHaveLength(451);
    expect(new Set(deliveryLog).size).toBe(451);
  });
});

function createHarness(overrides: {
  timeoutMs?: number;
  sendPacket?: (peerId: string, payload: { after: FeedCursor | null; limit: number; requestId: string }) => void | Promise<void>;
} = {}) {
  const batchHandlers = new Set<ProcessedFeedBatchHandler>();
  const disconnectHandlers = new Set<(peerId: string) => void>();
  const sent: Array<{ peerId: string; requestId: string }> = [];
  let unsubscribed = 0;
  const adapter = createFeedRequestAdapter({
    timeoutMs: overrides.timeoutMs,
    sendPacket: async (peerId, payload) => {
      sent.push({ peerId, requestId: payload.requestId });
      await overrides.sendPacket?.(peerId, payload);
    },
    subscribeBatches: (handler) => {
      batchHandlers.add(handler);
      return () => {
        batchHandlers.delete(handler);
        unsubscribed += 1;
      };
    },
    subscribeDisconnects: (handler) => {
      disconnectHandlers.add(handler);
      return () => {
        disconnectHandlers.delete(handler);
        unsubscribed += 1;
      };
    }
  });
  return {
    adapter,
    sent,
    get unsubscribed() { return unsubscribed; },
    publish(peerId: string, page: FeedPageMetadata | undefined, objects: DistributedObject[], error?: unknown) {
      batchHandlers.forEach((handler) => handler(peerId, page, objects, error));
    },
    disconnect(peerId: string) {
      disconnectHandlers.forEach((handler) => handler(peerId));
    }
  };
}

function metadata(requestId: string): FeedPageMetadata {
  return {
    request_id: requestId,
    next_cursor: { created_at: '2026-10-07T10:00:00.000Z', object_id: 'a'.repeat(64) },
    has_more: true
  };
}

function makeObject(index = 0): DistributedObject {
  return {
    object_id: index.toString(16).padStart(64, '0'),
    object_type: 'mycelium.post',
    author: 'author',
    created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    payload: {},
    signature: 'signature',
    replication_policy: {}
  };
}

function cursorFor(object: DistributedObject): FeedCursor {
  return { created_at: object.created_at, object_id: object.object_id };
}
