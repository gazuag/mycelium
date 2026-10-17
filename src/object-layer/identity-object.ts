import type { EncryptionKeyBinding } from '../crypto/dm-crypto';
import { verifyEncryptionKeyBinding } from '../crypto/dm-crypto';
import { createSignedObject, validateDistributedObject } from './envelope';
import type { DistributedObject, ObjectContent, ObjectIdentity } from './types';

export const IDENTITY_OBJECT_TYPE = 'mycelium.identity';

export interface IdentityObjectPayload {
  readonly display_name: string;
  readonly bio: string;
  readonly encryption_public_key: string;
  readonly encryption_key_binding: EncryptionKeyBinding;
}

export type IdentityObject = DistributedObject & {
  readonly object_type: typeof IDENTITY_OBJECT_TYPE;
  readonly payload: IdentityObjectPayload;
};

export interface CreateSignedIdentityObjectOptions {
  readonly display_name: string;
  readonly bio: string;
  readonly encryption_public_key: string;
  readonly encryption_key_binding: EncryptionKeyBinding;
  readonly created_at?: string;
}

export async function createSignedIdentityObject(
  options: CreateSignedIdentityObjectOptions,
  identity: ObjectIdentity
): Promise<IdentityObject> {
  const content: ObjectContent = {
    object_type: IDENTITY_OBJECT_TYPE,
    created_at: options.created_at ?? new Date().toISOString(),
    payload: {
      display_name: options.display_name,
      bio: options.bio,
      encryption_public_key: options.encryption_public_key,
      encryption_key_binding: {
        signing_public_key: options.encryption_key_binding.signing_public_key,
        encryption_public_key: options.encryption_key_binding.encryption_public_key,
        created_at: options.encryption_key_binding.created_at,
        signature: options.encryption_key_binding.signature
      }
    },
    replication_policy: {}
  };
  return await createSignedObject(content, identity) as IdentityObject;
}

export async function validateIdentityObject(value: unknown): Promise<boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<IdentityObject>;
  if (candidate.object_type !== IDENTITY_OBJECT_TYPE
    || !candidate.payload
    || typeof candidate.payload !== 'object'
    || Array.isArray(candidate.payload)) {
    return false;
  }

  const payload = candidate.payload as Partial<IdentityObjectPayload>;
  if (typeof payload.display_name !== 'string'
    || typeof payload.bio !== 'string'
    || typeof payload.encryption_public_key !== 'string'
    || !payload.encryption_key_binding
    || typeof payload.encryption_key_binding !== 'object') {
    return false;
  }

  if (!(await validateDistributedObject(value))) return false;
  const object = value as IdentityObject;
  const binding = object.payload.encryption_key_binding;
  if (binding.signing_public_key !== object.author
    || binding.encryption_public_key !== object.payload.encryption_public_key) {
    return false;
  }
  return await verifyEncryptionKeyBinding(binding);
}
