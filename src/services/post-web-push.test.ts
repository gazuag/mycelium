import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveFingerprint, exportPrivateKey, exportPublicKey, generateIdentityKeyPair } from '../crypto/identity';
import { createObjectIdentity } from '../object-layer/identity';
import { createSignedObject } from '../object-layer/envelope';
import type { DistributedObject, JsonValue } from '../object-layer/types';
import type { Contact, WebPushCapability } from '../types';
import type { WebPushDispatchResult } from './web-push-dispatch';
import type { InvalidateWebPushCapability } from './web-push-capability-invalidation';
import {
  completePostDirectSharingAndDispatchFollowers,
  dispatchLocalPostToFollowers
} from './post-web-push';

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
    follower: true,
    webPush: capability,
    ...overrides
  };
}

function makeOptions(
  post: DistributedObject,
  local: TestIdentity,
  contacts: readonly Contact[],
  overrides: {
    readonly storedLocally?: boolean;
    readonly blockedPeers?: ReadonlySet<string>;
    readonly replyParent?: DistributedObject;
    readonly dispatch?: (
      object: DistributedObject,
      capability: WebPushCapability
    ) => Promise<WebPushDispatchResult>;
    readonly invalidateWebPushCapability?: InvalidateWebPushCapability;
  } = {}
) {
  const dispatch = vi.fn(overrides.dispatch ?? (async () => ({ status: 'accepted' } as const)));
  return {
    post,
    storedLocally: overrides.storedLocally ?? true,
    localPublicKey: local.publicKey,
    localFingerprint: local.id,
    contacts,
    blockedPeers: overrides.blockedPeers ?? new Set<string>(),
    ...(overrides.replyParent ? { replyParent: overrides.replyParent } : {}),
    ...(overrides.invalidateWebPushCapability
      ? { invalidateWebPushCapability: overrides.invalidateWebPushCapability }
      : {}),
    dispatch
  };
}

