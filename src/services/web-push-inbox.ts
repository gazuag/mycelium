import type { DistributedObject } from '../object-layer/types';

export const WEB_PUSH_ENVELOPE_MAX_BYTES = 3900;
export const WEB_PUSH_STAGING_MAX_ENTRIES = 32;
export const WEB_PUSH_STAGED_MESSAGE_TYPE = 'MYCELIUM_PUSH_STAGED_V1';

export type IncomingWebPushEnvelope =
  | { readonly version: 1; readonly type: 'object'; readonly object: DistributedObject }
  | { readonly version: 1; readonly type: 'reference'; readonly object_id: string };

export interface StagedWebPushItem {
  readonly id: string;
  readonly envelope: IncomingWebPushEnvelope;
}

export function parseIncomingWebPushEnvelope(value: unknown): IncomingWebPushEnvelope | null {
  if (!isRecord(value) || value.version !== 1) return null;

  if (value.type === 'reference') {
    if (!hasOnlyKeys(value, ['version', 'type', 'object_id'])
      || typeof value.object_id !== 'string'
      || !isObjectId(value.object_id)) return null;
    return { version: 1, type: 'reference', object_id: value.object_id };
  }

  if (value.type !== 'object' || !hasOnlyKeys(value, ['version', 'type', 'object'])
    || !isDistributedObjectShape(value.object)) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WEB_PUSH_ENVELOPE_MAX_BYTES) return null;
  } catch {
    return null;
  }
  return { version: 1, type: 'object', object: value.object };
}

export function parseStagedWebPushMessage(value: unknown): StagedWebPushItem[] | null {
  if (!isRecord(value) || value.type !== WEB_PUSH_STAGED_MESSAGE_TYPE
    || !Array.isArray(value.items) || value.items.length > WEB_PUSH_STAGING_MAX_ENTRIES) return null;
  const items: StagedWebPushItem[] = [];
  for (const candidate of value.items) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !isObjectId(candidate.id)) return null;
    const envelope = parseIncomingWebPushEnvelope(candidate.envelope);
    if (!envelope || envelopeObjectId(envelope) !== candidate.id) return null;
    items.push({ id: candidate.id, envelope });
  }
  return items;
}

export function envelopeObjectId(envelope: IncomingWebPushEnvelope): string {
  return envelope.type === 'object' ? envelope.object.object_id : envelope.object_id;
}

function isDistributedObjectShape(value: unknown): value is DistributedObject {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'object_type', 'object_id', 'author', 'recipient', 'created_at', 'expires_at',
      'sequence', 'payload', 'signature', 'replication_policy', 'object_id_version',
      'content_hash', 'author_proof'
    ])) return false;
  if (!isObjectId(value.object_id)
    || typeof value.object_type !== 'string' || !value.object_type || value.object_type.length > 128
    || typeof value.author !== 'string' || !value.author || value.author.length > 2048
    || typeof value.created_at !== 'string' || value.created_at.length > 64
    || typeof value.signature !== 'string' || !value.signature || value.signature.length > 2048
    || !isRecord(value.replication_policy)
    || !isJsonValue(value.payload, 0, { remaining: 4096 })) return false;
  if (value.recipient !== undefined
    && (typeof value.recipient !== 'string' || !value.recipient || value.recipient.length > 2048)) return false;
  if (value.expires_at !== undefined
    && (typeof value.expires_at !== 'string' || value.expires_at.length > 64)) return false;
  if (value.sequence !== undefined
    && (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0)) return false;
  if (value.object_id_version !== undefined && value.object_id_version !== 2 && value.object_id_version !== 3) return false;
  if (value.content_hash !== undefined && !isObjectId(value.content_hash)) return false;
  if (value.author_proof !== undefined
    && (typeof value.author_proof !== 'string' || !value.author_proof || value.author_proof.length > 2048)) return false;

  const policy = value.replication_policy;
  if (!hasOnlyKeys(policy, ['replication_budget', 'expires_at'])
    || (policy.replication_budget !== undefined
      && (typeof policy.replication_budget !== 'number'
        || !Number.isSafeInteger(policy.replication_budget) || policy.replication_budget < 0))
    || (policy.expires_at !== undefined
      && (typeof policy.expires_at !== 'string' || policy.expires_at.length > 64))) return false;

  return isJsonValue(value, 0, { remaining: 4096 });
}

function isJsonValue(value: unknown, depth: number, budget: { remaining: number }): boolean {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 4096 && value.every((item) => isJsonValue(item, depth + 1, budget));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1, budget));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
