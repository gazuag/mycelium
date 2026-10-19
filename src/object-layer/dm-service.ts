import type { Contact } from '../types';
import { sendDm, type SendDmResult } from './dm-send';
import type { DmObjectIdentity } from './dm-object';
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
  now?: () => Date;
}

export type SendMessageResult = SendDmResult & { queued: boolean };

export function createDmService({
  getIdentity,
  getContact,
  store,
  outbox,
  connectedPeers,
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
