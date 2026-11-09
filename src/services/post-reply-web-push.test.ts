import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveFingerprint, exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from '../object-layer/identity';
import { createSignedObject } from '../object-layer/envelope';
import type { DistributedObject, JsonValue } from '../object-layer/types';
import type { Contact, WebPushCapability } from '../types';
import type { WebPushDispatchResult } from './web-push-dispatch';
import { dispatchLocalPostToFollowers } from './post-web-push';
import { dispatchLocalReplyToParent } from './post-reply-web-push';
import type { InvalidateWebPushCapability } from './web-push-capability-invalidation';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

type TestIdentity = {
  readonly id: string;
  readonly publicKey: string;
  readonly privateKey: string;
};

const capability: WebPushCapability = {
  endpoint: 'https://push.example.test/subscription',
  p256dh: 'public-key',
  auth: 'auth-secret'
};

async function createIdentity(): Promise<TestIdentity> {
  const pair = await generateIdentityKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  return {
    id: await deriveFingerprint(publicKey),
    publicKey,
    privateKey: await exportPrivateKey(pair.privateKey)
  };
}

async function createPost(
  identity: TestIdentity,
  payload: { [key: string]: JsonValue } = { content: 'post body', tags: [] }
): Promise<DistributedObject> {
  return createSignedObject({
    object_type: 'mycelium.post',
    created_at: '2026-11-07T12:00:00.000Z',
    payload,
    replication_policy: {}
  }, createObjectIdentity(identity));
}

function contact(identity: TestIdentity, overrides: Partial<Contact> = {}): Contact {
  return {
    publicKey: identity.publicKey,
    fingerprint: identity.id,
    addedAt: '2026-11-07T12:00:00.000Z',
    followed: false,
    follower: false,
    webPush: capability,
    ...overrides
  };
}

function makeOptions(
  reply: DistributedObject,
  parent: DistributedObject,
  local: TestIdentity,
  contacts: readonly Contact[],
  overrides: {
    readonly storedLocally?: boolean;
    readonly blockedPeers?: ReadonlySet<string>;
    readonly dispatch?: (
      object: DistributedObject,
      capability: WebPushCapability
    ) => Promise<WebPushDispatchResult>;
    readonly invalidateWebPushCapability?: InvalidateWebPushCapability;
  } = {}
) {
  const dispatch = vi.fn(overrides.dispatch ?? (async () => ({ status: 'accepted' } as const)));
  return {
    reply,
    parent,
    storedLocally: overrides.storedLocally ?? true,
    localPublicKey: local.publicKey,
    localFingerprint: local.id,
    contacts,
    blockedPeers: overrides.blockedPeers ?? new Set<string>(),
    ...(overrides.invalidateWebPushCapability
      ? { invalidateWebPushCapability: overrides.invalidateWebPushCapability }
      : {}),
    dispatch
  };
}

