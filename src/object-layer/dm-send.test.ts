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
import { decryptDmObject, type DmObjectIdentity } from './dm-object';
import { sendDm, type DmRecipientContact } from './dm-send';
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

async function createIdentity(id: string): Promise<TestIdentity> {
  const signingPair = await generateIdentityKeyPair();
  const encryptionPair = await generateEncryptionKeyPair();
  const publicKey = await exportPublicKey(signingPair.publicKey);
  return {
    id,
    publicKey,
    privateKey: await exportPrivateKey(signingPair.privateKey),
    encryptionPublicKey: await exportEncryptionPublicKey(encryptionPair.publicKey),
    encryptionPrivateKey: await exportEncryptionPrivateKey(encryptionPair.privateKey)
  };
}

function contactFor(identity: TestIdentity, overrides: Partial<DmRecipientContact> = {}): DmRecipientContact {
  return {
    publicKey: identity.publicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    ...overrides
  };
}

function createStore(options: {
  put?: (object: DistributedObject) => Promise<boolean>;
  records?: DistributedObject[];
} = {}): ObjectStore {
  const records = options.records ?? [];
  return {
    async put(object) {
      if (options.put) return await options.put(object);
      records.push(object);
      return true;
    },
    async get(objectId) {
      return records.find((object) => object.object_id === objectId) ?? null;
    },
    async delete() {},
    async query() { return records; }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendDm', () => {
  it('stores a sent DM that the recipient and author can decrypt', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const records: DistributedObject[] = [];
    const replicate = vi.fn(async () => ['peer-replica']);

    const result = await sendDm({
      identity: sender,
      recipientContact: contactFor(recipient),
      plaintext: 'secret note',
      store: createStore({ records }),
      replicate,
      now: () => NOW
    });

    expect(result.status).toBe('sent');
    if (result.status !== 'sent') throw new Error('Expected a sent DM');
    expect(records).toEqual([result.object]);
    expect(result.object.recipient).toBe(recipient.publicKey);
    expect(result.replicatedTo).toEqual(['peer-replica']);
    await expect(decryptDmObject({
      object: result.object,
      identity: recipient,
      expectedSenderEncryptionKey: sender.encryptionPublicKey
    })).resolves.toBe('secret note');
    await expect(decryptDmObject({ object: result.object, identity: sender })).resolves.toBe('secret note');
    expect(replicate).toHaveBeenCalledWith(result.object);
  });

  it('rejects empty or whitespace-only plaintext without storing', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const records: DistributedObject[] = [];
    const replicate = vi.fn(async () => []);

    for (const plaintext of ['', ' \n\t ']) {
      const result = await sendDm({
        identity: sender,
        recipientContact: contactFor(recipient),
        plaintext,
        store: createStore({ records }),
        replicate
      });
      expect(result.status).toBe('invalid');
    }
    expect(records).toHaveLength(0);
    expect(replicate).not.toHaveBeenCalled();
  });

  it('rejects plaintext over 4000 characters', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const records: DistributedObject[] = [];

    const result = await sendDm({
      identity: sender,
      recipientContact: contactFor(recipient),
      plaintext: 'x'.repeat(4001),
      store: createStore({ records }),
      replicate: async () => []
    });

    expect(result.status).toBe('invalid');
    expect(records).toHaveLength(0);
  });

  it('returns no_key and stores nothing when the contact has no encryption key', async () => {
    const sender = await createIdentity('sender');
    const records: DistributedObject[] = [];

    const result = await sendDm({
      identity: sender,
      recipientContact: { publicKey: 'recipient-signing-key' },
      plaintext: 'message',
      store: createStore({ records }),
      replicate: async () => []
    });

    expect(result.status).toBe('no_key');
    expect(records).toHaveLength(0);
  });

  it('sends to the stored trusted key and reports keyChanged', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');

    const result = await sendDm({
      identity: sender,
      recipientContact: contactFor(recipient, { encryptionKeyChanged: true }),
      plaintext: 'send to previously trusted key',
      store: createStore(),
      replicate: async () => []
    });

    expect(result.status).toBe('sent');
    expect(result.keyChanged).toBe(true);
    if (result.status === 'sent') {
      expect((result.object.payload as { recipient_enc_key: string }).recipient_enc_key).toBe(recipient.encryptionPublicKey);
    }
  });

  it('returns store_failed without invoking replication when the store throws', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const replicate = vi.fn(async () => ['peer']);

    const result = await sendDm({
      identity: sender,
      recipientContact: contactFor(recipient),
      plaintext: 'store failure',
      store: createStore({ put: async () => { throw new Error('private storage error'); } }),
      replicate
    });

    expect(result.status).toBe('store_failed');
    expect(replicate).not.toHaveBeenCalled();
  });

  it('keeps sent status and an empty replicatedTo list when replication throws', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const records: DistributedObject[] = [];

    const result = await sendDm({
      identity: sender,
      recipientContact: contactFor(recipient),
      plaintext: 'replication failure',
      store: createStore({ records }),
      replicate: async () => { throw new Error('network error'); }
    });

    expect(result.status).toBe('sent');
    expect(result.replicatedTo).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it('returns the peer IDs reported by replication', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const peerIds = ['peer-one', 'peer-two'];

    const result = await sendDm({
      identity: sender,
      recipientContact: contactFor(recipient),
      plaintext: 'replication result',
      store: createStore(),
      replicate: async () => peerIds
    });

    expect(result.status).toBe('sent');
    expect(result.replicatedTo).toEqual(peerIds);
  });

  it('does not log or persist plaintext in clear text', async () => {
    const sender = await createIdentity('sender');
    const recipient = await createIdentity('recipient');
    const plaintext = 'hygiene-plaintext-dm-send-unique';
    const records: DistributedObject[] = [];
    const consoleSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error')
    ];

    const result = await sendDm({
      identity: sender,
      recipientContact: contactFor(recipient),
      plaintext,
      store: createStore({ records }),
      replicate: async () => [],
      now: () => NOW
    });

    expect(result.status).toBe('sent');
    expect(JSON.stringify(records)).not.toContain(plaintext);
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(plaintext);
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
