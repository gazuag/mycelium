import { describe, expect, it, vi } from 'vitest';
import { PeerConnectionObjectTransport } from './object-transport';
import type { PeerConnectionManager } from './webrtc';
import type { ObjectPacket } from '../object-layer/types';

function packet(): ObjectPacket {
  return {
    protocol: 'mycelium',
    version: 1,
    id: 'packet-id',
    type: 'OBJECT_STORE',
    timestamp: '2026-10-05T12:00:00.000Z',
    sender: 'sender',
    recipient: 'recipient',
    payload: {
      object: {
        object_id: 'object-id',
        object_type: 'test',
        author: 'author',
        created_at: '2026-10-05T12:00:00.000Z',
        payload: {},
        signature: 'signature',
        replication_policy: {}
      }
    },
    signature: 'packet-signature'
  };
}

describe('PeerConnectionObjectTransport', () => {
  it('rejects sends when the manager is missing or its channel is not open', async () => {
    const notOpen = {
      isDataChannelOpen: () => false,
      sendObjectPacket: vi.fn()
    } as unknown as PeerConnectionManager;
    const transport = new PeerConnectionObjectTransport(() => ({ 'peer-a': notOpen }));

    await expect(transport.send('peer-a', packet())).rejects.toThrow('Object packet send failed');
    await expect(transport.send('missing-peer', packet())).rejects.toThrow('Object packet send failed');
    expect(notOpen.sendObjectPacket).not.toHaveBeenCalled();
  });

  it('rejects when the manager send throws, and leaves a successful send unchanged', async () => {
    const sendObjectPacket = vi.fn();
    const manager = {
      isDataChannelOpen: () => true,
      sendObjectPacket
    } as unknown as PeerConnectionManager;
    const transport = new PeerConnectionObjectTransport(() => ({ 'peer-a': manager }));

    await expect(transport.send('peer-a', packet())).resolves.toBeUndefined();
    expect(sendObjectPacket).toHaveBeenCalledWith(packet());

    sendObjectPacket.mockImplementationOnce(() => {
      throw new Error('channel failure');
    });
    await expect(transport.send('peer-a', packet())).rejects.toThrow('Object packet send failed');
  });
});
