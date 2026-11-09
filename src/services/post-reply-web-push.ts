import { deriveFingerprint } from '../crypto/identity';
import { isObjectExpired, validateDistributedObject } from '../object-layer/envelope';
import type { DistributedObject } from '../object-layer/types';
import type { Contact, WebPushCapability } from '../types';
import { isWebPushCapability } from './web-push';
import {
  invalidateWebPushCapabilityAfterDispatch,
  type InvalidateWebPushCapability
} from './web-push-capability-invalidation';
import type { WebPushDispatchResult } from './web-push-dispatch';

export interface LocalReplyPushOptions {
  readonly reply: DistributedObject;
  readonly parent: DistributedObject;
  readonly storedLocally: boolean;
  readonly localPublicKey: string;
  readonly localFingerprint: string;
  readonly contacts: readonly Contact[];
  readonly blockedPeers: ReadonlySet<string>;
  readonly invalidateWebPushCapability?: InvalidateWebPushCapability;
  readonly dispatch: (
    object: DistributedObject,
    capability: WebPushCapability
  ) => Promise<WebPushDispatchResult>;
}

export async function dispatchLocalReplyToParent({
  reply,
  parent,
  storedLocally,
  localPublicKey,
  localFingerprint,
  contacts,
  blockedPeers,
  invalidateWebPushCapability,
  dispatch
}: LocalReplyPushOptions): Promise<void> {
  if (!storedLocally) return;

  try {
    if (reply.object_type !== 'mycelium.post'
      || reply.author !== localPublicKey
      || !(await validateDistributedObject(reply))
      || parent.object_type !== 'mycelium.post'
      || isObjectExpired(parent)
      || !(await validateDistributedObject(parent))) return;

    const replyPayload = isRecord(reply.payload) ? reply.payload : null;
    if (replyPayload?.reply_to !== parent.object_id) return;

    const recipientPublicKey = parent.author;
    if (recipientPublicKey === localPublicKey) return;
    const [recipientFingerprint, actualLocalFingerprint] = await Promise.all([
      deriveFingerprint(recipientPublicKey),
      deriveFingerprint(localPublicKey)
    ]);
    if (actualLocalFingerprint !== localFingerprint
      || recipientFingerprint === localFingerprint
      || blockedPeers.has(recipientPublicKey)
      || blockedPeers.has(recipientFingerprint)) return;

    const recipient = contacts.find((contact) =>
      contact.publicKey === recipientPublicKey
      && contact.fingerprint === recipientFingerprint
    );
    if (!recipient || !isWebPushCapability(recipient.webPush)) return;

    const capability = recipient.webPush;
    const result = await dispatch(reply, capability);
    await invalidateWebPushCapabilityAfterDispatch(
      result,
      recipient.publicKey,
      recipientFingerprint,
      capability,
      invalidateWebPushCapability
    );
  } catch {
    console.warn('Web Push reply recipient validation or dispatch failed unexpectedly');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