describe('followed-author post Web Push', () => {
  it('starts fan-out only after the existing direct-sharing phase completes', async () => {
    const local = await createIdentity();
    const follower = await createIdentity();
    const post = await createPost(local);
    const events: string[] = [];
    let finishDirectSharing!: () => void;
    const directSharing = vi.fn(() => new Promise<void>((resolve) => {
      finishDirectSharing = () => {
        events.push('direct-sharing-complete');
        resolve();
      };
    }));
    const options = makeOptions(post, local, [contact(follower)], {
      storedLocally: true,
      dispatch: async (object) => {
        expect(object).toBe(post);
        events.push('push-dispatched');
        return { status: 'accepted' };
      }
    });

    const pending = completePostDirectSharingAndDispatchFollowers(directSharing, options);
    await vi.waitFor(() => expect(directSharing).toHaveBeenCalledOnce());
    expect(options.dispatch).not.toHaveBeenCalled();
    finishDirectSharing();
    await pending;
    await vi.waitFor(() => expect(options.dispatch).toHaveBeenCalledOnce());

    expect(events).toEqual(['direct-sharing-complete', 'push-dispatched']);
  });

  it('does not fan out if the direct-sharing phase rejects before completion', async () => {
    const local = await createIdentity();
    const follower = await createIdentity();
    const post = await createPost(local);
    const options = makeOptions(post, local, [contact(follower)]);

    await expect(completePostDirectSharingAndDispatchFollowers(
      async () => { throw new Error('direct sharing failed'); },
      options
    )).rejects.toThrow('direct sharing failed');
    expect(options.dispatch).not.toHaveBeenCalled();
  });

  it('does not fan out unless local object storage admitted the canonical post', async () => {
    const local = await createIdentity();
    const follower = await createIdentity();
    const post = await createPost(local);
    const options = makeOptions(post, local, [contact(follower)], { storedLocally: false });

    await completePostDirectSharingAndDispatchFollowers(async () => {}, options);

    expect(options.dispatch).not.toHaveBeenCalled();
  });

  it('does not wait for or surface a push failure to the completed P2P operation', async () => {
    const local = await createIdentity();
    const follower = await createIdentity();
    const post = await createPost(local);
    const directSharing = vi.fn(async () => {});
    const options = makeOptions(post, local, [contact(follower)], {
      dispatch: async () => { throw new Error('push failed'); }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(completePostDirectSharingAndDispatchFollowers(directSharing, options)).resolves.toBeUndefined();
    expect(directSharing).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Web Push followed-post dispatch failed unexpectedly'
    ));
  });

  it('targets only followers and passes the same canonical object with that contact capability', async () => {
    const local = await createIdentity();
    const follower = await createIdentity();
    const followingOnly = await createIdentity();
    const post = await createPost(local);
    const followerContact = contact(follower);
    const options = makeOptions(post, local, [
      followerContact,
      contact(followingOnly, { follower: false, followed: true })
    ]);

    await dispatchLocalPostToFollowers(options);

    expect(options.dispatch).toHaveBeenCalledOnce();
    expect(options.dispatch).toHaveBeenCalledWith(post, followerContact.webPush);
  });

  it('skips self, duplicate identities, blocked recipients, and malformed or mismatched capabilities', async () => {
    const local = await createIdentity();
    const blockedByKey = await createIdentity();
    const blockedByFingerprint = await createIdentity();
    const missingCapability = await createIdentity();
    const malformedCapability = await createIdentity();
    const mismatchedIdentity = await createIdentity();
    const eligible = await createIdentity();
    const eligibleContact = contact(eligible);
    const post = await createPost(local);
    const options = makeOptions(post, local, [
      contact(local),
      contact(blockedByKey),
      contact(blockedByFingerprint),
      contact(missingCapability, { webPush: undefined }),
      contact(malformedCapability, { webPush: { ...capability, endpoint: 'http://push.example.test' } }),
      contact(mismatchedIdentity, { fingerprint: 'wrong-fingerprint' }),
      eligibleContact,
      { ...eligibleContact }
    ], {
      blockedPeers: new Set([blockedByKey.publicKey, blockedByFingerprint.id])
    });

    await dispatchLocalPostToFollowers(options);

    expect(options.dispatch).toHaveBeenCalledOnce();
    expect(options.dispatch).toHaveBeenCalledWith(post, eligibleContact.webPush);
  });

  it('continues sequential fan-out after one recipient rejects or returns a failure result', async () => {
    const local = await createIdentity();
    const first = await createIdentity();
    const second = await createIdentity();
    const third = await createIdentity();
    const post = await createPost(local);
    const events: string[] = [];
    const dispatch = vi.fn()
      .mockImplementationOnce(async () => {
        events.push('first');
        throw new Error('delivery failed');
      })
      .mockImplementationOnce(async () => {
        events.push('second');
        return { status: 'temporary-failure' } as const;
      })
      .mockImplementationOnce(async () => {
        events.push('third');
        return { status: 'accepted' } as const;
      });
    const options = makeOptions(post, local, [contact(first), contact(second), contact(third)], {
      dispatch
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await dispatchLocalPostToFollowers(options);

    expect(events).toEqual(['first', 'second', 'third']);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith('Web Push followed-post dispatch failed unexpectedly');
  });

  it('invalidates each exact permanently unusable follower capability without stopping fan-out', async () => {
    const local = await createIdentity();
    const first = await createIdentity();
    const second = await createIdentity();
    const post = await createPost(local);
    const firstContact = contact(first);
    const secondContact = contact(second);
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ status: 'invalid-subscription' } as const)
      .mockResolvedValueOnce({ status: 'accepted' } as const);
    const invalidateWebPushCapability = vi.fn(async () => {});
    const options = makeOptions(post, local, [firstContact, secondContact], {
      dispatch,
      invalidateWebPushCapability
    });

    await dispatchLocalPostToFollowers(options);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(invalidateWebPushCapability).toHaveBeenCalledOnce();
    expect(invalidateWebPushCapability).toHaveBeenCalledWith(
      firstContact.publicKey,
      firstContact.fingerprint,
      firstContact.webPush
    );
  });

  it('continues to other followers when one invalidation persistence attempt fails', async () => {
    const local = await createIdentity();
    const first = await createIdentity();
    const second = await createIdentity();
    const post = await createPost(local);
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ status: 'invalid-subscription' } as const)
      .mockResolvedValueOnce({ status: 'accepted' } as const);
    const invalidateWebPushCapability = vi.fn(async () => {
      throw new Error('sensitive persistence detail');
    });
    const options = makeOptions(post, local, [contact(first), contact(second)], {
      dispatch,
      invalidateWebPushCapability
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(dispatchLocalPostToFollowers(options)).resolves.toBeUndefined();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(invalidateWebPushCapability).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Failed to invalidate unusable Web Push capability');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive persistence detail');
  });

  it('excludes the verified parent author from reply fan-out and rejects a mismatched parent', async () => {
    const local = await createIdentity();
    const parentAuthor = await createIdentity();
    const otherFollower = await createIdentity();
    const parent = await createPost(parentAuthor);
    const reply = await createPost(local, { content: 'reply', tags: [], reply_to: parent.object_id });
    const options = makeOptions(reply, local, [contact(parentAuthor), contact(otherFollower)], {
      replyParent: parent
    });

    await dispatchLocalPostToFollowers(options);
    expect(options.dispatch).toHaveBeenCalledOnce();
    expect(options.dispatch).toHaveBeenCalledWith(reply, capability);

    const wrongParent = await createPost(parentAuthor);
    const mismatchedOptions = makeOptions(reply, local, [contact(parentAuthor)], {
      replyParent: wrongParent
    });
    await dispatchLocalPostToFollowers(mismatchedOptions);
    expect(mismatchedOptions.dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch non-canonical or non-local objects', async () => {
    const local = await createIdentity();
    const remote = await createIdentity();
    const follower = await createIdentity();
    const post = await createPost(local);
    const options = makeOptions(post, local, [contact(follower)]);

    await dispatchLocalPostToFollowers({ ...options, post: await createPost(remote) });
    await dispatchLocalPostToFollowers({
      ...options,
      post: { ...post, object_type: 'mycelium.reply' }
    });

    expect(options.dispatch).not.toHaveBeenCalled();
  });
});
