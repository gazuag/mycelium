import { canonicalize } from '../p2p/protocol';
import {
  createSignedObject,
  isObjectExpired,
  validateDistributedObject,
  verifyAuthorBoundObjectId,
  verifyV3ObjectProof
} from './envelope';
import type { DeletionAwareObjectStore, DeletionTombstone, DistributedObject, ObjectIdentity, ObjectStore } from './types';

export const DELETE_REQUEST_OBJECT_TYPE = 'mycelium.delete-request';
export const DELETE_REQUEST_COMMAND = 'delete';
export const DELETE_REQUEST_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface DeleteRequestPayload {
  readonly command: typeof DELETE_REQUEST_COMMAND;
  readonly target_object_id: string;
  readonly target_object_type: 'mycelium.post' | 'mycelium.dm';
  readonly target_author: string;
  readonly target_created_at: string;
  readonly target_recipient?: string;
  readonly target_object_id_version?: 2 | 3;
  readonly target_content_hash?: string;
  readonly target_author_proof?: string;
}

export async function createDeleteRequest(
  target: DistributedObject,
  identity: ObjectIdentity,
  now: () => Date = () => new Date()
): Promise<DistributedObject> {
  if (target.object_type !== 'mycelium.post' && target.object_type !== 'mycelium.dm') {
    throw new Error('Only posts and direct messages can be deleted');
  }
  if (target.author !== identity.publicKey || !(await validateDistributedObject(target))) {
    throw new Error('Only the verified author can delete this object');
  }

  const createdAt = now();
  let targetProof: Pick<
    DeleteRequestPayload,
    'target_object_id_version' | 'target_content_hash' | 'target_author_proof'
  > = {};
  if (target.object_id_version === 2
    && (typeof target.content_hash !== 'string' || typeof target.author_proof !== 'string')) {
    throw new Error('Version-2 target is missing its author proof');
  }
  if (target.object_id_version === 2) {
    targetProof = {
      target_object_id_version: 2,
      target_content_hash: target.content_hash,
      target_author_proof: target.author_proof
    };
  } else if (target.object_id_version === 3) {
    if (typeof target.content_hash !== 'string' || typeof target.signature !== 'string') {
      throw new Error('Version-3 target is missing its authorship proof');
    }
    targetProof = {
      target_object_id_version: 3,
      target_content_hash: target.content_hash,
      target_author_proof: target.signature
    };
  }
  return createSignedObject({
    object_type: DELETE_REQUEST_OBJECT_TYPE,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + DELETE_REQUEST_TTL_MS).toISOString(),
    payload: {
      command: DELETE_REQUEST_COMMAND,
      target_object_id: target.object_id,
      target_object_type: target.object_type,
      target_author: target.author,
      target_created_at: target.created_at,
      ...(target.recipient === undefined ? {} : { target_recipient: target.recipient }),
      ...targetProof
    },
    replication_policy: { replication_budget: Number.MAX_SAFE_INTEGER }
  }, identity);
}

export async function acceptDeleteRequest(
  request: DistributedObject,
  store: DeletionAwareObjectStore,
  now: Date = new Date()
): Promise<boolean> {
  const createdAt = Date.parse(request.created_at);
  const expiresAt = typeof request.expires_at === 'string' ? Date.parse(request.expires_at) : Number.NaN;
  if (request.object_type !== DELETE_REQUEST_OBJECT_TYPE
    || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt
    || expiresAt > createdAt + DELETE_REQUEST_TTL_MS
    || isObjectExpired(request, now)
    || !(await validateDistributedObject(request))) return false;

  const payload = parseDeleteRequestPayload(request.payload);
  if (!payload || payload.target_author !== request.author) return false;

  const authorized = payload.target_content_hash !== undefined
    && payload.target_author_proof !== undefined
    ? payload.target_object_id_version === 3
      ? await verifyV3ObjectProof(
        payload.target_author,
        payload.target_content_hash,
        payload.target_author_proof,
        payload.target_object_id
      )
      : await verifyAuthorBoundObjectId(
        payload.target_author,
        payload.target_content_hash,
        payload.target_author_proof,
        payload.target_object_id
      )
    : await verifyLegacyTarget(request, payload, store);
  if (!authorized) return false;

  const tombstone: DeletionTombstone = {
    target_object_id: payload.target_object_id,
    target_object_type: payload.target_object_type,
    target_author: payload.target_author,
    target_created_at: payload.target_created_at,
    ...(payload.target_recipient ? { target_recipient: payload.target_recipient } : {}),
    delete_request_id: request.object_id,
    deleted_at: now.toISOString()
  };
  await store.applyDeletionTombstone(tombstone);
  return await store.put(request);
}

