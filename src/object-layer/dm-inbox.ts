import { importEncryptionPublicKey } from '../crypto/dm-crypto';
import { isObjectExpired, validateDistributedObject } from './envelope';
import { DM_OBJECT_TYPE, decryptDmObject, validateDmPayload, type DmObjectIdentity } from './dm-object';
import type { DistributedObject, ObjectStore } from './types';

export type OpenDmResult =
  | { status: 'ok'; plaintext: string; counterparty: string }
  | { status: 'unverified' | 'key_changed' | 'invalid' };

export type SenderEncryptionKeyResolver = (authorSigningKey: string) => Promise<string | null> | string | null;

export async function listDmsForIdentity({
  store,
  myPublicKey
}: {
  store: ObjectStore;
  myPublicKey: string;
}): Promise<DistributedObject[]> {
  const [received, sent] = await Promise.all([
    store.query({ object_type: DM_OBJECT_TYPE, recipient: myPublicKey }),
    store.query({ object_type: DM_OBJECT_TYPE, author: myPublicKey })
  ]);
  const uniqueObjects = new Map<string, DistributedObject>();
  for (const object of [...received, ...sent]) {
    if (object.object_type !== DM_OBJECT_TYPE
      || (object.recipient !== myPublicKey && object.author !== myPublicKey)
      || isObjectExpired(object)) continue;
    uniqueObjects.set(object.object_id, object);
  }
  return [...uniqueObjects.values()].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export async function openDm({
  object,
  identity,
  resolveSenderEncryptionKey
}: {
  object: DistributedObject;
  identity: DmObjectIdentity;
  resolveSenderEncryptionKey: SenderEncryptionKeyResolver;
}): Promise<OpenDmResult> {
  if (object.object_type !== DM_OBJECT_TYPE) return { status: 'invalid' };

  const isAuthor = object.author === identity.publicKey;
  const isRecipient = object.recipient === identity.publicKey;
  if (!isAuthor && !isRecipient) return { status: 'invalid' };

  let expectedSenderEncryptionKey: string | undefined;
  if (!isAuthor && isRecipient) {
    let trustedSenderEncryptionKey: string | null;
    try {
      trustedSenderEncryptionKey = await resolveSenderEncryptionKey(object.author);
    } catch {
      return { status: 'invalid' };
    }
    if (trustedSenderEncryptionKey === null) return { status: 'unverified' };

    if (!(await validateDistributedObject(object)) || !validateDmPayload(object.payload)) {
      return { status: 'invalid' };
    }
    if (object.payload.sender_enc_key !== trustedSenderEncryptionKey) {
      try {
        await importEncryptionPublicKey(trustedSenderEncryptionKey);
      } catch {
        return { status: 'invalid' };
      }
      return { status: 'key_changed' };
    }
    expectedSenderEncryptionKey = trustedSenderEncryptionKey;
  }

  try {
    const plaintext = await decryptDmObject({ object, identity, expectedSenderEncryptionKey });
    return { status: 'ok', plaintext, counterparty: isAuthor ? object.recipient! : object.author };
  } catch {
    return { status: 'invalid' };
  }
}

export async function openDms({
  objects,
  identity,
  resolveSenderEncryptionKey
}: {
  objects: readonly DistributedObject[];
  identity: DmObjectIdentity;
  resolveSenderEncryptionKey: SenderEncryptionKeyResolver;
}): Promise<OpenDmResult[]> {
  const results: OpenDmResult[] = [];
  for (const object of objects) {
    results.push(await openDm({ object, identity, resolveSenderEncryptionKey }));
  }
  return results;
}