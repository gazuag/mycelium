import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createSignedObject } from './envelope';
import { createObjectIdentity } from './identity';
import { createInboxRunner } from './inbox-runner';
import type { InboxBackfillState } from './inbox-sync';
import type { DistributedObject, FindResponsePacket, ObjectStore } from './types';
import type { FindClientTransport } from './find-client';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const MY_PUBLIC_KEY = 'inbox-runner-recipient';
const NOW = new Date('2026-10-05T12:00:00.000Z');

async function createInboxObject(id: string, createdAt = '2026-10-05T11:00:00.000Z'): Promise<DistributedObject> {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  return await createSignedObject({
    object_type: 'mycelium.dm',
    recipient: MY_PUBLIC_KEY,
    created_at: createdAt,
    payload: { id },
    replication_policy: {}
  }, createObjectIdentity({ id: 'inbox-runner-author', publicKey, privateKey }));
}

function createStore(put: (object: DistributedObject) => Promise<boolean> = async () => true): ObjectStore {
  return {
    put,
    get: async () => null,
    delete: async () => undefined,
    query: async () => []
  };
}

function createTransport(
  objects: DistributedObject[] = [],
  peerIds = ['peer-a'],
  failedPeerIds: string[] = [],
  complete = true,
  forceHasMore = false,
  incompleteCursorPage = false
): FindClientTransport & {
  sentPackets: import('./types').ObjectPacket[];
} {
  const handlers = new Set<(peerId: string, packet: import('./types').ObjectPacket) => void>();
  const sentPackets: import('./types').ObjectPacket[] = [];
  return {
    sentPackets,
    connectedPeers: () => peerIds,
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async send(peerId, packet) {
      sentPackets.push(packet);
      if (packet.type !== 'FIND') throw new Error('Expected an inbox FIND packet');
      if (failedPeerIds.includes(peerId)) throw new Error('peer send failed');
      const requestId = packet.payload.requestId;
      const isCursorPage = packet.payload.page_before !== undefined;
      const pageObjects = isCursorPage && incompleteCursorPage
        ? []
        : objects.slice(0, packet.payload.limit ?? objects.length);
      const response: FindResponsePacket = {
        protocol: 'mycelium',
        version: 1,
        id: `response-${requestId}`,
        type: 'FIND_RESPONSE',
        timestamp: NOW.toISOString(),
        sender: peerId,
        recipient: MY_PUBLIC_KEY,
        payload: {
          objects: pageObjects,
          object_id: pageObjects[0]?.object_id ?? '',
          requestId,
          complete: incompleteCursorPage && isCursorPage ? false : complete,
          ...(packet.payload.order === 'created_at_desc' && packet.payload.limit !== undefined
            ? {
              pagination_supported: true,
              has_more: !isCursorPage && (forceHasMore || objects.length > packet.payload.limit)
            }
            : {})
        },
        signature: 'unsigned-v1'
      };
      for (const handler of handlers) handler(peerId, response);
    }
  };
}

function createRunner(options: {
  objects?: DistributedObject[];
  peerIds?: string[];
  failedPeerIds?: string[];
  complete?: boolean;
  forceHasMore?: boolean;
  incompleteCursorPage?: boolean;
  cursor?: string | null;
  backfillState?: InboxBackfillState | null;
  put?: (object: DistributedObject) => Promise<boolean>;
  saveCursor?: (identityKey: string, cursor: string) => Promise<unknown>;
  saveBackfillState?: (identityKey: string, state: InboxBackfillState | null) => Promise<unknown>;
  onStored?: (objects: DistributedObject[]) => void | Promise<void>;
} = {}) {
  const loadCursor = vi.fn(async () => options.cursor ?? null);
  const saveCursor = options.saveCursor ?? vi.fn(async () => undefined);
  const loadBackfillState = vi.fn(async () => options.backfillState ?? null);
  const saveBackfillState = options.saveBackfillState ?? vi.fn(async () => undefined);
  const transport = createTransport(
    options.objects,
    options.peerIds,
    options.failedPeerIds,
    options.complete,
    options.forceHasMore,
    options.incompleteCursorPage
  );
  const runner = createInboxRunner({
    myPublicKey: MY_PUBLIC_KEY,
    store: createStore(options.put),
    transport,
    loadCursor,
    saveCursor,
    loadBackfillState,
    saveBackfillState,
    onStored: options.onStored,
    now: () => NOW
  });
  return { ...runner, loadCursor, saveCursor, loadBackfillState, saveBackfillState, transport };
}

