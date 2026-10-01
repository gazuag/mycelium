import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { handleDiscoveryResult, publishObject, fetchDiscovery } from './discovery';
import { createSignedObject } from '../object-layer/envelope';
import { createObjectIdentity } from '../object-layer/identity';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import type { DistributedObject } from '../object-layer/types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

async function fixture(): Promise<DistributedObject> {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  return createSignedObject({
    object_type: 'mycelium.post',
    created_at: '2026-08-25T00:00:00.000Z',
    payload: { content: 'discovery object', tags: ['stage5'] },
    replication_policy: {}
  }, createObjectIdentity({ id: 'discovery-client', publicKey, privateKey }));
}

describe('discovery object protocol', () => {
  it('allows publishing mycelium.post objects', async () => {
    const object = await fixture();
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };

    await expect(publishObject(object, socket)).resolves.toBeUndefined();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0][0]).payload.object).toEqual(object);
  });

  it('rejects mycelium.dm without sending it to discovery', async () => {
    const object = { ...(await fixture()), object_type: 'mycelium.dm' };
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };

    await expect(publishObject(object, socket)).rejects.toThrow("unsupported object type 'mycelium.dm'");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('rejects unknown object types without sending them to discovery', async () => {
    const object = { ...(await fixture()), object_type: 'mycelium.unknown' };
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };

    await expect(publishObject(object, socket)).rejects.toThrow("unsupported object type 'mycelium.unknown'");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('publishes and fetches canonical objects through discovery packets', async () => {
    const object = await fixture();
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };

    await publishObject(object, socket);
    const publishPacket = JSON.parse(socket.send.mock.calls[0][0]);
    expect(publishPacket.type).toBe('DISCOVERY_PUBLISH');
    expect(publishPacket.payload.object).toEqual(object);
    expect(publishPacket.payload.post).toBeUndefined();

    const fetchPromise = fetchDiscovery(socket, 10, 'stage5');
    await Promise.resolve();
    const getPacket = JSON.parse(socket.send.mock.calls[1][0]);
    expect(getPacket.type).toBe('DISCOVERY_GET');
    expect(getPacket.payload.limit).toBe(10);
    expect(handleDiscoveryResult({
      protocol: 'mycelium',
      version: 1,
      id: 'result-id',
      type: 'DISCOVERY_RESULT',
      timestamp: object.created_at,
      sender: 'discovery-server',
      recipient: 'discovery-client',
      payload: { requestId: getPacket.id, objects: [object] },
      signature: 'server-unsigned-v1'
    })).toBe(true);
    await expect(fetchPromise).resolves.toEqual([object]);
  });
});
