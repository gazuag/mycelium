import { getContactEncryptionKey, type ContactEncryptionKeyState } from '../crypto/dm-crypto';
import { createDmObject, type DmObjectIdentity } from './dm-object';
import type { DistributedObject, ObjectStore } from './types';

export interface DmRecipientContact extends ContactEncryptionKeyState {
  readonly publicKey: string;
}

export interface SendDmOptions {
  identity: DmObjectIdentity;
  recipientContact: DmRecipientContact;
  plaintext: string;
  store: ObjectStore;
  replicate: (object: DistributedObject) => Promise<string[]>;
  now?: () => Date;
}

export type SendDmResult =
  | { status: 'sent'; object: DistributedObject; replicatedTo: string[]; keyChanged: boolean }
  | { status: 'no_key' | 'invalid' | 'store_failed'; replicatedTo: []; keyChanged: boolean };

export async function sendDm({
  identity,
  recipientContact,
  plaintext,
  store,
  replicate,
  now
}: SendDmOptions): Promise<SendDmResult> {
  const keyChanged = recipientContact.encryptionKeyChanged === true;
  if (!plaintext.trim() || plaintext.length > 4000) {
    return { status: 'invalid', replicatedTo: [], keyChanged };
  }

  const recipientEncryptionKey = getContactEncryptionKey(recipientContact);
  if (recipientEncryptionKey === null) {
    return { status: 'no_key', replicatedTo: [], keyChanged };
  }

  const object = await createDmObject({
    identity,
    recipientSigningKey: recipientContact.publicKey,
    recipientEncryptionKey,
    plaintext,
    ...(now ? { now } : {})
  });

  try {
    await store.put(object);
  } catch {
    return { status: 'store_failed', replicatedTo: [], keyChanged };
  }

  let replicatedTo: string[];
  try {
    replicatedTo = await replicate(object);
  } catch {
    replicatedTo = [];
  }

  return { status: 'sent', object, replicatedTo, keyChanged };
}