describe('inbox runner', () => {
  it('passes the loaded cursor to syncInbox and treats null as a full pull', async () => {
    const object = await createInboxObject('full-pull');
    const fullPull = createRunner({ objects: [object] });
    await fullPull.syncOnce();

    expect(fullPull.loadCursor).toHaveBeenCalledWith(MY_PUBLIC_KEY);
    expect(fullPull.saveCursor).toHaveBeenCalledWith(MY_PUBLIC_KEY, NOW.toISOString());
    expect(fullPull.transport.sentPackets[0].payload).not.toHaveProperty('created_after');

    const cursor = '2026-10-04T12:00:00.000Z';
    const incremental = createRunner({ objects: [object], cursor });
    await incremental.syncOnce();
    expect(incremental.loadCursor).toHaveBeenCalledWith(MY_PUBLIC_KEY);
    const findPacket = incremental.transport.sentPackets[0];
    if (!findPacket || findPacket.type !== 'FIND') throw new Error('Expected an inbox FIND packet');
    expect(findPacket.payload.created_after)
      .toBe(new Date(Date.parse(cursor) - 48 * 60 * 60 * 1000).toISOString());
  });

  it('saves the new cursor after a successful non-truncated sync', async () => {
    const object = await createInboxObject('cursor-save');
    const runner = createRunner({ objects: [object], cursor: '2026-10-04T12:00:00.000Z' });

    const result = await runner.syncOnce();

    expect(result).toEqual({ stored: 1, truncated: false });
    expect(runner.saveCursor).toHaveBeenCalledWith(MY_PUBLIC_KEY, NOW.toISOString());
  });

  it('does not advance either cursor when a page is truncated', async () => {
    const saveCursor = vi.fn(async () => undefined);
    const runner = createRunner({
      objects: [await createInboxObject('page-with-more')],
      forceHasMore: true,
      incompleteCursorPage: true,
      saveCursor,
    });
    const result = await runner.syncOnce();

    expect(result.truncated).toBe(true);
    expect(saveCursor).not.toHaveBeenCalled();
  });

  it('does not advance the inbox cursor after a peer returns an incomplete FIND page', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';
    const object = await createInboxObject('incomplete-find-page');
    const saveCursor = vi.fn(async () => undefined);
    const runner = createRunner({
      objects: [object],
      complete: false,
      cursor,
      saveCursor
    });

    const result = await runner.syncOnce();

    expect(result).toEqual({ stored: 1, truncated: true });
    expect(saveCursor).not.toHaveBeenCalled();
  });

  it('does not advance the inbox cursor on partial peer results, then advances after retry completes', async () => {
    const cursor = '2026-10-04T09:00:00.000Z';
    const object = await createInboxObject('partial-find');
    const storedIds = new Set<string>();
    const put = vi.fn(async (candidate: DistributedObject) => {
      if (storedIds.has(candidate.object_id)) return false;
      storedIds.add(candidate.object_id);
      return true;
    });
    const saveCursor = vi.fn(async () => undefined);
    const failedPeerIds = ['peer-b'];
    const runner = createRunner({
      objects: [object],
      peerIds: ['peer-a', 'peer-b'],
      failedPeerIds,
      cursor,
      put,
      saveCursor
    });

    const partial = await runner.syncOnce();
    expect(partial).toEqual({ stored: 1, truncated: true });
    expect(saveCursor).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);

    failedPeerIds.length = 0;
    const complete = await runner.syncOnce();
    expect(complete).toEqual({ stored: 0, truncated: false });
    expect(saveCursor).toHaveBeenCalledWith(MY_PUBLIC_KEY, NOW.toISOString());
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('does not save and rethrows when storing a received object fails', async () => {
    const object = await createInboxObject('store-error');
    const error = new Error('object store failed');
    const runner = createRunner({
      objects: [object],
      put: async () => { throw error; }
    });

    await expect(runner.syncOnce()).rejects.toBe(error);
    expect(runner.saveCursor).not.toHaveBeenCalled();
  });

  it('notifies only for newly stored objects and skips notification for an empty run', async () => {
    const object = await createInboxObject('newly-stored');
    const onStored = vi.fn();
    const firstRun = createRunner({ objects: [object], onStored });

    await firstRun.syncOnce();
    expect(onStored).toHaveBeenCalledOnce();
    expect(onStored).toHaveBeenCalledWith([object]);

    const emptyRun = createRunner({
      objects: [object],
      put: async () => false,
      onStored
    });
    await emptyRun.syncOnce();
    expect(onStored).toHaveBeenCalledOnce();
  });

  it('catches onStored failures without failing sync or blocking cursor save', async () => {
    const object = await createInboxObject('notification-error');
    const saved = vi.fn();
    const onStored = vi.fn(() => {
      expect(saved).toHaveBeenCalledOnce();
      throw new Error('notification failed');
    });
    const saveCursor = vi.fn(async () => { saved(); });
    const runner = createRunner({ objects: [object], onStored, saveCursor });

    await expect(runner.syncOnce()).resolves.toEqual({ stored: 1, truncated: false });
    expect(runner.saveCursor).toHaveBeenCalledOnce();
  });

  it('rethrows cursor persistence failures', async () => {
    const object = await createInboxObject('cursor-error');
    const error = new Error('cursor persistence failed');
    const runner = createRunner({
      objects: [object],
      saveCursor: async () => { throw error; }
    });

    await expect(runner.syncOnce()).rejects.toBe(error);
  });

  it('does not change cursors or fail when no peers are connected', async () => {
    const saveCursor = vi.fn(async () => undefined);
    const runner = createRunner({
      peerIds: [],
      cursor: '2026-10-04T12:00:00.000Z',
      saveCursor
    });

    await expect(runner.syncOnce()).resolves.toEqual({ stored: 0, truncated: true });
    expect(saveCursor).not.toHaveBeenCalled();
    expect(runner.saveBackfillState).toHaveBeenCalledWith(MY_PUBLIC_KEY, expect.objectContaining({
      cursor: expect.any(String),
      end: NOW.toISOString()
    }));
  });

  it('returns the newly stored count and truncated status', async () => {
    const objects = [
      await createInboxObject('count-1', '2026-10-05T11:01:00.000Z'),
      await createInboxObject('count-2', '2026-10-05T11:00:00.000Z')
    ];
    const runner = createRunner({ objects });

    await expect(runner.syncOnce()).resolves.toEqual({ stored: 2, truncated: false });
  });
});
