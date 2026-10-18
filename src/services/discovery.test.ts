import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { handleDiscoveryResult, publishObject, fetchDiscovery, validateDiscoveryObjects } from './discovery';
import { createSignedObject, createSignedRecommendationObject } from '../object-layer/envelope';
import { createObjectIdentity } from '../object-layer/identity';
import { RecommendationIndex } from '../object-layer/recommendations';
import { exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import type { DistributedObject, JsonValue } from '../object-layer/types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

async function identityFixture(id = 'discovery-client') {
  const keys = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const privateKey = await exportPrivateKey(keys.privateKey);
  return createObjectIdentity({ id, publicKey, privateKey });
}

async function postFixture(
  identity?: Awaited<ReturnType<typeof identityFixture>>,
  payload: Record<string, JsonValue> = { content: 'discovery object', tags: ['stage5'] }
): Promise<DistributedObject> {
  return createSignedObject({
    object_type: 'mycelium.post',
    created_at: '2026-08-25T00:00:00.000Z',
    payload,
    replication_policy: {}
  }, identity ?? await identityFixture());
}

describe('discovery object protocol', () => {
  it('allows publishing mycelium.post objects', async () => {
    const object = await postFixture();
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };

    await expect(publishObject(object, socket)).resolves.toBeUndefined();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0][0]).payload.object).toEqual(object);
  });

  it('rejects mycelium.dm without sending it to discovery', async () => {
    const object = { ...(await postFixture()), object_type: 'mycelium.dm' };
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };

    await expect(publishObject(object, socket)).rejects.toThrow("unsupported object type 'mycelium.dm'");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('rejects unknown object types without sending them to discovery', async () => {
    const object = { ...(await postFixture()), object_type: 'mycelium.unknown' };
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };

    await expect(publishObject(object, socket)).rejects.toThrow("unsupported object type 'mycelium.unknown'");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('publishes and fetches canonical objects through discovery packets', async () => {
    const object = await postFixture();
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

  it('publishes signed likes and canonical reply posts and returns them as interaction data', async () => {
    const identity = await identityFixture();
    const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
    const postId = 'a'.repeat(64);
    const like = await createSignedRecommendationObject(postId, 'recommend', 1, identity);
    const withdrawal = await createSignedRecommendationObject(postId, 'withdraw', 2, identity);
    const reply = await postFixture(identity, { content: 'reply', reply_to: postId });
    const ordinaryPost = await postFixture(identity);

    await publishObject(like, socket);
    await publishObject(withdrawal, socket);
    await publishObject(reply, socket);
    expect(socket.send).toHaveBeenCalledTimes(3);
    expect(JSON.parse(socket.send.mock.calls[0][0]).payload.object).toEqual(like);
    expect(JSON.parse(socket.send.mock.calls[1][0]).payload.object).toEqual(withdrawal);
    expect(JSON.parse(socket.send.mock.calls[2][0]).payload.object).toEqual(reply);

    const fetchPromise = fetchDiscovery(socket, 10);
    await Promise.resolve();
    const getPacket = JSON.parse(socket.send.mock.calls[3][0]);
    expect(handleDiscoveryResult({
      protocol: 'mycelium',
      version: 1,
      id: 'result-id',
      type: 'DISCOVERY_RESULT',
      timestamp: ordinaryPost.created_at,
      sender: 'discovery-server',
      recipient: 'discovery-client',
      payload: { requestId: getPacket.id, objects: [like, withdrawal, reply, ordinaryPost, like, reply] },
      signature: 'server-unsigned-v1'
    })).toBe(true);

    const result = await fetchPromise;
    const interactions = await validateDiscoveryObjects(result);
    expect(interactions.recommendations).toEqual([like, withdrawal]);
    expect(interactions.replies).toEqual([reply]);
    expect(interactions.posts).toEqual([ordinaryPost]);
    const recommendationIndex = new RecommendationIndex();
    recommendationIndex.addAll(interactions.recommendations);
    expect(recommendationIndex.getSummary(postId).active_recommender_count).toBe(0);
  });

  it('does not count invalid or forged Discovery interactions', async () => {
    const identity = await identityFixture();
    const postId = 'b'.repeat(64);
    const validLike = await createSignedRecommendationObject(postId, 'recommend', 1, identity);
    const validReply = await postFixture(identity, { content: 'reply', reply_to: postId });
    const forgedLike = { ...validLike, author: 'forged-author' };
    const forgedReply = { ...validReply, author: 'forged-author' };
    const result = await validateDiscoveryObjects([validLike, validReply, forgedLike, forgedReply]);

    expect(result.recommendations).toEqual([validLike]);
    expect(result.replies).toEqual([validReply]);
    expect(result.invalidCount).toBe(2);
  });
});
