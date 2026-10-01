import { createObjectIdentity } from './identity';
import { createSignedObject, validateObject } from './envelope';
import type { DistributedObject } from './types';
import {
  decryptDm,
  deriveDmKey,
  encryptDm,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
  type EncryptionKeyBindingIdentity
} from '../crypto/dm-crypto';

export const DM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DM_REPLICATION_BUDGET = 3;
export const DM_OBJECT_TYPE = 'mycelium.dm';
const DM_AAD_DOMAIN = 'mycelium-dm-aad-v1';

export interface DmObjectIdentity extends EncryptionKeyBindingIdentity {
  readonly id: string;
  readonly encryptionPrivateKey: string;
}

export interface DmPayload {
  readonly v: 1;
  readonly recipient: string;
  readonly sender_enc_key: string;
  readonly recipient_enc_key: string;
  readonly ciphertext: string;
  readonly nonce: string;
}

export interface CreateDmObjectOptions {
  readonly identity: DmObjectIdentity;
  readonly recipientSigningKey: string;
  readonly recipientEncryptionKey: string;
  readonly plaintext: string;
  readonly expiresInMs?: number;
}

export interface DecryptDmObjectOptions {
  readonly object: DistributedObject;
  readonly identity: DmObjectIdentity;
  readonly expectedSenderEncryptionKey?: string;
}

export async function createDmObject({
  identity,
  recipientSigningKey,
  recipientEncryptionKey,
  plaintext,
  expiresInMs = DM_TTL_MS
}: CreateDmObjectOptions): Promise<DistributedObject> {
  const senderEncryptionKey = identity.encryptionPublicKey;
  const recipientKey = await importEncryptionPublicKey(recipientEncryptionKey);
  const context = createDmKeyContext(senderEncryptionKey, recipientEncryptionKey);
  const key = await deriveDmKey(await importEncryptionPrivateKey(identity.encryptionPrivateKey), recipientKey, context);
  const aad = createDmAad(identity.publicKey, recipientSigningKey, senderEncryptionKey, recipientEncryptionKey);
  const encrypted = await encryptDm(key, plaintext, aad);
  const createdAt = new Date();

  return await createSignedObject({
    object_type: DM_OBJECT_TYPE,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + expiresInMs).toISOString(),
    payload: {
      v: 1,
      recipient: recipientSigningKey,
      sender_enc_key: senderEncryptionKey,
      recipient_enc_key: recipientEncryptionKey,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce
    },
    replication_policy: { replication_budget: DM_REPLICATION_BUDGET }
  }, createObjectIdentity({ id: identity.id, publicKey: identity.publicKey, privateKey: identity.privateKey }));
}

export function validateDmPayload(payload: unknown): payload is DmPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  if (candidate.v !== 1
    || typeof candidate.recipient !== 'string'
    || typeof candidate.sender_enc_key !== 'string'
    || typeof candidate.recipient_enc_key !== 'string'
    || typeof candidate.ciphertext !== 'string'
    || typeof candidate.nonce !== 'string') return false;

  const recipient = decodeBase64(candidate.recipient);
  const senderKey = decodeBase64(candidate.sender_enc_key);
  const recipientKey = decodeBase64(candidate.recipient_enc_key);
  const ciphertext = decodeBase64(candidate.ciphertext);
  const nonce = decodeBase64(candidate.nonce);
  return Boolean(recipient?.length && senderKey?.length && recipientKey?.length
    && ciphertext && ciphertext.length >= 16
    && nonce?.length === 12);
}

export async function decryptDmObject({
  object,
  identity,
  expectedSenderEncryptionKey
}: DecryptDmObjectOptions): Promise<string> {
  if (object.object_type !== DM_OBJECT_TYPE) throw new Error('Unsupported direct-message object type');
  if (!(await validateObject(object))) throw new Error('Invalid signed direct-message object');
  if (!validateDmPayload(object.payload)) throw new Error('Invalid direct-message payload');

  const payload = object.payload;
  let peerEncryptionKey: string;
  if (object.author === identity.publicKey) {
    if (payload.sender_enc_key !== identity.encryptionPublicKey) throw new Error('Direct-message sender encryption key mismatch');
    peerEncryptionKey = payload.recipient_enc_key;
  } else if (payload.recipient === identity.publicKey) {
    if (payload.recipient_enc_key !== identity.encryptionPublicKey) throw new Error('Direct-message recipient encryption key mismatch');
    if (payload.sender_enc_key !== expectedSenderEncryptionKey) throw new Error('Unexpected direct-message sender encryption key');
    peerEncryptionKey = payload.sender_enc_key;
  } else {
    throw new Error('Identity is neither the author nor the recipient');
  }

  const key = await deriveDmKey(
    await importEncryptionPrivateKey(identity.encryptionPrivateKey),
    await importEncryptionPublicKey(peerEncryptionKey),
    createDmKeyContext(payload.sender_enc_key, payload.recipient_enc_key)
  );
  const aad = createDmAad(object.author, payload.recipient, payload.sender_enc_key, payload.recipient_enc_key);
  return await decryptDm(key, { ciphertext: payload.ciphertext, nonce: payload.nonce }, aad);
}

function createDmKeyContext(firstPublicKey: string, secondPublicKey: string): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [firstPublicKey, secondPublicKey].sort().map((key) => encoder.encode(key));
  const byteLength = fields.reduce((total, field) => total + 4 + field.byteLength, 0);
  const context = new Uint8Array(byteLength);
  const view = new DataView(context.buffer as ArrayBuffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    context.set(field, offset);
    offset += field.byteLength;
  }
  return context;
}

function createDmAad(author: string, recipient: string, senderEncryptionKey: string, recipientEncryptionKey: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    domain: DM_AAD_DOMAIN,
    object_type: DM_OBJECT_TYPE,
    v: 1,
    author,
    recipient,
    sender_enc_key: senderEncryptionKey,
    recipient_enc_key: recipientEncryptionKey
  }));
}

function decodeBase64(value: string): Uint8Array | null {
  if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}