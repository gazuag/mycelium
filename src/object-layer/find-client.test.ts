import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { buildFindResponseObjectsPacket } from './transport';
import { createSignedObject } from './envelope';
import { createObjectIdentity } from './identity';
import { collectFindResults, fetchPageFromPeers, type FindClientTransport } from './find-client';
import type { DistributedObject, FindPacket, FindQueryCriteria, ObjectContent, ObjectIdentity, ObjectPacket } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const SENDER = 'origin-peer';
const RECIPIENT = 'inbox-recipient';
const NOW = new Date('2026-10-04T12:00:00.000Z');
let signingIdentity: ObjectIdentity;

beforeAll(async () => {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  signingIdentity = createObjectIdentity({ id: 'find-client-test', publicKey, privateKey });
});

afterEach(() => {
  vi.useRealTimers();
});

async function createObject(options: {
  id: string;
  recipient?: string;
  createdAt?: string;
}): Promise<DistributedObject> {
  const content: ObjectContent = {
    object_type: 'mycelium.dm',
    created_at: options.createdAt ?? '2026-10-04T10:00:00.000Z',
    recipient: options.recipient ?? RECIPIENT,
    payload: { id: options.id },
    replication_policy: {}
  };
  return createSignedObject(content, signingIdentity);
}

type FakeTransport = {
  transport: FindClientTransport;
  sent: Array<{ peerId: string; packet: ObjectPacket }>;
  emit: (peerId: string, packet: ObjectPacket) => void;
  activeSubscriptionCount: () => number;
  unsubscribeCount: () => number;
  sendSubscriptionStates: boolean[];
};

function createFakeTransport(
  peers: string[],
  onSend?: (peerId: string, packet: ObjectPacket, emit: FakeTransport['emit']) => Promise<void> | void
): FakeTransport {
  const listeners = new Set<(peerId: string, packet: ObjectPacket) => void>();
  const sent: FakeTransport['sent'] = [];
  const sendSubscriptionStates: boolean[] = [];
  let totalUnsubscribes = 0;
  const emit = (peerId: string, packet: ObjectPacket) => {
    for (const listener of [...listeners]) listener(peerId, packet);
  };
  const transport: FindClientTransport = {
    connectedPeers: () => peers,
    send: vi.fn(async (peerId, packet) => {
      sent.push({ peerId, packet });
      sendSubscriptionStates.push(listeners.size > 0);
      await onSend?.(peerId, packet, emit);
    }),
    subscribe: vi.fn((handler) => {
      listeners.add(handler);
      return () => {
        totalUnsubscribes += 1;
        listeners.delete(handler);
      };
    })
  };
  return {
    transport,
    sent,
    emit,
    activeSubscriptionCount: () => listeners.size,
    unsubscribeCount: () => totalUnsubscribes,
    sendSubscriptionStates
  };
}

