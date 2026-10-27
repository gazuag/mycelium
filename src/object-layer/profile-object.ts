import { isObjectExpired } from './envelope';
import { IDENTITY_OBJECT_TYPE, validateIdentityObject, type IdentityObject } from './identity-object';
import type { ObjectStore } from './types';

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

function compareIdentityObjectVersions(left: IdentityObject, right: IdentityObject): number {
  const leftTime = Date.parse(left.created_at);
  const rightTime = Date.parse(right.created_at);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.object_id < right.object_id ? -1 : left.object_id > right.object_id ? 1 : 0;
}
