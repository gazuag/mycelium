import { deriveFingerprint } from '../crypto/identity';
import { validateDistributedObject } from '../object-layer/envelope';
import type { DistributedObject } from '../object-layer/types';
import type { Contact, WebPushCapability } from '../types';
import { isWebPushCapability } from './web-push';
import {
  invalidateWebPushCapabilityAfterDispatch,
  type InvalidateWebPushCapability
} from './web-push-capability-invalidation';
import type { WebPushDispatchResult } from './web-push-dispatch';

export interface LocalPostFollowerPushOptions {
  readonly post: DistributedObject;
  readonly storedLocally: boolean;
  readonly localPublicKey: string;
  readonly localFingerprint: string;
  readonly contacts: readonly Contact[];
  readonly blockedPeers: ReadonlySet<string>;
  readonly invalidateWebPushCapability?: InvalidateWebPushCapability;
  readonly replyParent?: DistributedObject;
  readonly dispatch: (
    object: DistributedObject,
    capability: WebPushCapability
  ) => Promise<WebPushDispatchResult>;
}

export async function completePostDirectSharingAndDispatchFollowers(
  completeDirectSharing: () => Promise<void>,
  options: LocalPostFollowerPushOptions
): Promise<void> {
  await completeDirectSharing();
  if (!options.storedLocally) return;
  void dispatchLocalPostToFollowers(options).catch(() => {
    console.warn('Web Push followed-post fan-out failed unexpectedly');
  });
}

export async function dispatchLocalPostToFollowers({
  post,
  localPublicKey,
  localFingerprint,
  contacts,
  blockedPeers,
  replyParent,
  invalidateWebPushCapability,
  dispatch
}: LocalPostFollowerPushOptions): Promise<void> {
  if (post.object_type !== 'mycelium.post'
    || post.author !== localPublicKey
    || !(await validateDistributedObject(post))) return;

  const payload = isRecord(post.payload) ? post.payload : null;
  const parentId = payload?.reply_to;
  let excludedReplyAuthor: string | null = null;
  if (parentId !== undefined) {
    if (typeof parentId !== 'string'
      || !replyParent
      || replyParent.object_type !== 'mycelium.post'
      || replyParent.object_id !== parentId
      || !(await validateDistributedObject(replyParent))) return;
    excludedReplyAuthor = replyParent.author;
  } else if (replyParent) {
    return;
  }

  const excludedReplyFingerprint = excludedReplyAuthor
    ? await deriveFingerprint(excludedReplyAuthor)
    : null;
  const dispatchedPublicKeys = new Set<string>();
  for (const contact of contacts) {
    if (contact.follower !== true
      || !contact.publicKey
      || contact.publicKey === localPublicKey
      || contact.publicKey === excludedReplyAuthor
      || contact.fingerprint === excludedReplyFingerprint
      || dispatchedPublicKeys.has(contact.publicKey)) continue;

    try {
      const fingerprint = await deriveFingerprint(contact.publicKey);
      if (fingerprint !== contact.fingerprint
        || fingerprint === localFingerprint
        || blockedPeers.has(contact.publicKey)
        || blockedPeers.has(fingerprint)
        || !isWebPushCapability(contact.webPush)) continue;
      dispatchedPublicKeys.add(contact.publicKey);
      const capability = contact.webPush;
      try {
        const result = await dispatch(post, capability);
        await invalidateWebPushCapabilityAfterDispatch(
          result,
          contact.publicKey,
          fingerprint,
          capability,
          invalidateWebPushCapability
        );
      } catch {
        console.warn('Web Push followed-post dispatch failed unexpectedly');
      }
    } catch {
      console.warn('Web Push followed-post recipient validation failed');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
