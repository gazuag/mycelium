import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair, verifySignedString } from '../crypto/identity';
import { canonicalize } from '../p2p/protocol';
import { buildFindPacket } from './transport';
import { wrapFindTransport } from './find-transport-adapter';
import type { ObjectPacket } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

function mockObjectTransport() {
  const handlers = new Set<(peerId: string, packet: ObjectPacket) => void>();
  const sent: Array<{ peerId: string; packet: ObjectPacket }> = [];
  const objectTransport = {
    connectedPeers: vi.fn(() => ['peer-a', 'peer-b']),
    send: vi.fn(async (peerId: string, packet: ObjectPacket) => { sent.push({ peerId, packet }); }),
    onPacket: vi.fn((handler: (peerId: string, packet: ObjectPacket) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    dispatch(peerId: string, packet: ObjectPacket) {
      handlers.forEach((handler) => handler(peerId, packet));
    },
    sent
  };
  return objectTransport;
}

describe('find transport adapter', () => {
  it('signs outgoing FIND packets in the canonical packet format', async () => {
    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const privateKey = await exportPrivateKey(pair.privateKey);
    const objectTransport = mockObjectTransport();
    const adapter = wrapFindTransport({
      objectTransport,
      signPacket: async (packet) => {
        const { signString } = await import('../crypto/identity');
        return await signString(privateKey, canonicalize(packet));
      }
    });
    const packet = await buildFindPacket('local', 'peer-a', [], undefined, 'adapter-test', 1);

    await adapter.send('peer-a', packet);
    const outgoing = objectTransport.sent[0].packet;
    const { signature, ...unsignedPacket } = outgoing;

    expect(signature).not.toBe('unsigned-v1');
    expect(await verifySignedString(publicKey, canonicalize(unsignedPacket), signature)).toBe(true);
  });

  it('delegates connected peers and subscriptions including unsubscribe', () => {
    const objectTransport = mockObjectTransport();
    const adapter = wrapFindTransport({ objectTransport, signPacket: async () => 'signature' });
    const handler = vi.fn();
    const packet = {
      protocol: 'mycelium',
      version: 1,
      id: 'find-response',
      type: 'FIND_RESPONSE',
      timestamp: new Date().toISOString(),
      sender: 'peer-a',
      recipient: 'local',
      payload: { objects: [], object_id: '', requestId: 'request' },
      signature: 'signature'
    } as ObjectPacket;

    expect(adapter.connectedPeers()).toEqual(['peer-a', 'peer-b']);
    expect(objectTransport.connectedPeers).toHaveBeenCalledOnce();
    const unsubscribe = adapter.subscribe(handler);
    objectTransport.dispatch('peer-a', packet);
    expect(handler).toHaveBeenCalledWith('peer-a', packet);

    unsubscribe();
    objectTransport.dispatch('peer-a', packet);
    expect(handler).toHaveBeenCalledOnce();
    expect(objectTransport.onPacket).toHaveBeenCalledOnce();
  });
});
