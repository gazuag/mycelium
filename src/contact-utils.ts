import type { Contact } from './types';
import type { IdentityObject } from './object-layer/identity-object';

export function contactWithIdentityProfile(
  previous: Contact | undefined,
  profile: IdentityObject,
  fingerprint: string
): Contact {
  return {
    ...previous,
    publicKey: profile.author,
    fingerprint,
    displayName: profile.payload.display_name,
    identityObject: profile,
    profilePicture: profile.payload.profile_picture,
    addedAt: previous?.addedAt ?? new Date().toISOString(),
    followed: previous?.followed ?? false,
    online: previous?.online ?? false,
    connected: previous?.connected ?? false
  };
}

export function dedupeContactsByFingerprint(items: Contact[]): Contact[] {
  const mergedByFingerprint = new Map<string, Contact>();

  for (const contact of items) {
    const existing = mergedByFingerprint.get(contact.fingerprint);
    if (!existing) {
      mergedByFingerprint.set(contact.fingerprint, contact);
      continue;
    }

    const existingReadAt = existing.lastReadAt;
    const incomingReadAt = contact.lastReadAt;
    const lastReadAt = existingReadAt === undefined
      ? incomingReadAt
      : incomingReadAt === undefined || Date.parse(existingReadAt) >= Date.parse(incomingReadAt)
        ? existingReadAt
        : incomingReadAt;

    mergedByFingerprint.set(contact.fingerprint, {
      ...existing,
      ...contact,
      displayName: contact.displayName ?? existing.displayName,
      profile: contact.profile ?? existing.profile,
      addedAt: existing.addedAt < contact.addedAt ? existing.addedAt : contact.addedAt,
      lastReadAt,
      online: contact.online ?? existing.online,
      connected: contact.connected ?? existing.connected
    });
  }

  return Array.from(mergedByFingerprint.values());
}
