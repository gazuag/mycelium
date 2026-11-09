import { deriveFingerprint } from '../crypto/identity';
import { isWebPushCapability } from '../services/web-push';
import {
  invalidateWebPushCapabilityAfterDispatch,
  type InvalidateWebPushCapability
} from '../services/web-push-capability-invalidation';
import type { WebPushDispatchResult } from '../services/web-push-dispatch';
import type { Contact, WebPushCapability } from '../types';
import { sendDm, type SendDmResult } from './dm-send';
import { DM_OBJECT_TYPE, type DmObjectIdentity } from './dm-object';
import type { DistributedObject, ObjectStore } from './types';

export interface DmOutboxService {
  enqueue(object: DistributedObject): Promise<void>;
  flush(): Promise<unknown>;
  getEntry(objectId: string): Promise<{
    replication_send_attempted?: boolean;
    replicated_to?: string[];
    direct_send_attempted?: boolean;
    delivered_direct?: boolean;
  } | null>;
  getAttemptedTo(objectId: string): readonly string[];
}

export interface DmServiceOptions {
  getIdentity: () => DmObjectIdentity | null;
  getContact: (publicKey: string) => Contact | null;
  store: ObjectStore;
  outbox: DmOutboxService;
  connectedPeers: () => string[];
  getBlockedPeers?: () => ReadonlySet<string>;
  invalidateWebPushCapability?: InvalidateWebPushCapability;
  dispatchWebPush?: (
    object: DistributedObject,
    capability: WebPushCapability
  ) => Promise<WebPushDispatchResult>;
  now?: () => Date;
}

export type SendMessageResult = SendDmResult & { queued: boolean };

export function createDmService({
  getIdentity,
  getContact,
  store,
  outbox,
  connectedPeers,
  getBlockedPeers,
  invalidateWebPushCapability,
  dispatchWebPush,
  now
}: DmServiceOptions): {
  sendMessage(recipientPublicKey: string, plaintext: string): Promise<SendMessageResult>;
  flushOutbox(): Promise<void>;
} {
  let flushInFlight: Promise<void> | null = null;

  const sendMessage = async (
    recipientPublicKey: string,
    plaintext: string
  ): Promise<SendMessageResult> => {
    const identity = getIdentity();
    if (!identity) {
      return { status: 'invalid', attemptedTo: [], keyChanged: false, queued: false };
    }
    const contact = getContact(recipientPublicKey);
    if (!contact) {
      return { status: 'no_key', attemptedTo: [], keyChanged: false, queued: false };
    }

    const result = await sendDm({
      identity,
      recipientContact: contact,
      plaintext,
      store,
      now,
      replicate: async (object) => {
        await outbox.enqueue(object);
        if (dispatchWebPush) {
          void dispatchLocalDm(object, {
            identity,
            getContact,
            getBlockedPeers,
            invalidateWebPushCapability,
            dispatchWebPush
          }).catch(() => {
            console.warn('Web Push direct-message dispatch failed unexpectedly');
          });
        }
        await outbox.flush();
        const entry = await outbox.getEntry(object.object_id);
        return [...outbox.getAttemptedTo(object.object_id)];
      }
    });

    let queued = false;
    if (result.status === 'sent') {
      try {
        const entry = await outbox.getEntry(result.object.object_id);
        const attempted = entry !== null && (
          entry.direct_send_attempted === true
          || entry.delivered_direct === true
          || entry.replication_send_attempted === true
          || (entry.replicated_to?.length ?? 0) > 0
        );
        queued = entry !== null && !attempted;
        if (entry === null && connectedPeers().length === 0) queued = true;
      } catch {
        queued = true;
      }
    }
    return { ...result, queued };
  };

  const flushOutbox = (): Promise<void> => {
    if (flushInFlight) return flushInFlight;
    flushInFlight = outbox.flush()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        flushInFlight = null;
      });
    return flushInFlight;
  };

  return { sendMessage, flushOutbox };
}

async function dispatchLocalDm(
  object: DistributedObject,
  {
    identity,
    getContact,
    getBlockedPeers,
    invalidateWebPushCapability,
    dispatchWebPush
  }: Pick<DmServiceOptions, 'getContact' | 'getBlockedPeers' | 'invalidateWebPushCapability' | 'dispatchWebPush'> & {
    readonly identity: DmObjectIdentity;
  }
): Promise<void> {
  if (object.object_type !== DM_OBJECT_TYPE || !object.recipient) return;
  if (object.recipient === identity.publicKey) return;

  const [localFingerprint, recipientFingerprint] = await Promise.all([
    deriveFingerprint(identity.publicKey),
    deriveFingerprint(object.recipient)
  ]);
  if (localFingerprint !== identity.id || recipientFingerprint === localFingerprint) return;

  const contact = getContact(object.recipient);
  if (!contact
    || contact.publicKey !== object.recipient
    || contact.fingerprint !== recipientFingerprint
    || !isWebPushCapability(contact.webPush)) return;

  const blockedPeers = getBlockedPeers?.() ?? new Set<string>();
  if (blockedPeers.has(contact.publicKey) || blockedPeers.has(recipientFingerprint)) return;

  const result = await dispatchWebPush?.(object, contact.webPush);
  if (result) {
    await invalidateWebPushCapabilityAfterDispatch(
      result,
      contact.publicKey,
      recipientFingerprint,
      contact.webPush,
      invalidateWebPushCapability
    );
  }
}