export function isDeleteRequest(object: DistributedObject): boolean {
  return object.object_type === DELETE_REQUEST_OBJECT_TYPE;
}

export function isDeletionAwareObjectStore(store: ObjectStore): store is DeletionAwareObjectStore {
  return 'getDeletionTombstone' in store
    && typeof store.getDeletionTombstone === 'function'
    && 'applyDeletionTombstone' in store
    && typeof store.applyDeletionTombstone === 'function';
}

function parseDeleteRequestPayload(value: unknown): DeleteRequestPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.command !== DELETE_REQUEST_COMMAND
    || typeof payload.target_object_id !== 'string'
    || !/^[0-9a-f]{64}$/.test(payload.target_object_id)
    || (payload.target_object_type !== 'mycelium.post' && payload.target_object_type !== 'mycelium.dm')
    || typeof payload.target_author !== 'string' || !payload.target_author
    || typeof payload.target_created_at !== 'string' || !Number.isFinite(Date.parse(payload.target_created_at))
    || (payload.target_recipient !== undefined
      && (typeof payload.target_recipient !== 'string' || !payload.target_recipient))
    || (payload.target_object_id_version !== undefined
      && payload.target_object_id_version !== 2 && payload.target_object_id_version !== 3)
    || (payload.target_content_hash !== undefined
      && (typeof payload.target_content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(payload.target_content_hash)))
    || (payload.target_author_proof !== undefined
      && (typeof payload.target_author_proof !== 'string' || !payload.target_author_proof))
    || (payload.target_content_hash === undefined) !== (payload.target_author_proof === undefined)
    || ((payload.target_object_id_version === 2 || payload.target_object_id_version === 3)
      && payload.target_content_hash === undefined)) return null;
  if (payload.target_object_type === 'mycelium.dm' && typeof payload.target_recipient !== 'string') return null;
  if (payload.target_object_type === 'mycelium.post' && payload.target_recipient !== undefined) return null;

  return {
    command: DELETE_REQUEST_COMMAND,
    target_object_id: payload.target_object_id,
    target_object_type: payload.target_object_type,
    target_author: payload.target_author,
    target_created_at: payload.target_created_at,
    ...(typeof payload.target_recipient === 'string' ? { target_recipient: payload.target_recipient } : {}),
    ...(payload.target_object_id_version === 2 || payload.target_object_id_version === 3
      ? { target_object_id_version: payload.target_object_id_version }
      : {}),
    ...(typeof payload.target_content_hash === 'string' ? { target_content_hash: payload.target_content_hash } : {}),
    ...(typeof payload.target_author_proof === 'string' ? { target_author_proof: payload.target_author_proof } : {})
  };
}

async function verifyLegacyTarget(
  request: DistributedObject,
  payload: DeleteRequestPayload,
  store: DeletionAwareObjectStore
): Promise<boolean> {
  const target = await store.get(payload.target_object_id);
  return target !== null
    && target.object_type === payload.target_object_type
    && target.author === request.author
    && target.created_at === payload.target_created_at
    && target.recipient === payload.target_recipient
    && await validateDistributedObject(target);
}