async function waitForSends(fake: FakeTransport, count: number) {
  await vi.waitFor(() => {
    expect(fake.sent).toHaveLength(count);
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function emitResponse(
  fake: FakeTransport,
  peerId: string,
  objects: DistributedObject[],
  requestId?: string,
  complete = true,
  hasMore = false
) {
  const request = fake.sent.find((sent) => sent.peerId === peerId)?.packet as FindPacket | undefined;
  if (!request) throw new Error(`No FIND sent to ${peerId}`);
  const response = await buildFindResponseObjectsPacket(
    peerId,
    SENDER,
    requestId ?? request.payload.requestId,
    objects,
    undefined,
    undefined,
    undefined,
    complete,
    request.payload.page_before
      || (request.payload.order === 'created_at_desc' && request.payload.limit !== undefined)
      ? true
      : undefined,
    request.payload.page_before
      || (request.payload.order === 'created_at_desc' && request.payload.limit !== undefined)
      ? hasMore
      : undefined
  );
  fake.emit(peerId, response);
}

function options(fake: FakeTransport, criteria: FindQueryCriteria = {}) {
  return { transport: fake.transport, sender: SENDER, criteria, now: () => NOW };
}

describe('collectFindResults', () => {
  it('sends to at most fanout peers in deterministic order', async () => {
    vi.useFakeTimers();
    const fake = createFakeTransport(['peer-c', 'peer-a', 'peer-b']);
    const resultPromise = collectFindResults({ ...options(fake), fanout: 2, timeoutMs: 5000 });

    await waitForSends(fake, 2);
    expect(fake.sent.map((sent) => sent.peerId)).toEqual(['peer-a', 'peer-b']);
    const requestIds = fake.sent.map(({ packet }) => (packet as FindPacket).payload.requestId);
    expect(new Set(requestIds).size).toBe(1);
    expect(fake.sent.every(({ packet }) => packet.type === 'FIND' && packet.payload.ttl === 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await resultPromise;
  });

  it('uses the default four-peer fanout and does not query other connected peers', async () => {
    const fake = createFakeTransport(
      ['peer-e', 'peer-c', 'peer-a', 'peer-d', 'peer-b'],
      async (peerId, packet, emit) => {
        const response = await buildFindResponseObjectsPacket(
          peerId,
          SENDER,
          (packet as FindPacket).payload.requestId,
          []
        );
        emit(peerId, response);
      }
    );

    const result = await collectFindResults(options(fake));

    expect(fake.sent.map(({ peerId }) => peerId)).toEqual(['peer-a', 'peer-b', 'peer-c', 'peer-d']);
    expect(fake.sent.every(({ packet }) => packet.type === 'FIND' && packet.payload.ttl === 1)).toBe(true);
    expect(result.complete).toBe(true);
  });

  it('subscribes before sending', async () => {
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults(options(fake));
    await waitForSends(fake, 1);

    expect(fake.sendSubscriptionStates).toEqual([true]);
    await emitResponse(fake, 'peer-a', []);
    await resultPromise;
  });

  it('ignores a matching response from an unlisted peer', async () => {
    vi.useFakeTimers();
    const object = await createObject({ id: 'unlisted' });
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults({ ...options(fake), timeoutMs: 5000 });
    await waitForSends(fake, 1);
    await emitResponse(fake, 'peer-a', [], 'other-request');
    const unlisted = await buildFindResponseObjectsPacket('peer-not-listed', SENDER, (fake.sent[0].packet as FindPacket).payload.requestId, [object]);
    fake.emit('peer-not-listed', unlisted);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.objects).toEqual([]);
    expect(result.timedOut).toBe(true);
  });

  it('ignores a response with the wrong request ID', async () => {
    vi.useFakeTimers();
    const object = await createObject({ id: 'wrong-id' });
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults({ ...options(fake), timeoutMs: 5000 });
    await waitForSends(fake, 1);
    await emitResponse(fake, 'peer-a', [object], 'wrong-request-id');

    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.objects).toEqual([]);
    expect(result.timedOut).toBe(true);
  });

  it('drops objects with invalid signatures', async () => {
    const signed = await createObject({ id: 'tamper' });
    const invalid = { ...signed, payload: { id: 'changed' } };
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults(options(fake));
    await waitForSends(fake, 1);
    await emitResponse(fake, 'peer-a', [invalid]);

    const result = await resultPromise;
    expect(result.objects).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('drops objects whose recipient differs from the FIND criterion', async () => {
    const object = await createObject({ id: 'other-recipient', recipient: 'someone-else' });
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults({ ...options(fake, { recipient: RECIPIENT }) });
    await waitForSends(fake, 1);
    await emitResponse(fake, 'peer-a', [object]);

    expect((await resultPromise).objects).toEqual([]);
  });

  it('deduplicates objects returned by different peers', async () => {
    const object = await createObject({ id: 'shared' });
    const fake = createFakeTransport(['peer-a', 'peer-b']);
    const resultPromise = collectFindResults(options(fake));
    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [object]);
    await emitResponse(fake, 'peer-b', [object]);

    const result = await resultPromise;
    expect(result.objects.map((item) => item.object_id)).toEqual([object.object_id]);
    expect(result.responded).toEqual(['peer-a', 'peer-b']);
  });

  it('ignores a second response from the same peer', async () => {
    const first = await createObject({ id: 'first-response' });
    const second = await createObject({ id: 'second-response' });
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults(options(fake));
    await waitForSends(fake, 1);
    await emitResponse(fake, 'peer-a', [first]);
    await emitResponse(fake, 'peer-a', [second]);

    const result = await resultPromise;
    expect(result.objects.map((item) => item.object_id)).toEqual([first.object_id]);
    expect(result.responded).toEqual(['peer-a']);
  });

  it('settles immediately as complete when every peer responds', async () => {
    vi.useFakeTimers();
    const fake = createFakeTransport(['peer-a', 'peer-b']);
    const resultPromise = collectFindResults({ ...options(fake), timeoutMs: 5000 });
    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', []);
    await emitResponse(fake, 'peer-b', []);

    const result = await resultPromise;
    expect(result.complete).toBe(true);
    expect(result.responded).toEqual(['peer-a', 'peer-b']);
    expect(result.timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.unsubscribeCount()).toBe(1);
  });

  it('does not start another round once the requested number of objects is found', async () => {
    const object = await createObject({ id: 'enough-in-initial-round' });
    const fake = createFakeTransport(['peer-a', 'peer-b', 'peer-c', 'peer-d']);
    const resultPromise = collectFindResults({
      ...options(fake, { limit: 1 }),
      fanout: 2
    });
    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [object], undefined, false);
    await emitResponse(fake, 'peer-b', [], undefined, false);

    const result = await resultPromise;

    expect(result.objects).toEqual([object]);
    expect(result.complete).toBe(false);
    expect(fake.sent.map(({ peerId }) => peerId)).toEqual(['peer-a', 'peer-b']);
  });

  it('reports a complete search when all selected peers respond even if fewer than the requested limit are found', async () => {
    const first = await createObject({ id: 'below-requested-limit-1' });
    const second = await createObject({ id: 'below-requested-limit-2' });
    const fake = createFakeTransport(['peer-a', 'peer-b', 'peer-c', 'peer-d']);
    const resultPromise = collectFindResults({
      ...options(fake, { recipient: RECIPIENT, limit: 5 }),
      fanout: 2
    });
    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [first]);
    await emitResponse(fake, 'peer-b', [second]);

    const result = await resultPromise;

    expect(result.objects.map((object) => object.object_id)).toEqual([first.object_id, second.object_id]);
    expect(result.complete).toBe(true);
    expect(result.responded).toEqual(['peer-a', 'peer-b']);
    expect(result.failed).toEqual([]);
    expect(result.timedOut).toBe(false);
    expect(fake.sent.map(({ peerId }) => peerId)).toEqual(['peer-a', 'peer-b']);
  });

  it('keeps selected-peer order when object validation completes out of order', async () => {
    const first = await createObject({ id: 'slow-first-peer-validation' });
    const second = await createObject({ id: 'fast-second-peer-validation' });
    const fake = createFakeTransport(['peer-a', 'peer-b']);
    const resultPromise = collectFindResults({
      ...options(fake, { recipient: RECIPIENT, limit: 5 }),
      fanout: 2,
      validate: async (object) => {
        await new Promise((resolve) => setTimeout(
          resolve,
          object.object_id === first.object_id ? 25 : 0
        ));
        return true;
      }
    });
    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [first]);
    await emitResponse(fake, 'peer-b', [second]);

    const result = await resultPromise;

    expect(result.objects.map((object) => object.object_id)).toEqual([first.object_id, second.object_id]);
    expect(result.complete).toBe(true);
    expect(result.responded).toEqual(['peer-a', 'peer-b']);
  });

  it('queries additional peers after an incomplete short round and deduplicates results across rounds', async () => {
    const shared = await createObject({ id: 'shared-between-rounds' });
    const newObject = await createObject({ id: 'new-in-second-round' });
    const fake = createFakeTransport(['peer-d', 'peer-b', 'peer-a', 'peer-c']);
    const resultPromise = collectFindResults({
      ...options(fake, { limit: 2 }),
      fanout: 2
    });

    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [shared], undefined, false);
    await emitResponse(fake, 'peer-b', [shared], undefined, false);
    await waitForSends(fake, 4);
    await emitResponse(fake, 'peer-c', [newObject]);
    await emitResponse(fake, 'peer-d', [shared]);

    const result = await resultPromise;

    expect(fake.sent.map(({ peerId }) => peerId)).toEqual(['peer-a', 'peer-b', 'peer-c', 'peer-d']);
    expect(new Set(fake.sent.map(({ peerId }) => peerId)).size).toBe(fake.sent.length);
    expect(result.objects.map((object) => object.object_id)).toEqual([shared.object_id, newObject.object_id]);
    expect(result.complete).toBe(false);
    expect(result.failed).toEqual(['peer-a', 'peer-b']);
    expect(result.responded).toEqual(['peer-c', 'peer-d']);
    expect(result.timedOut).toBe(false);
  });

  it('limits progressive searches to two fanout rounds', async () => {
    const peers = Array.from({ length: 8 }, (_, index) => `peer-${String.fromCharCode(97 + index)}`);
    const fake = createFakeTransport(peers);
    const resultPromise = collectFindResults({
      ...options(fake, { limit: 10 }),
      fanout: 2
    });

    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [], undefined, false);
    await emitResponse(fake, 'peer-b', [], undefined, false);
    await waitForSends(fake, 4);
    await emitResponse(fake, 'peer-c', [], undefined, false);
    await emitResponse(fake, 'peer-d', [], undefined, false);

    const result = await resultPromise;

    expect(fake.sent.map(({ peerId }) => peerId)).toEqual(['peer-a', 'peer-b', 'peer-c', 'peer-d']);
    expect(result.complete).toBe(false);
    expect(result.objects).toEqual([]);
  });

  it('retains partial objects and incomplete status when a later round times out', async () => {
    vi.useFakeTimers();
    const partial = await createObject({ id: 'partial-before-late-timeout' });
    const fake = createFakeTransport(['peer-a', 'peer-b', 'peer-c', 'peer-d']);
    const resultPromise = collectFindResults({
      ...options(fake, { limit: 3 }),
      fanout: 2,
      timeoutMs: 10000,
      graceMs: 20000
    });

    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [partial], undefined, false);
    await emitResponse(fake, 'peer-b', [], undefined, false);
    await waitForSends(fake, 4);
    await emitResponse(fake, 'peer-c', [], undefined, false);
    await vi.advanceTimersByTimeAsync(10000);

    const result = await resultPromise;

    expect(result.objects).toEqual([partial]);
    expect(result.complete).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.failed).toEqual(['peer-a', 'peer-b', 'peer-c']);
    expect(result.responded).toEqual([]);
  });

  it('settles after grace when one peer stays silent', async () => {
    vi.useFakeTimers();
    const fake = createFakeTransport(['peer-a', 'peer-b']);
    const resultPromise = collectFindResults({ ...options(fake), graceMs: 1000, timeoutMs: 5000 });
    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', []);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;
    expect(result.complete).toBe(false);
    expect(result.responded).toEqual(['peer-a']);
    expect(result.failed).toEqual([]);
    expect(result.timedOut).toBe(false);
    expect(fake.unsubscribeCount()).toBe(1);
  });

  it('preserves a relay peer response marked incomplete while retaining its partial objects', async () => {
    const object = await createObject({ id: 'partial-subtree' });
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults(options(fake));
    await waitForSends(fake, 1);
    await emitResponse(fake, 'peer-a', [object], undefined, false);

    const result = await resultPromise;
    expect(result.objects).toEqual([object]);
    expect(result.complete).toBe(false);
    expect(result.responded).toEqual([]);
    expect(result.failed).toEqual(['peer-a']);
  });

  it('requires explicit pagination support from every peer on cursor pages', async () => {
    const criteria: FindQueryCriteria = {
      recipient: RECIPIENT,
      page_before: { created_at: NOW.toISOString(), object_id: 'a'.repeat(64) }
    };
    const legacy = createFakeTransport(['peer-a'], async (peerId, packet, emit) => {
      const response = await buildFindResponseObjectsPacket(
        peerId,
        SENDER,
        (packet as FindPacket).payload.requestId,
        []
      );
      const { pagination_supported: _unsupported, ...legacyPayload } = response.payload;
      emit(peerId, { ...response, payload: legacyPayload });
    });
    const legacyResultPromise = collectFindResults({ ...options(legacy, criteria) });
    await waitForSends(legacy, 1);
    expect(await legacyResultPromise).toMatchObject({
      complete: true,
      paginationSupported: false
    });

    const supporting = createFakeTransport(['peer-a'], async (peerId, packet, emit) => {
      const response = await buildFindResponseObjectsPacket(
        peerId,
        SENDER,
        (packet as FindPacket).payload.requestId,
        [],
        undefined,
        undefined,
        undefined,
        true,
        true,
        false
      );
      emit(peerId, response);
    });
    const supportingResultPromise = collectFindResults({ ...options(supporting, criteria) });
    await waitForSends(supporting, 1);
    expect(await supportingResultPromise).toMatchObject({
      complete: true,
      paginationSupported: true
    });
  });

  it('requires explicit has_more metadata on the first bounded ordered page', async () => {
    const object = await createObject({ id: 'legacy-first-page' });
    const fake = createFakeTransport(['peer-a'], async (peerId, packet, emit) => {
      const response = await buildFindResponseObjectsPacket(
        peerId,
        SENDER,
        (packet as FindPacket).payload.requestId,
        [object]
      );
      emit(peerId, response);
    });
    const resultPromise = collectFindResults(options(fake, {
      recipient: RECIPIENT,
      order: 'created_at_desc',
      limit: 2
    }));
    await waitForSends(fake, 1);

    await expect(resultPromise).resolves.toMatchObject({
      objects: [object],
      complete: true,
      paginationSupported: false,
      hasMore: false
    });
  });

  it('preserves peer has_more when a bounded query returns fewer objects than its limit', async () => {
    const object = await createObject({ id: 'peer-has-more' });
    const fake = createFakeTransport(['peer-a'], async (peerId, packet, emit) => {
      const response = await buildFindResponseObjectsPacket(
        peerId,
        SENDER,
        (packet as FindPacket).payload.requestId,
        [object],
        undefined,
        undefined,
        undefined,
        true,
        true,
        true
      );
      emit(peerId, response);
    });
    const resultPromise = collectFindResults(options(fake, {
      recipient: RECIPIENT,
      order: 'created_at_desc',
      limit: 2
    }));
    await waitForSends(fake, 1);

    await expect(resultPromise).resolves.toMatchObject({
      paginationSupported: true,
      hasMore: true
    });
  });

  it('treats a legacy response without completeness metadata as incomplete', async () => {
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults(options(fake));
    await waitForSends(fake, 1);
    const request = fake.sent[0].packet as FindPacket;
    const response = await buildFindResponseObjectsPacket(
      'peer-a',
      SENDER,
      request.payload.requestId,
      []
    );
    const { complete, pagination_supported: legacyPaginationSupport, ...legacyPayload } = response.payload;
    void complete;
    void legacyPaginationSupport;
    fake.emit('peer-a', { ...response, payload: legacyPayload });

    const result = await resultPromise;
    expect(result).toMatchObject({
      objects: [],
      complete: false,
      paginationSupported: true,
      responded: [],
      failed: ['peer-a'],
      timedOut: false
    });
  });

  it('reports hard timeout with no responses', async () => {
    vi.useFakeTimers();
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults({ ...options(fake), timeoutMs: 5000 });
    await waitForSends(fake, 1);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await resultPromise;
    expect(result).toMatchObject({
      objects: [],
      complete: false,
      paginationSupported: true,
      responded: [],
      failed: [],
      timedOut: true
    });
    expect(fake.unsubscribeCount()).toBe(1);
  });

  it('marks send failures and still collects responses from other peers', async () => {
    const object = await createObject({ id: 'surviving-peer' });
    const fake = createFakeTransport(['peer-a', 'peer-b'], async (peerId, packet, emit) => {
      if (peerId === 'peer-a') throw new Error('send failed');
      const response = await buildFindResponseObjectsPacket(peerId, SENDER, (packet as FindPacket).payload.requestId, [object]);
      emit(peerId, response);
    });
    const resultPromise = collectFindResults(options(fake));
    await waitForSends(fake, 2);

    const result = await resultPromise;
    expect(result.failed).toEqual(['peer-a']);
    expect(result.responded).toEqual(['peer-b']);
    expect(result.objects.map((item) => item.object_id)).toEqual([object.object_id]);
    expect(result.complete).toBe(false);
    expect(fake.unsubscribeCount()).toBe(1);
  });

  it('resolves immediately with an empty incomplete result when there are no peers', async () => {
    const fake = createFakeTransport([]);

    await expect(collectFindResults(options(fake))).resolves.toEqual({
      objects: [],
      complete: false,
      paginationSupported: false,
      hasMore: false,
      responded: [],
      failed: [],
      timedOut: false
    });
    expect(fake.transport.subscribe).not.toHaveBeenCalled();
    expect(fake.transport.send).not.toHaveBeenCalled();
  });

  it('applies created_at_desc ordering and limit to the merged objects', async () => {
    const older = await createObject({ id: 'older', createdAt: '2026-10-04T10:00:00.000Z' });
    const newest = await createObject({ id: 'newest', createdAt: '2026-10-04T11:00:00.000Z' });
    const middle = await createObject({ id: 'middle', createdAt: '2026-10-04T10:30:00.000Z' });
    const fake = createFakeTransport(['peer-a', 'peer-b']);
    const resultPromise = collectFindResults({
      ...options(fake, { recipient: RECIPIENT, order: 'created_at_desc', limit: 2 })
    });
    await waitForSends(fake, 2);
    await emitResponse(fake, 'peer-a', [older, newest]);
    await emitResponse(fake, 'peer-b', [middle]);

    const result = await resultPromise;
    expect(result.objects.map((object) => object.object_id)).toEqual([newest.object_id, middle.object_id]);
  });

  it('unsubscribes when a timed-out request finishes', async () => {
    vi.useFakeTimers();
    const fake = createFakeTransport(['peer-a']);
    const resultPromise = collectFindResults({ ...options(fake), timeoutMs: 100 });
    await waitForSends(fake, 1);
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    expect(fake.activeSubscriptionCount()).toBe(0);
    expect(fake.unsubscribeCount()).toBe(1);
  });

  it('exposes the objects and completeness through the page-fetch wrapper', async () => {
    const object = await createObject({ id: 'page-wrapper' });
    const fake = createFakeTransport(['peer-a'], async (peerId, packet, emit) => {
      const response = await buildFindResponseObjectsPacket(peerId, SENDER, (packet as FindPacket).payload.requestId, [object]);
      emit(peerId, response);
    });
    const fetchPage = fetchPageFromPeers(fake.transport, { sender: SENDER, now: () => NOW });

    await expect(fetchPage({ recipient: RECIPIENT, limit: 10 })).resolves.toEqual({
      objects: [object],
      complete: true,
      paginationSupported: true,
      hasMore: false
    });
  });

  it('rotates bounded peer selections across repeated page queries', async () => {
    const fake = createFakeTransport(
      ['peer-e', 'peer-c', 'peer-a', 'peer-d', 'peer-b'],
      async (peerId, packet, emit) => {
        const response = await buildFindResponseObjectsPacket(
          peerId,
          SENDER,
          (packet as FindPacket).payload.requestId,
          []
        );
        emit(peerId, response);
      }
    );
    const fetchPage = fetchPageFromPeers(fake.transport, {
      sender: SENDER,
      now: () => NOW,
      fanout: 2
    });

    await fetchPage({ recipient: RECIPIENT });
    await fetchPage({ recipient: RECIPIENT });
    await fetchPage({ recipient: RECIPIENT });

    const selections = [0, 1, 2].map((index) =>
      fake.sent.slice(index * 2, index * 2 + 2).map(({ peerId }) => peerId)
    );
    expect(selections).toEqual([
      ['peer-a', 'peer-b'],
      ['peer-b', 'peer-c'],
      ['peer-c', 'peer-d']
    ]);
    expect(fake.sent).toHaveLength(6);
  });
});