import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveFingerprint,
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair
} from '../crypto/identity';
import {
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  generateEncryptionKeyPair
} from '../crypto/dm-crypto';
import type { Contact, WebPushCapability } from '../types';
import { createDmService } from './dm-service';
import { createOutboxService } from './outbox-service';
import type { DmObjectIdentity } from './dm-object';
import type { OutboxEntry, OutboxStore } from './local-store';
import type { DistributedObject, ObjectStore } from './types';
import type { WebPushDispatchResult } from '../services/web-push-dispatch';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-10-05T12:00:00.000Z');

type TestIdentity = DmObjectIdentity & {
  id: string;
  publicKey: string;
  privateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
};

async function makeIdentity(id: string): Promise<TestIdentity> {
  const signing = await generateIdentityKeyPair();
  const encryption = await generateEncryptionKeyPair();
  return {
    id,
    publicKey: await exportPublicKey(signing.publicKey),
    privateKey: await exportPrivateKey(signing.privateKey),
    encryptionPublicKey: await exportEncryptionPublicKey(encryption.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(encryption.privateKey)
  };
}

function makeContact(identity: TestIdentity): Contact {
  return {
    publicKey: identity.publicKey,
    fingerprint: `peer-${identity.id}`,
    addedAt: NOW.toISOString(),
    followed: false,
    encryptionPublicKey: identity.encryptionPublicKey
  };
}

function makeOutboxStore(): OutboxStore {
  const entries = new Map<string, OutboxEntry>();
  return {
    async add(entry) {
      if (!entries.has(entry.object_id)) entries.set(entry.object_id, structuredClone(entry));
    },
    async get(objectId) {
      const entry = entries.get(objectId);
      return entry ? structuredClone(entry) : null;
    },
    async listPending(limit) {
      return [...entries.values()]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },
    async update(entry) {
      entries.set(entry.object_id, structuredClone(entry));
    },
    async remove(objectId) {
      entries.delete(objectId);
    },
    async pruneExpired(now) {
      let removed = 0;
      for (const entry of entries.values()) {
        if (Date.parse(entry.expires_at) <= now.getTime()) {
          entries.delete(entry.object_id);
          removed += 1;
        }
      }
      return removed;
    }
  };
}

async function makePushIdentity(id: string): Promise<TestIdentity> {
  const identity = await makeIdentity(id);
  return { ...identity, id: await deriveFingerprint(identity.publicKey) };
}

async function makePushContact(identity: TestIdentity, overrides: Partial<Contact> = {}): Promise<Contact> {
  return {
    publicKey: identity.publicKey,
    fingerprint: await deriveFingerprint(identity.publicKey),
    addedAt: NOW.toISOString(),
    followed: false,
    encryptionPublicKey: identity.encryptionPublicKey,
    webPush: {
      endpoint: 'https://push.example.test/subscription',
      p256dh: 'public-key',
      auth: 'auth-secret'
    },
    ...overrides
  };
}

function makeObjectStore(
  records: DistributedObject[] = [],
  options: { events?: string[]; storeFailure?: boolean; storeNotAdmitted?: boolean } = {}
): ObjectStore {
  return {
    async put(object) {
      if (options.storeFailure) throw new Error('store failure');
      if (options.storeNotAdmitted) return false;
      records.push(object);
      options.events?.push('stored');
      return true;
    },
    async get(objectId) {
      return records.find((object) => object.object_id === objectId) ?? null;
    },
    async delete() {},
    async query() {
      return records;
    }
  };
}

function makeHarness(options: {
  identity: DmObjectIdentity | null;
  contact?: Contact | null;
  peers?: string[];
  sendDirect?: (peerId: string, object: DistributedObject) => Promise<boolean>;
  replicate?: (object: DistributedObject, alreadyAttemptedTo: Set<string>) => Promise<string[]>;
  flush?: () => Promise<unknown>;
  enqueueFailure?: boolean;
  storeFailure?: boolean;
  storeNotAdmitted?: boolean;
  events?: string[];
  blockedPeers?: ReadonlySet<string>;
  getBlockedPeers?: () => ReadonlySet<string>;
  dispatch?: (
    object: DistributedObject,
    capability: WebPushCapability
  ) => Promise<WebPushDispatchResult>;
  invalidateWebPushCapability?: (
    publicKey: string,
    fingerprint: string,
    capability: WebPushCapability
  ) => Promise<void>;
  getContact?: (publicKey: string) => Contact | null;
} = { identity: null }) {
  const records: DistributedObject[] = [];
  const outboxStore = makeOutboxStore();
  const connectedPeers = options.peers ?? [];
  const sends: Array<{ peerId: string; object: DistributedObject }> = [];
  const replicateCalls: Array<{ object: DistributedObject; alreadyAttemptedTo: Set<string> }> = [];
  const outbox = createOutboxService({
    outbox: outboxStore,
    objectStore: {
      async get(objectId) {
        return records.find((object) => object.object_id === objectId) ?? null;
      }
    },
    sendDirect: options.sendDirect ?? (async (peerId, object) => {
      sends.push({ peerId, object });
      return true;
    }),
    replicate: options.replicate ?? (async (object, alreadyAttemptedTo) => {
      replicateCalls.push({ object, alreadyAttemptedTo });
      return [];
    }),
    resolveRecipientPeerId: (publicKey) => publicKey === options.contact?.publicKey
      ? options.contact.fingerprint
      : null,
    connectedPeers: () => connectedPeers,
    now: () => NOW
  });
  const service = createDmService({
    getIdentity: () => options.identity ?? null,
    getContact: options.getContact
      ?? ((publicKey) => options.contact?.publicKey === publicKey ? options.contact : null),
    store: makeObjectStore(records, {
      events: options.events,
      storeFailure: options.storeFailure,
      storeNotAdmitted: options.storeNotAdmitted
    }),
    outbox: options.flush || options.enqueueFailure || options.events
      ? {
          enqueue: async (object) => {
            if (options.enqueueFailure) throw new Error('enqueue failure');
            await outbox.enqueue(object);
            options.events?.push('enqueued');
          },
          flush: options.flush ?? (() => outbox.flush()),
          getEntry: (objectId) => outbox.getEntry(objectId),
          getAttemptedTo: (objectId) => outbox.getAttemptedTo(objectId)
        }
      : outbox,
    connectedPeers: () => connectedPeers,
    getBlockedPeers: options.getBlockedPeers
      ?? (() => options.blockedPeers ?? new Set<string>()),
    invalidateWebPushCapability: options.invalidateWebPushCapability,
    dispatchWebPush: options.dispatch
      ? async (object, capability) => {
          options.events?.push('dispatched');
          return await options.dispatch?.(object, capability) ?? { status: 'accepted' };
        }
      : undefined,
    now: () => NOW
  });
  return { service, outbox, outboxStore, records, sends, replicateCalls, connectedPeers };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDmService', () => {
  it('dispatches the canonical encrypted DM once after local storage and enqueue', async () => {
    const sender = await makePushIdentity('sender');
    const recipient = await makePushIdentity('recipient');
    const contact = await makePushContact(recipient);
    const events: string[] = [];
    const dispatch = vi.fn(async () => ({ status: 'accepted' } as const));
    const harness = makeHarness({
      identity: sender,
      contact,
      events,
      dispatch,
      peers: []
    });

    const result = await harness.service.sendMessage(contact.publicKey, 'private message');

    expect(result.status).toBe('sent');
    if (result.status !== 'sent') throw new Error('Expected a sent DM');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith(result.object, contact.webPush);
    expect(result.object.object_type).toBe('mycelium.dm');
    expect(result.object.recipient).toBe(recipient.publicKey);
    expect(JSON.stringify(result.object.payload)).not.toContain('private message');
    expect(events.indexOf('stored')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('enqueued')).toBeGreaterThan(events.indexOf('stored'));
    expect(events.indexOf('dispatched')).toBeGreaterThan(events.indexOf('enqueued'));

    await harness.service.flushOutbox();
    await harness.service.flushOutbox();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('conditionally invalidates the exact recipient capability after a permanent dispatch failure', async () => {
    const sender = await makePushIdentity('sender');
    const recipient = await makePushIdentity('recipient');
    const contact = await makePushContact(recipient);
    const dispatch = vi.fn(async () => ({ status: 'invalid-subscription' } as const));
    const invalidateWebPushCapability = vi.fn(async () => {});
    const harness = makeHarness({
      identity: sender,
      contact,
      dispatch,
      invalidateWebPushCapability,
      peers: []
    });

    const result = await harness.service.sendMessage(contact.publicKey, 'private message');

    expect(result.status).toBe('sent');
    if (result.status !== 'sent') throw new Error('Expected a sent DM');
    await vi.waitFor(() => expect(invalidateWebPushCapability).toHaveBeenCalledOnce());
    expect(invalidateWebPushCapability).toHaveBeenCalledWith(
      recipient.publicKey,
      await deriveFingerprint(recipient.publicKey),
      contact.webPush
    );
    await harness.service.flushOutbox();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(invalidateWebPushCapability).toHaveBeenCalledOnce();
  });

  it('does not dispatch when recipient identity or capability is unavailable or inconsistent', async () => {
    const sender = await makePushIdentity('sender');
    const recipient = await makePushIdentity('recipient');
    const other = await makePushIdentity('other');
    const validContact = await makePushContact(recipient);

    const cases: Array<{
      contact: Contact | undefined;
      getContact?: (publicKey: string) => Contact | null;
    }> = [
      { contact: undefined },
      { contact: await makePushContact(recipient, { fingerprint: 'wrong-fingerprint' }) },
      { contact: await makePushContact(recipient, { webPush: undefined }) },
      {
        contact: await makePushContact(recipient, {
          webPush: { ...validContact.webPush!, endpoint: 'http://push.example.test' }
        })
      },
      {
        contact: validContact,
        getContact: vi.fn()
          .mockReturnValueOnce(validContact)
          .mockReturnValueOnce(await makePushContact(other, {
            fingerprint: await deriveFingerprint(recipient.publicKey)
          }))
      }
    ];

    for (const testCase of cases) {
      const dispatch = vi.fn(async () => ({ status: 'accepted' } as const));
      const getContact = testCase.getContact ?? vi.fn((publicKey: string) =>
        testCase.contact?.publicKey === publicKey ? testCase.contact : null
      );
      const harness = makeHarness({
        identity: sender,
        contact: testCase.contact,
        getContact,
        dispatch,
        peers: []
      });

      await harness.service.sendMessage(recipient.publicKey, 'private message');
      if (testCase.contact) {
        await vi.waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
      }
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it('skips dispatch for blocks by recipient public key or fingerprint and for self-recipient sends', async () => {
    const sender = await makePushIdentity('sender');
    const recipient = await makePushIdentity('recipient');
    const cases = [
      {
        contact: await makePushContact(recipient),
        blockedPeers: new Set([recipient.publicKey])
      },
      {
        contact: await makePushContact(recipient),
        blockedPeers: new Set([await deriveFingerprint(recipient.publicKey)])
      },
      {
        contact: await makePushContact(sender),
        blockedPeers: new Set<string>()
      }
    ];

    for (const testCase of cases) {
      const dispatch = vi.fn(async () => ({ status: 'accepted' } as const));
      const getBlockedPeers = vi.fn(() => testCase.blockedPeers);
      const harness = makeHarness({
        identity: sender,
        contact: testCase.contact,
        blockedPeers: testCase.blockedPeers,
        getBlockedPeers,
        dispatch,
        peers: []
      });

      await harness.service.sendMessage(testCase.contact.publicKey, 'private message');
      if (testCase.contact.publicKey !== sender.publicKey) {
        await vi.waitFor(() => expect(getBlockedPeers).toHaveBeenCalledOnce());
      }
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it('does not dispatch when local storage does not admit the DM or outbox enqueue fails', async () => {
    const sender = await makePushIdentity('sender');
    const recipient = await makePushIdentity('recipient');
    const contact = await makePushContact(recipient);
    const dispatch = vi.fn(async () => ({ status: 'accepted' } as const));

    const storageFailure = makeHarness({
      identity: sender,
      contact,
      storeFailure: true,
      dispatch
    });
    await expect(storageFailure.service.sendMessage(contact.publicKey, 'private message'))
      .resolves.toMatchObject({ status: 'store_failed' });
    expect(dispatch).not.toHaveBeenCalled();

    const storageNotAdmitted = makeHarness({
      identity: sender,
      contact,
      storeNotAdmitted: true,
      dispatch
    });
    await expect(storageNotAdmitted.service.sendMessage(contact.publicKey, 'private message'))
      .resolves.toMatchObject({ status: 'store_failed' });
    expect(dispatch).not.toHaveBeenCalled();

    const enqueueFailure = makeHarness({
      identity: sender,
      contact,
      enqueueFailure: true,
      dispatch,
      peers: []
    });
    await enqueueFailure.service.sendMessage(contact.publicKey, 'private message');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a successful DM send and P2P enqueue when dispatch rejects', async () => {
    const sender = await makePushIdentity('sender');
    const recipient = await makePushIdentity('recipient');
    const contact = await makePushContact(recipient);
    const dispatch = vi.fn(async () => { throw new Error('sensitive delivery detail'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const harness = makeHarness({
      identity: sender,
      contact,
      dispatch,
      peers: []
    });

    const result = await harness.service.sendMessage(contact.publicKey, 'private message');

    expect(result.status).toBe('sent');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Web Push direct-message dispatch failed unexpectedly'
    ));
    expect(await harness.outbox.getEntry(harness.records[0].object_id)).not.toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive delivery detail');
  });

  it('does not dispatch incoming or retried DMs from later outbox flushes', async () => {
    const sender = await makePushIdentity('sender');
    const recipient = await makePushIdentity('recipient');
    const contact = await makePushContact(recipient);
    const dispatch = vi.fn(async () => ({ status: 'accepted' } as const));
    const harness = makeHarness({
      identity: sender,
      contact,
      dispatch,
      peers: []
    });

    await harness.service.sendMessage(contact.publicKey, 'private message');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    await harness.service.flushOutbox();
    await harness.service.flushOutbox();
    expect(dispatch).toHaveBeenCalledOnce();

    await harness.outbox.enqueue({
      ...harness.records[0],
      object_id: 'a'.repeat(64),
      author: recipient.publicKey
    });
    await harness.service.flushOutbox();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('stores, enqueues, flushes, directly sends, and replicates a connected recipient DM', async () => {
    const sender = await makeIdentity('sender');
    const recipient = await makeIdentity('recipient');
    const contact = makeContact(recipient);
    const harness = makeHarness({
      identity: sender,
      contact,
      peers: [contact.fingerprint, 'replica-peer'],
      replicate: async (object) => {
        harness.replicateCalls.push({ object, alreadyAttemptedTo: new Set() });
        return ['replica-peer'];
      }
    });

    const result = await harness.service.sendMessage(contact.publicKey, 'encrypted message');

    expect(result.status).toBe('sent');
    expect(result.queued).toBe(false);
    expect(harness.records).toHaveLength(1);
    expect(harness.sends).toMatchObject([{ peerId: contact.fingerprint }]);
    expect(harness.replicateCalls).toHaveLength(1);
    expect(await harness.outbox.getEntry(harness.records[0].object_id)).toMatchObject({
      direct_send_attempted: true,
      replication_send_attempted: true
    });
    expect(harness.outbox.getAttemptedTo(harness.records[0].object_id)).toEqual([
      contact.fingerprint,
      'replica-peer'
    ]);
  });

  it('returns no_key for an unknown contact without storing or enqueuing', async () => {
    const sender = await makeIdentity('sender');
    const enqueue = vi.fn();
    const harness = makeHarness({ identity: sender });
    const service = createDmService({
      getIdentity: () => sender,
      getContact: () => null,
      store: makeObjectStore(harness.records),
      outbox: {
        enqueue,
        flush: async () => ({}),
        getEntry: async () => null,
        getAttemptedTo: () => []
      },
      connectedPeers: () => []
    });

    await expect(service.sendMessage('unknown-public-key', 'message')).resolves.toMatchObject({
      status: 'no_key',
      queued: false
    });
    expect(harness.records).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns sent and leaves the DM queued when no peers are connected', async () => {
    const sender = await makeIdentity('sender');
    const recipient = await makeIdentity('recipient');
    const contact = makeContact(recipient);
    const harness = makeHarness({ identity: sender, contact, peers: [] });

    const result = await harness.service.sendMessage(contact.publicKey, 'offline message');

    expect(result.status).toBe('sent');
    expect(result.queued).toBe(true);
    expect(harness.records).toHaveLength(1);
    expect(await harness.outbox.getEntry(harness.records[0].object_id)).toMatchObject({
      attempts: 1,
      replication_send_attempted: false,
      direct_send_attempted: false
    });
    expect(harness.sends).toEqual([]);
    expect(harness.replicateCalls).toHaveLength(1);
  });

  it('returns invalid without throwing when identity is not ready', async () => {
    const recipient = await makeIdentity('recipient');
    const contact = makeContact(recipient);
    const harness = makeHarness({ identity: null, contact });

    await expect(harness.service.sendMessage(contact.publicKey, 'message')).resolves.toMatchObject({
      status: 'invalid',
      queued: false
    });
    expect(harness.records).toHaveLength(0);
  });

  it('swallows outbox flush failures', async () => {
    const sender = await makeIdentity('sender');
    const harness = makeHarness({
      identity: sender,
      flush: async () => { throw new Error('outbox failure'); }
    });

    await expect(harness.service.flushOutbox()).resolves.toBeUndefined();
  });

  it('shares one in-flight outbox flush across overlapping calls', async () => {
    let resolveFlush!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { resolveFlush = resolve; }));
    const sender = await makeIdentity('sender');
    const harness = makeHarness({ identity: sender, flush });

    const first = harness.service.flushOutbox();
    const second = harness.service.flushOutbox();
    expect(second).toBe(first);
    expect(flush).toHaveBeenCalledTimes(1);
    resolveFlush();
    await Promise.all([first, second]);
  });

  it('does not log or store plaintext in clear text', async () => {
    const sender = await makeIdentity('sender');
    const recipient = await makeIdentity('recipient');
    const contact = makeContact(recipient);
    const plaintext = 'unique-dm-service-plaintext-hygiene';
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error')
    ];
    const harness = makeHarness({ identity: sender, contact, peers: [] });

    const result = await harness.service.sendMessage(contact.publicKey, plaintext);
    const outboxEntry = await harness.outbox.getEntry(harness.records[0].object_id);

    expect(result.status).toBe('sent');
    expect(JSON.stringify(harness.records)).not.toContain(plaintext);
    expect(JSON.stringify(outboxEntry)).not.toContain(plaintext);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify(spy.mock.calls)).not.toContain(plaintext);
    }
  });
});
