import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair
} from '../crypto/identity';
import {
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  generateEncryptionKeyPair
} from '../crypto/dm-crypto';
import type { Contact } from '../types';
import { createDmService } from './dm-service';
import { createOutboxService } from './outbox-service';
import type { DmObjectIdentity } from './dm-object';
import type { OutboxEntry, OutboxStore } from './local-store';
import type { DistributedObject, ObjectStore } from './types';

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

function makeObjectStore(records: DistributedObject[] = []): ObjectStore {
  return {
    async put(object) {
      records.push(object);
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
  replicate?: (object: DistributedObject, alreadyReplicatedTo: Set<string>) => Promise<string[]>;
  flush?: () => Promise<unknown>;
} = { identity: null }) {
  const records: DistributedObject[] = [];
  const outboxStore = makeOutboxStore();
  const connectedPeers = options.peers ?? [];
  const sends: Array<{ peerId: string; object: DistributedObject }> = [];
  const replicateCalls: Array<{ object: DistributedObject; alreadyReplicatedTo: Set<string> }> = [];
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
    replicate: options.replicate ?? (async (object, alreadyReplicatedTo) => {
      replicateCalls.push({ object, alreadyReplicatedTo });
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
    getContact: (publicKey) => options.contact?.publicKey === publicKey ? options.contact : null,
    store: makeObjectStore(records),
    outbox: options.flush
      ? {
          enqueue: (object) => outbox.enqueue(object),
          flush: options.flush,
          getEntry: (objectId) => outbox.getEntry(objectId),
          getReplicatedTo: (objectId) => outbox.getReplicatedTo(objectId)
        }
      : outbox,
    connectedPeers: () => connectedPeers,
    now: () => NOW
  });
  return { service, outbox, outboxStore, records, sends, replicateCalls, connectedPeers };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDmService', () => {
  it('stores, enqueues, flushes, directly sends, and replicates a connected recipient DM', async () => {
    const sender = await makeIdentity('sender');
    const recipient = await makeIdentity('recipient');
    const contact = makeContact(recipient);
    const harness = makeHarness({
      identity: sender,
      contact,
      peers: [contact.fingerprint, 'replica-peer'],
      replicate: async (object) => {
        harness.replicateCalls.push({ object, alreadyReplicatedTo: new Set() });
        return ['replica-peer'];
      }
    });

    const result = await harness.service.sendMessage(contact.publicKey, 'encrypted message');

    expect(result.status).toBe('sent');
    expect(result.queued).toBe(false);
    expect(harness.records).toHaveLength(1);
    expect(harness.sends).toMatchObject([{ peerId: contact.fingerprint }]);
    expect(harness.replicateCalls).toHaveLength(1);
    expect(await harness.outbox.getEntry(harness.records[0].object_id)).toBeNull();
    expect(harness.outbox.getReplicatedTo(harness.records[0].object_id)).toEqual(['replica-peer']);
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
        getReplicatedTo: () => []
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
      replicated_to: [],
      delivered_direct: false
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