describe('locally created reply Web Push', () => {
  it('dispatches the stored canonical reply to the verified parent author contact', async () => {
    const local = await createIdentity();
    const parentAuthor = await createIdentity();
    const claimedAuthor = await createIdentity();
    const parent = await createPost(parentAuthor);
    const reply = await createPost(local, {
      content: 'reply',
      tags: [],
      reply_to: parent.object_id,
      reply_to_author: claimedAuthor.id
    });
    const recipient = contact(parentAuthor);
    const options = makeOptions(reply, parent, local, [contact(claimedAuthor), recipient]);

    await dispatchLocalReplyToParent(options);

    expect(options.dispatch).toHaveBeenCalledOnce();
    expect(options.dispatch).toHaveBeenCalledWith(reply, recipient.webPush);
  });

  it('rejects a reply whose parent claim or verified parent identity does not match', async () => {
    const local = await createIdentity();
    const parentAuthor = await createIdentity();
    const otherAuthor = await createIdentity();
    const parent = await createPost(parentAuthor);
    const otherParent = await createPost(otherAuthor);
    const reply = await createPost(local, { content: 'reply', tags: [], reply_to: parent.object_id });

    const mismatchedParent = makeOptions(reply, otherParent, local, [contact(parentAuthor)]);
    await dispatchLocalReplyToParent(mismatchedParent);
    expect(mismatchedParent.dispatch).not.toHaveBeenCalled();

    const mismatchedKey = makeOptions(reply, parent, local, [
      contact(otherAuthor, { fingerprint: parentAuthor.id })
    ]);
    await dispatchLocalReplyToParent(mismatchedKey);
    expect(mismatchedKey.dispatch).not.toHaveBeenCalled();

    const mismatchedFingerprint = makeOptions(reply, parent, local, [
      contact(parentAuthor, { fingerprint: otherAuthor.id })
    ]);
    await dispatchLocalReplyToParent(mismatchedFingerprint);
    expect(mismatchedFingerprint.dispatch).not.toHaveBeenCalled();

    const forgedParent = { ...parent, author: otherAuthor.publicKey };
    const invalidParent = makeOptions(reply, forgedParent, local, [contact(otherAuthor)]);
    await dispatchLocalReplyToParent(invalidParent);
    expect(invalidParent.dispatch).not.toHaveBeenCalled();
  });

  it('skips missing or invalid capabilities and blocked recipients by key or fingerprint', async () => {
    const local = await createIdentity();
    const blockedByKey = await createIdentity();
    const blockedByFingerprint = await createIdentity();
    const noCapability = await createIdentity();
    const invalidCapability = await createIdentity();

    for (const [recipient, overrides] of [
      [blockedByKey, { blockedPeers: new Set([blockedByKey.publicKey]) }],
      [blockedByFingerprint, { blockedPeers: new Set([blockedByFingerprint.id]) }],
      [noCapability, {}],
      [invalidCapability, {}]
    ] as const) {
      const parent = await createPost(recipient);
      const reply = await createPost(local, { content: 'reply', tags: [], reply_to: parent.object_id });
      const recipientContact = contact(recipient, recipient === noCapability
        ? { webPush: undefined }
        : recipient === invalidCapability
          ? { webPush: { ...capability, endpoint: 'http://push.example.test' } }
          : {});
      const options = makeOptions(reply, parent, local, [recipientContact], overrides);

      await dispatchLocalReplyToParent(options);
      expect(options.dispatch).not.toHaveBeenCalled();
    }
  });

  it('skips self-replies and replies that were not successfully stored', async () => {
    const local = await createIdentity();
    const parent = await createPost(local);
    const reply = await createPost(local, { content: 'reply', tags: [], reply_to: parent.object_id });

    const selfReply = makeOptions(reply, parent, local, [contact(local)]);
    await dispatchLocalReplyToParent(selfReply);
    expect(selfReply.dispatch).not.toHaveBeenCalled();

    const otherAuthor = await createIdentity();
    const otherParent = await createPost(otherAuthor);
    const unstoredReply = await createPost(local, { content: 'reply', tags: [], reply_to: otherParent.object_id });
    const storageFailure = makeOptions(unstoredReply, otherParent, local, [contact(otherAuthor)], {
      storedLocally: false
    });
    await dispatchLocalReplyToParent(storageFailure);
    expect(storageFailure.dispatch).not.toHaveBeenCalled();
  });

  it('isolates dispatch rejection from reply handling', async () => {
    const local = await createIdentity();
    const parentAuthor = await createIdentity();
    const parent = await createPost(parentAuthor);
    const reply = await createPost(local, { content: 'reply', tags: [], reply_to: parent.object_id });
    const options = makeOptions(reply, parent, local, [contact(parentAuthor)], {
      dispatch: async () => { throw new Error('push failed'); }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(dispatchLocalReplyToParent(options)).resolves.toBeUndefined();
    expect(options.dispatch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Web Push reply recipient validation or dispatch failed unexpectedly');
  });

  it('conditionally invalidates the exact parent-author capability after invalid-subscription', async () => {
    const local = await createIdentity();
    const parentAuthor = await createIdentity();
    const parent = await createPost(parentAuthor);
    const reply = await createPost(local, { content: 'reply', tags: [], reply_to: parent.object_id });
    const recipient = contact(parentAuthor);
    const invalidateWebPushCapability = vi.fn(async () => {});
    const options = makeOptions(reply, parent, local, [recipient], {
      dispatch: async () => ({ status: 'invalid-subscription' }),
      invalidateWebPushCapability
    });

    await dispatchLocalReplyToParent(options);

    expect(invalidateWebPushCapability).toHaveBeenCalledOnce();
    expect(invalidateWebPushCapability).toHaveBeenCalledWith(
      recipient.publicKey,
      recipient.fingerprint,
      recipient.webPush
    );
    expect(options.dispatch).toHaveBeenCalledWith(reply, recipient.webPush);
  });

  it('does not duplicate the parent-author attempt through Stage 8G follower fan-out', async () => {
    const local = await createIdentity();
    const parentAuthor = await createIdentity();
    const otherFollower = await createIdentity();
    const parent = await createPost(parentAuthor);
    const reply = await createPost(local, { content: 'reply', tags: [], reply_to: parent.object_id });
    const parentContact = contact(parentAuthor, { follower: true });
    const followerContact = contact(otherFollower, { follower: true });
    const dispatch = vi.fn(async () => ({ status: 'accepted' } as const));
    const replyOptions = makeOptions(reply, parent, local, [parentContact, followerContact], { dispatch });

    await dispatchLocalReplyToParent(replyOptions);
    await dispatchLocalPostToFollowers({
      post: reply,
      storedLocally: true,
      localPublicKey: local.publicKey,
      localFingerprint: local.id,
      contacts: [parentContact, followerContact],
      blockedPeers: new Set(),
      replyParent: parent,
      dispatch
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, reply, parentContact.webPush);
    expect(dispatch).toHaveBeenNthCalledWith(2, reply, followerContact.webPush);
  });
});
