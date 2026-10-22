import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receiveObjectPacket } from '../object-layer/transport';
import type { DistributedObject, ObjectStore } from '../object-layer/types';
import {
  parseIncomingWebPushEnvelope,
  parseStagedWebPushMessage,
  WEB_PUSH_ENVELOPE_MAX_BYTES,
  WEB_PUSH_STAGED_MESSAGE_TYPE,
  WEB_PUSH_STAGING_MAX_ENTRIES
} from './web-push-inbox';

const OBJECT_ID = 'a'.repeat(64);
const OBJECT: DistributedObject = {
  object_id: OBJECT_ID,
  object_type: 'mycelium.post',
  author: 'author-public-key',
  created_at: '2026-10-22T10:00:00.000Z',
  payload: { text: 'untrusted push data' },
  signature: 'not-a-valid-signature',
  replication_policy: {}
};

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('incoming Web Push envelope validation', () => {
  it('accepts the supported inline object and reference envelopes', () => {
    expect(parseIncomingWebPushEnvelope({ version: 1, type: 'object', object: OBJECT }))
      .toMatchObject({ version: 1, type: 'object', object: { object_id: OBJECT_ID } });
    expect(parseIncomingWebPushEnvelope({ version: 1, type: 'reference', object_id: OBJECT_ID }))
      .toEqual({ version: 1, type: 'reference', object_id: OBJECT_ID });
  });

  it('rejects unsupported versions, types, malformed envelopes, and invalid references', () => {
    for (const envelope of [
      { version: 2, type: 'reference', object_id: OBJECT_ID },
      { version: 1, type: 'other', object_id: OBJECT_ID },
      { version: 1, type: 'reference', object_id: '../arbitrary' },
      { version: 1, type: 'reference', object_id: OBJECT_ID, url: 'https://example.test' },
      { version: 1, type: 'object', object: { ...OBJECT, object_id: 'bad' } },
      { version: 1, type: 'object', object: { ...OBJECT, payload: undefined } },
      null,
      'not-json'
    ]) {
      expect(parseIncomingWebPushEnvelope(envelope)).toBeNull();
    }
  });

  it('rejects oversized inline objects and deeply nested structures', () => {
    expect(parseIncomingWebPushEnvelope({
      version: 1,
      type: 'object',
      object: { ...OBJECT, payload: { text: 'x'.repeat(WEB_PUSH_ENVELOPE_MAX_BYTES) } }
    })).toBeNull();

    let nested: unknown = 'leaf';
    for (let index = 0; index < 40; index += 1) nested = { child: nested };
    expect(parseIncomingWebPushEnvelope({
      version: 1,
      type: 'object',
      object: { ...OBJECT, payload: nested }
    })).toBeNull();
  });

  it('validates staged item IDs and enforces a bounded batch size', () => {
    const item = {
      id: OBJECT_ID,
      envelope: { version: 1, type: 'reference', object_id: OBJECT_ID }
    };
    expect(parseStagedWebPushMessage({
      type: WEB_PUSH_STAGED_MESSAGE_TYPE,
      items: [item]
    })).toEqual([{ id: OBJECT_ID, envelope: item.envelope }]);
    expect(parseStagedWebPushMessage({
      type: WEB_PUSH_STAGED_MESSAGE_TYPE,
      items: [{ ...item, id: 'b'.repeat(64) }]
    })).toBeNull();
    expect(parseStagedWebPushMessage({
      type: WEB_PUSH_STAGED_MESSAGE_TYPE,
      items: Array.from({ length: WEB_PUSH_STAGING_MAX_ENTRIES + 1 }, () => item)
    })).toBeNull();
  });

  it('does not commit a structurally valid pushed object before ordinary object verification', async () => {
    const envelope = parseIncomingWebPushEnvelope({
      version: 1,
      type: 'object',
      object: OBJECT
    });
    expect(envelope?.type).toBe('object');
    const put = vi.fn(async () => true);
    const store = { put } as unknown as ObjectStore;
    const accepted = await receiveObjectPacket({
      protocol: 'mycelium',
      version: 1,
      id: 'push-stage-test',
      type: 'OBJECT_STORE',
      timestamp: new Date().toISOString(),
      sender: 'web-push',
      recipient: null,
      payload: { object: OBJECT },
      signature: 'untrusted-internal-handoff'
    }, store);

    expect(accepted).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('service-worker Web Push staging', () => {
  function createWorkerHarness() {
    const handlers = new Map<string, (event: any) => void>();
    const records = new Map<string, Response>();
    const clientMessages: unknown[] = [];
    let openClients: Array<{ postMessage: (message: unknown) => void }> = [];
    let failStorage = false;
    const cache = {
      put: vi.fn(async (request: Request, response: Response) => {
        records.set(request.url, response.clone());
      }),
      match: vi.fn(async (request: Request) => records.get(request.url)?.clone()),
      keys: vi.fn(async () => [...records.keys()].map((url) => new Request(url))),
      delete: vi.fn(async (request: Request) => records.delete(request.url))
    };
    const context = {
      self: {
        location: { origin: 'https://mycelium.example' },
        clients: {
          matchAll: vi.fn(async () => openClients),
        },
        addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener)
      },
      caches: {
        open: vi.fn(async () => {
          if (failStorage) throw new Error('storage unavailable');
          return cache;
        })
      },
      fetch: vi.fn(async () => new Response('network')),
      Request,
      Response,
      URL,
      TextEncoder,
      TextDecoder,
      Promise,
      console
    };
    vm.runInNewContext(
      readFileSync(new URL('../../public/service-worker.js', import.meta.url), 'utf8'),
      context
    );
    return {
      handlers,
      records,
      clientMessages,
      cache,
      setOpenClients(clients: Array<{ postMessage: (message: unknown) => void }>) {
        openClients = clients;
      },
      failStorage() {
        failStorage = true;
      },
      async dispatchPush(value: unknown) {
        const raw = JSON.stringify(value);
        let pending: Promise<unknown> = Promise.resolve();
        const event = {
          data: {
            arrayBuffer: async () => new TextEncoder().encode(raw).buffer
          },
          waitUntil(promise: Promise<unknown>) {
            pending = promise;
          }
        };
        handlers.get('push')?.(event);
        await pending;
      },
      async dispatchDrain(client: { postMessage: (message: unknown) => void }) {
        let pending: Promise<unknown> = Promise.resolve();
        handlers.get('message')?.({
          data: { type: 'MYCELIUM_PUSH_DRAIN_V1' },
          source: client,
          waitUntil(promise: Promise<unknown>) {
            pending = promise;
          }
        });
        await pending;
      }
    };
  }

  it('stages pushes while no app client is open and serves them on a later drain', async () => {
    const harness = createWorkerHarness();
    const envelope = { version: 1, type: 'reference', object_id: OBJECT_ID };
    await harness.dispatchPush(envelope);
    expect(harness.records.size).toBe(1);

    const client = { postMessage: vi.fn((message) => harness.clientMessages.push(message)) };
    await harness.dispatchDrain(client);
    expect(client.postMessage).toHaveBeenCalledOnce();
    expect(harness.clientMessages[0]).toMatchObject({
      type: WEB_PUSH_STAGED_MESSAGE_TYPE,
      items: [{ id: OBJECT_ID, envelope }]
    });
  });

  it('stages inline objects without trusting or interpreting their payload', async () => {
    const harness = createWorkerHarness();
    await harness.dispatchPush({ version: 1, type: 'object', object: OBJECT });
    expect(harness.records.size).toBe(1);
    const staged = await [...harness.records.values()][0]?.json();
    expect(staged).toEqual({ version: 1, type: 'object', object: OBJECT });
    expect((staged as { object: DistributedObject }).object.signature).toBe('not-a-valid-signature');
  });

  it('deduplicates repeated deliveries by canonical object ID', async () => {
    const harness = createWorkerHarness();
    await harness.dispatchPush({ version: 1, type: 'reference', object_id: OBJECT_ID });
    await harness.dispatchPush({ version: 1, type: 'reference', object_id: OBJECT_ID });
    expect(harness.records.size).toBe(1);
  });

  it('ignores unsupported, malformed, and oversized payloads without crashing', async () => {
    const harness = createWorkerHarness();
    await harness.dispatchPush({ version: 2, type: 'reference', object_id: OBJECT_ID });
    await harness.dispatchPush({ version: 1, type: 'unknown', object_id: OBJECT_ID });
    await harness.dispatchPush({ version: 1, type: 'reference', object_id: 'bad' });
    await harness.dispatchPush({
      version: 1,
      type: 'object',
      object: { ...OBJECT, payload: { text: 'x'.repeat(WEB_PUSH_ENVELOPE_MAX_BYTES) } }
    });
    expect(harness.records.size).toBe(0);
  });

  it('handles storage and client communication failures without rejecting the push event', async () => {
    const unavailable = createWorkerHarness();
    unavailable.failStorage();
    await expect(unavailable.dispatchPush({
      version: 1,
      type: 'reference',
      object_id: OBJECT_ID
    })).resolves.toBeUndefined();

    const clientFailure = createWorkerHarness();
    clientFailure.setOpenClients([{ postMessage: () => { throw new Error('closed client'); } }]);
    await expect(clientFailure.dispatchPush({
      version: 1,
      type: 'reference',
      object_id: OBJECT_ID
    })).resolves.toBeUndefined();
    expect(clientFailure.records.size).toBe(1);
  });

  it('bounds staged entries and acknowledges only valid IDs', async () => {
    const harness = createWorkerHarness();
    for (let index = 0; index < WEB_PUSH_STAGING_MAX_ENTRIES + 1; index += 1) {
      await harness.dispatchPush({
        version: 1,
        type: 'reference',
        object_id: index.toString(16).padStart(64, '0')
      });
    }
    expect(harness.records.size).toBe(WEB_PUSH_STAGING_MAX_ENTRIES);

    let pending: Promise<unknown> = Promise.resolve();
    const acknowledgedId = '1'.padStart(64, '0');
    harness.handlers.get('message')?.({
      data: { type: 'MYCELIUM_PUSH_ACK_V1', ids: [acknowledgedId, '../invalid'] },
      waitUntil(promise: Promise<unknown>) {
        pending = promise;
      }
    });
    await pending;
    expect(harness.records.size).toBe(WEB_PUSH_STAGING_MAX_ENTRIES - 1);
    expect([...harness.records.keys()].some((key) => key.endsWith(acknowledgedId))).toBe(false);
  });
});
