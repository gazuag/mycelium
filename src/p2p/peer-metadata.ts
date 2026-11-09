import type { AcceptPeerMetadataResult } from '../storage/idb';
import type { Contact, PeerMetadata } from '../types';

export async function createSequencedPeerMetadata(
  metadata: Omit<PeerMetadata, 'sequence'>,
  allocateSequence: () => Promise<number>
): Promise<PeerMetadata> {
  const sequence = await allocateSequence();
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Invalid local profile metadata sequence.');
  }
  return { ...metadata, sequence };
}

export function recordAcceptedPeerMetadataSequence(
  sequences: Map<string, number>,
  publicKey: string,
  sequence: number
): boolean {
  const current = sequences.get(publicKey) ?? 0;
  if (sequence <= current) return false;
  sequences.set(publicKey, sequence);
  return true;
}

export function mergeAcceptedPeerMetadataContact(
  contacts: readonly Contact[],
  result: Extract<AcceptPeerMetadataResult, { status: 'accepted' }>,
  latestSequences: ReadonlyMap<string, number>
): Contact[] {
  const acceptedContact = result.contact;
  if (latestSequences.get(acceptedContact.publicKey) !== result.highestSequence) return [...contacts];

  const existingIndex = contacts.findIndex((contact) =>
    contact.publicKey === acceptedContact.publicKey
    || contact.fingerprint === acceptedContact.fingerprint
  );
  const existing = existingIndex < 0 ? undefined : contacts[existingIndex];
  if (existing && (
    existing.publicKey !== acceptedContact.publicKey
    || existing.fingerprint !== acceptedContact.fingerprint
  )) return [...contacts];

  const updated: Contact = existing
    ? {
        ...existing,
        authenticatedDisplayName: acceptedContact.authenticatedDisplayName,
        follower: acceptedContact.follower,
        webPush: acceptedContact.webPush,
        online: acceptedContact.online,
        connected: acceptedContact.connected,
        encryptionPublicKey: acceptedContact.encryptionPublicKey,
        encryptionKeyChanged: acceptedContact.encryptionKeyChanged
      }
    : acceptedContact;

  return existingIndex < 0
    ? [...contacts, updated]
    : contacts.map((contact, index) => index === existingIndex ? updated : contact);
}
