import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { replicateObject, sendReplyToAuthor } from './transport';
import type { DistributedObject, ObjectPacket, ObjectTransport } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const object: DistributedObject = {
  object_id: 'a'.repeat(64),
  object_type: 'send-failure-test',
  author: 'author-key',
  created_at: '2026-10-05T12:00:00.000Z',
  payload: { value: 'replication' },
  signature: 'object-signature',
  replication_policy: { replication_budget: 2 }
};

describe('object send failure handling', () => {
  it('skips a failed replication peer and continues to the next peer', async () => {
    const attempts: string[] = [];
    const transport: ObjectTransport = {
      connectedPeers: () => ['peer-fails', 'peer-succeeds'],
      onPacket: () => () => {},
      async send(peerId: string, _packet: ObjectPacket) {
        attempts.push(peerId);
        if (peerId === 'peer-fails') throw new Error('transport failure');
      }
    };

    const result = await replicateObject('local-peer', object, transport);

    expect(attempts).toEqual(['peer-fails', 'peer-succeeds']);
    expect(result.targeted).toEqual(['peer-fails', 'peer-succeeds']);
    expect(result.stored).toEqual(['peer-succeeds']);
  });

  it('returns an unsent reply result when the connected author send fails', async () => {
    const transport: ObjectTransport = {
      connectedPeers: () => ['author-peer'],
      onPacket: () => () => {},
      send: vi.fn(async () => {
        throw new Error('transport failure');
      })
    };

    await expect(sendReplyToAuthor('local-peer', object, transport, 'author-peer'))
      .resolves.toMatchObject({ reachable: true, sent: false });
  });
});
