import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createSignedObject } from './envelope';
import { createObjectIdentity } from './identity';
import { createDmEvents } from './dm-events';
import { createInboxService } from './inbox-service';
import type { DistributedObject, FindResponsePacket, ObjectPacket, ObjectStore } from './types';
import type { FindClientTransport } from './find-client';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-10-05T12:00:00.000Z');
const MY_PUBLIC_KEY = 'service-recipient';

async function createObject(id: string, options: {
  type?: string;
  recipient?: string;
} = {}): Promise<DistributedObject> {
  const pair = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const privateKey = await exportPrivateKey(pair.privateKey);
  return createSignedObject({
    object_type: options.type ?? 'mycelium.dm',
    recipient: options.recipient ?? MY_PUBLIC_KEY,
    created_at: '2026-10-05T11:00:00.000Z',
    payload: { id },
    replication_policy: {}
  }, createObjectIdentity({ id: 'service-sender', publicKey, privateKey }));
}

function createStore(objects: DistributedObject[] = []): ObjectStore {
  const stored = new Set<string>();
  return {
    async put(object) {
      if (stored.has(object.object_id)) return false;
      stored.add(object.object_id);
      objects.push(object);
      return true;
    },
    async get(objectId) {
      return objects.find((object) => object.object_id === objectId) ?? null;
    },
    async delete() {},
    async query() { return objects; }
  };
}

function createTransport(objects: DistributedObject[] = [], peers: string[] = []): FindClientTransport {
  const handlers = new Set<(peerId: string, packet: ObjectPacket) => void>();
  return {
    connectedPeers: () => peers,
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async send(peerId, packet) {
      if (packet.type !== 'FIND') return;
      const response: FindResponsePacket = {
        protocol: 'mycelium',
        version: 1,
        id: 'find-response-id',
        type: 'FIND_RESPONSE',
        timestamp: NOW.toISOString(),
        sender: peerId,
        recipient: MY_PUBLIC_KEY,
        payload: { objects, object_id: objects[0]?.object_id ?? '', requestId: packet.payload.requestId },
        signature: 'signature'
      };
      handlers.forEach((handler) => handler(peerId, response));
    }
  };
}

function createService(options: {
  myPublicKey?: string;
  objects?: DistributedObject[];
  peers?: string[];
  store?: ObjectStore;
  events?: ReturnType<typeof createDmEvents>;
  loadCursor?: () => Promise<string | null>;
  saveCursor?: (identityKey: string, cursor: string) => Promise<unknown>;
  controllerConfig?: { debounceMs?: number; minGapMs?: number; intervalMs?: number };
} = {}) {
  const loadCursor = vi.fn(options.loadCursor ?? (async () => null));
  const saveCursor = vi.fn(options.saveCursor ?? (async () => undefined));
  const service = createInboxService({
    myPublicKey: options.myPublicKey ?? MY_PUBLIC_KEY,
    store: options.store ?? createStore(),
    transport: createTransport(options.objects, options.peers),
    loadCursor,
    saveCursor,
    events: options.events ?? createDmEvents(),
    controllerConfig: {
      debounceMs: 50,
      minGapMs: 0,
      intervalMs: 60_000,
      ...options.controllerConfig
    },
    now: () => new Date(Date.now()),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
  });
  return { ...service, loadCursor, saveCursor };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('inbox service', () => {
  it('starts the controller and triggers an initial sync', async () => {
    vi.useFakeTimers();
    const service = createService();

    service.start();
    await flushMicrotasks();

    expect(service.loadCursor).toHaveBeenCalledWith(MY_PUBLIC_KEY);
    service.stop();
  });

  it('coalesces a peer-connected burst into one sync', async () => {
    vi.useFakeTimers();
    const service = createService();
    service.start();
    await flushMicrotasks();
    const initialCalls = service.loadCursor.mock.calls.length;

    service.notifyPeerConnected();
    await vi.advanceTimersByTimeAsync(20);
    service.notifyPeerConnected();
    await vi.advanceTimersByTimeAsync(20);
    service.notifyPeerConnected();
    await vi.advanceTimersByTimeAsync(49);
    expect(service.loadCursor).toHaveBeenCalledTimes(initialCalls);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(service.loadCursor).toHaveBeenCalledTimes(initialCalls + 1);
    service.stop();
  });

  it('emits addressed stored DMs exactly once', async () => {
    const events = createDmEvents();
    const handler = vi.fn();
    events.onDmArrived(handler);
    const object = await createObject('addressed');
    const service = createService({ events, objects: [object], peers: ['peer-a'] });

    service.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    service.notifyObjectStored(object);

    expect(handler).toHaveBeenCalledWith(object);
    service.stop();
  });

  it('ignores DMs for others and non-DM objects', async () => {
    const events = createDmEvents();
    const handler = vi.fn();
    events.onDmArrived(handler);
    const service = createService({ events });

    service.notifyObjectStored(await createObject('other-recipient', { recipient: 'someone-else' }));
    service.notifyObjectStored(await createObject('not-dm', { type: 'mycelium.post' }));

    expect(handler).not.toHaveBeenCalled();
    service.stop();
  });

  it('deduplicates repeated deliveries by object ID', async () => {
    const events = createDmEvents();
    const handler = vi.fn();
    events.onDmArrived(handler);
    const service = createService({ events });
    const object = await createObject('repeated');

    service.notifyObjectStored(object);
    service.notifyObjectStored({ ...object });

    expect(handler).toHaveBeenCalledOnce();
    service.stop();
  });

  it('stop prevents subsequent syncs and DM emissions', async () => {
    vi.useFakeTimers();
    const events = createDmEvents();
    const handler = vi.fn();
    events.onDmArrived(handler);
    const service = createService({ events });
    service.start();
    await flushMicrotasks();
    service.stop();
    const callsAtStop = service.loadCursor.mock.calls.length;

    service.notifyPeerConnected();
    service.notifyObjectStored(await createObject('after-stop'));
    await vi.advanceTimersByTimeAsync(100_000);
    await flushMicrotasks();

    expect(service.loadCursor).toHaveBeenCalledTimes(callsAtStop);
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates events between services for different identities', async () => {
    const firstEvents = createDmEvents();
    const secondEvents = createDmEvents();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    firstEvents.onDmArrived(firstHandler);
    secondEvents.onDmArrived(secondHandler);
    const firstService = createService({ myPublicKey: 'identity-one', events: firstEvents });
    const secondService = createService({ myPublicKey: 'identity-two', events: secondEvents });
    const firstDm = await createObject('identity-one-dm', { recipient: 'identity-one' });
    const secondDm = await createObject('identity-two-dm', { recipient: 'identity-two' });

    firstService.notifyObjectStored(firstDm);
    secondService.notifyObjectStored(secondDm);

    expect(firstHandler).toHaveBeenCalledExactlyOnceWith(firstDm);
    expect(secondHandler).toHaveBeenCalledExactlyOnceWith(secondDm);
    firstService.stop();
    secondService.stop();
  });
});
