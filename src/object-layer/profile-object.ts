import { isObjectExpired } from './envelope';
import { deriveFingerprint } from '../crypto/identity';
import { IDENTITY_OBJECT_TYPE, validateIdentityObject, type IdentityObject } from './identity-object';
import { findObjectsFromCandidatesByFindQueryPage } from './transport';
import type { DistributedObject, FindQueryCriteria, ObjectStore } from './types';

export async function getLatestIdentityObject(
  store: ObjectStore,
  author: string
): Promise<IdentityObject | null> {
  const candidates = await store.query({ object_type: IDENTITY_OBJECT_TYPE, author });
  const validProfiles: IdentityObject[] = [];
  for (const candidate of candidates) {
    if (isObjectExpired(candidate) || !(await validateIdentityObject(candidate))) continue;
    validProfiles.push(candidate as IdentityObject);
  }
  return selectLatestIdentityObject(validProfiles);
}

export async function getLatestIdentityObjects(store: ObjectStore): Promise<IdentityObject[]> {
  const candidates = await store.query({ object_type: IDENTITY_OBJECT_TYPE });
  const validProfiles: IdentityObject[] = [];
  for (const candidate of candidates) {
    if (isObjectExpired(candidate) || !(await validateIdentityObject(candidate))) continue;
    validProfiles.push(candidate as IdentityObject);
  }

  const latestByAuthor = new Map<string, IdentityObject>();
  for (const profile of validProfiles) {
    const current = latestByAuthor.get(profile.author);
    if (!current || compareIdentityObjectVersions(profile, current) > 0) {
      latestByAuthor.set(profile.author, profile);
    }
  }
  return [...latestByAuthor.values()];
}

export async function findLatestIdentityObjectsByConnectionQuery(
  store: ObjectStore,
  query: FindQueryCriteria,
  getConnectedPeerIds: () => readonly string[]
): Promise<{ objects: DistributedObject[]; hasMore: boolean }> {
  const profiles = await getLatestIdentityObjects(store);
  const peerIdsByAuthor = await Promise.all(
    profiles.map((profile) => deriveFingerprint(profile.author))
  );
  const connectedPeerIds = new Set(getConnectedPeerIds());
  const connectedAuthors = new Set(
    profiles
      .filter((_profile, index) => connectedPeerIds.has(peerIdsByAuthor[index]))
      .map((profile) => profile.author)
  );

  return findObjectsFromCandidatesByFindQueryPage(profiles, query, connectedAuthors);
}

export function selectLatestIdentityObject(
  profiles: readonly IdentityObject[]
): IdentityObject | null {
  return profiles.reduce<IdentityObject | null>(
    (latest, candidate) => !latest || compareIdentityObjectVersions(candidate, latest) > 0
      ? candidate
      : latest,
    null
  );
}

export async function storeDiscoveredIdentityProfiles(
  store: ObjectStore,
  candidates: readonly DistributedObject[],
  localPeerId: string
): Promise<string[]> {
  const latestByAuthor = new Map<string, IdentityObject>();
  for (const candidate of candidates) {
    if (isObjectExpired(candidate) || !(await validateIdentityObject(candidate))) continue;
    const profile = candidate as IdentityObject;
    const current = latestByAuthor.get(profile.author);
    if (!current || compareIdentityObjectVersions(profile, current) > 0) {
      latestByAuthor.set(profile.author, profile);
    }
  }

  const peerIds = new Set<string>();
  for (const profile of latestByAuthor.values()) {
    const stored = await getLatestIdentityObject(store, profile.author);
    if (!stored || compareIdentityObjectVersions(profile, stored) > 0) {
      await store.put(profile);
    }
    const peerId = await deriveFingerprint(profile.author);
    if (peerId !== localPeerId) peerIds.add(peerId);
  }
  return [...peerIds];
}

export async function storeRequestedIdentityProfile(
  store: ObjectStore,
  candidate: unknown,
  expectedPeerId: string
): Promise<IdentityObject | null> {
  if (!candidate || typeof candidate !== 'object' || !('object_type' in candidate)) return null;
  const object = candidate as DistributedObject;
  if (object.object_type !== IDENTITY_OBJECT_TYPE
    || isObjectExpired(object)
    || !(await validateIdentityObject(object))
    || await deriveFingerprint(object.author) !== expectedPeerId) {
    return null;
  }

  await storeDiscoveredIdentityProfiles(store, [object], expectedPeerId);
  return getLatestIdentityObject(store, object.author);
}

function compareIdentityObjectVersions(left: IdentityObject, right: IdentityObject): number {
  const leftTime = Date.parse(left.created_at);
  const rightTime = Date.parse(right.created_at);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.object_id < right.object_id ? -1 : left.object_id > right.object_id ? 1 : 0;
}
