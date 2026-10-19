import { canonicalize } from '../p2p/protocol';
import { sha256, verifySignedString } from '../crypto/identity';
import type { DistributedObject, JsonValue, ObjectContent, ObjectIdentity, ObjectSignatureVerifier, RecommendationAction, RecommendationObject } from './types';

export type ImmutableObjectContent = Omit<DistributedObject, 'object_id' | 'signature'>;

export function immutableObjectContent(object: DistributedObject): ImmutableObjectContent {
  return {
    object_type: object.object_type,
    author: object.author,
    ...(object.recipient === undefined ? {} : { recipient: object.recipient }),
    created_at: object.created_at,
    ...(object.expires_at === undefined ? {} : { expires_at: object.expires_at }),
    ...(object.sequence === undefined ? {} : { sequence: object.sequence }),
    payload: object.payload,
    replication_policy: object.replication_policy
  };
}

export function canonicalizeObjectContent(content: ImmutableObjectContent | DistributedObject): string {
  const immutableContent = 'object_id' in content || 'signature' in content
    ? immutableObjectContent(content as DistributedObject)
    : content;
  return canonicalize(immutableContent);
}

export async function calculateObjectId(content: ImmutableObjectContent | DistributedObject): Promise<string> {
  return sha256(canonicalizeObjectContent(content));
}

export async function createSignedObject(content: ObjectContent, identity: ObjectIdentity): Promise<DistributedObject> {
  const unsigned: ImmutableObjectContent = {
    ...content,
    author: identity.publicKey
  };
  if (!isValidImmutableObjectContent(unsigned)) {
    throw new Error('Invalid distributed object content');
  }

  const canonicalContent = canonicalizeObjectContent(unsigned);
  const contentHash = await sha256(canonicalContent);
  const authorProof = await identity.sign(canonicalize({
    domain: 'mycelium.object-author-proof.v2',
    author: identity.publicKey,
    content_hash: contentHash
  }));
  const objectId = await calculateAuthorBoundObjectId(identity.publicKey, contentHash);
  const signature = await identity.sign(canonicalContent);
  return {
    ...unsigned,
    object_id: objectId,
    signature,
    object_id_version: 2,
    content_hash: contentHash,
    author_proof: authorProof
  };
}

export async function calculateAuthorBoundObjectId(
  author: string,
  contentHash: string
): Promise<string> {
  return sha256(canonicalize({
    domain: 'mycelium.object-id.v2',
    author,
    content_hash: contentHash
  }));
}

export async function verifyAuthorBoundObjectId(
  author: string,
  contentHash: string,
  authorProof: string,
  objectId: string,
  verifySignature: ObjectSignatureVerifier = verifySignedString
): Promise<boolean> {
  if (!isHexSha256(objectId) || !isHexSha256(contentHash) || !author || !authorProof) return false;
  const expectedId = await calculateAuthorBoundObjectId(author, contentHash);
  if (expectedId !== objectId) return false;
  try {
    return await verifySignature(
      author,
      canonicalize({
        domain: 'mycelium.object-author-proof.v2',
        author,
        content_hash: contentHash
      }),
      authorProof
    );
  } catch {
    return false;
  }
}

export async function createSignedRecommendationObject(
  postId: string,
  action: RecommendationAction,
  sequence: number,
  identity: ObjectIdentity
): Promise<RecommendationObject> {
  return await createSignedObject({
    object_type: 'mycelium.recommendation',
    created_at: new Date().toISOString(),
    sequence,
    payload: { post_id: postId, action, sequence },
    replication_policy: {}
  }, identity) as RecommendationObject;
}

export function isRecommendationObject(object: DistributedObject): object is RecommendationObject {
  if (object.object_type !== 'mycelium.recommendation') return false;
  if (typeof object.sequence !== 'number' || !Number.isSafeInteger(object.sequence) || object.sequence < 1) return false;
  if (!object.payload || typeof object.payload !== 'object' || Array.isArray(object.payload)) return false;
  const payload = object.payload as Record<string, unknown>;
  return typeof payload.post_id === 'string'
    && /^[0-9a-f]{64}$/.test(payload.post_id)
    && (payload.action === 'recommend' || payload.action === 'withdraw')
    && payload.sequence === object.sequence;
}

export function isObjectExpired(object: DistributedObject, now: Date = new Date()): boolean {
  const expiresAt = object.expires_at !== undefined
    ? object.expires_at
    : object.replication_policy.expires_at;
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}

export async function validateObject(value: unknown, identity?: ObjectIdentity): Promise<boolean> {
  return validateDistributedObject(value, identity
    ? (author, content, signature) => identity.verify(author, content, signature)
    : undefined);
}

export async function validateDistributedObject(
  value: unknown,
  verifySignature: ObjectSignatureVerifier = verifySignedString
): Promise<boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Partial<DistributedObject>;
  if (!isHexSha256(object.object_id) || typeof object.signature !== 'string' || !object.signature
    || !isValidImmutableObjectContent(object as ImmutableObjectContent)) {
    return false;
  }
  const validatedObject = object as DistributedObject;

  if (validatedObject.object_id_version === undefined) {
    if (validatedObject.content_hash !== undefined || validatedObject.author_proof !== undefined) return false;
    if (await calculateObjectId(validatedObject) !== validatedObject.object_id) return false;
  } else if (validatedObject.object_id_version === 2) {
    if (!isHexSha256(validatedObject.content_hash)
      || typeof validatedObject.author_proof !== 'string'
      || !validatedObject.author_proof) return false;
    const canonicalContent = canonicalizeObjectContent(validatedObject);
    const contentHash = await sha256(canonicalContent);
    if (contentHash !== validatedObject.content_hash
      || !(await verifyAuthorBoundObjectId(
        validatedObject.author,
        validatedObject.content_hash,
        validatedObject.author_proof,
        validatedObject.object_id,
        verifySignature
      ))) return false;
  } else {
    return false;
  }

  try {
    return await verifySignature(validatedObject.author, canonicalizeObjectContent(validatedObject), validatedObject.signature);
  } catch {
    return false;
  }
}

function isValidImmutableObjectContent(content: Partial<ImmutableObjectContent>): content is ImmutableObjectContent {
  return typeof content.object_type === 'string' && Boolean(content.object_type)
    && typeof content.author === 'string' && Boolean(content.author)
    && (content.recipient === undefined || (typeof content.recipient === 'string' && content.recipient.length > 0))
    && isIsoDate(content.created_at)
    && isJsonValue(content.payload)
    && isReplicationPolicy(content.replication_policy)
    && (content.expires_at === undefined || isIsoDate(content.expires_at))
    && (content.sequence === undefined || (Number.isSafeInteger(content.sequence) && content.sequence >= 0));
}

function isHexSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isReplicationPolicy(value: unknown): value is DistributedObject['replication_policy'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  const budget = policy.replication_budget;
  const expiresAt = policy.expires_at;
  return (budget === undefined || (typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 0))
    && (expiresAt === undefined || isIsoDate(expiresAt));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null)
      && Object.values(value).every(isJsonValue);
  }
  return false;
}