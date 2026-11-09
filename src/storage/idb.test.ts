import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { acceptPeerMetadata, clearAllLocalData, clearContactWebPushCapabilityIfMatches, deleteContact, identityBackupFields, loadContacts, loadCurrentIdentityBackupFields, loadFeedCursor, loadInboxBackfillState, loadInboxCursor, nextLocalMetadataSequence, openDatabase, parseIdentityMetadataSequence, PEER_CANDIDATE_STORE, PEER_METADATA_STATE_STORE, saveContact, saveFeedCursor, saveInboxBackfillState, saveInboxCursor, saveIdentity } from './idb';
import type { FeedCursor } from '../object-layer/types';

const DATABASE_NAME = 'mycelium_p2p';
const PRESERVED_STORES = [
  'identity',
  'contacts',
  'peer_metadata_state',
  'profiles',
  'discovery_interactions',
  'inbox_cursors'
];
const REMOVED_STORES = ['message_queue', 'direct_chat_messages'];

beforeAll(async () => {
  await deleteDatabase();
});

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion was blocked'));
  });
}

function seedDatabase(version: 5 | 6 | 7 | 8 | 9 | 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('identity', { keyPath: 'key' });
      db.createObjectStore('contacts', { keyPath: 'publicKey' });
      db.createObjectStore('profiles', { keyPath: 'author' });
      db.createObjectStore('discovery_interactions', { keyPath: 'id' });
      const queue = db.createObjectStore('message_queue', { keyPath: 'id' });
      queue.createIndex('recipient', 'recipient');
      const chats = db.createObjectStore('direct_chat_messages', { keyPath: 'id' });
      chats.createIndex('peerId', 'peerId');
      chats.createIndex('timestamp', 'timestamp');
      db.createObjectStore('inbox_cursors', { keyPath: 'identity' });
      if (version >= 8) db.createObjectStore('feed_cursors', { keyPath: 'key' });
      if (version >= 9) {
        for (const storeName of [
          'peer_connection_observations',
          'find_forwarding_observations',
          'object_supply_observations'
        ]) {
          db.createObjectStore(storeName, { keyPath: 'id' }).createIndex('expires_at', 'expires_at');
        }
      }
      if (version >= 10) db.createObjectStore('peer_candidates', { keyPath: 'peerId' }).createIndex('lastSeenAt', 'lastSeenAt');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction([
        ...PRESERVED_STORES.filter((storeName) => storeName !== 'peer_metadata_state'),
        ...REMOVED_STORES,
        ...(version >= 8 ? ['feed_cursors'] : []),
        ...(version >= 10 ? ['peer_candidates'] : [])
      ], 'readwrite');
      tx.objectStore('identity').put({ key: 'local', publicKey: 'preserved-key' });
      tx.objectStore('contacts').put({
        publicKey: 'preserved-contact',
        fingerprint: 'aa:bb:cc:dd:ee:ff:00:11',
        displayName: 'Preserved contact',
        addedAt: '2026-10-01T00:00:00.000Z',
        followed: true,
        online: true,
        connected: true,
        lastSeen: '2026-10-04T10:00:00.000Z'
      });
      tx.objectStore('profiles').put({ author: 'preserved-author' });
      tx.objectStore('discovery_interactions').put({ id: 'preserved-interaction' });
      tx.objectStore('inbox_cursors').put({
        identity: 'preserved-identity',
        cursor: '2026-10-04T10:00:00.000Z',
        updated_at: '2026-10-04T10:00:00.000Z'
      });
      tx.objectStore('message_queue').put({ id: 'old-queue', text: 'legacy plaintext' });
      tx.objectStore('direct_chat_messages').put({ id: 'old-chat', text: 'legacy plaintext' });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error(`Version ${version} seed transaction aborted`));
    };
  });
}

function readRecord<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function expectUpgradedDatabase(version: 5 | 6 | 7 | 8 | 9 | 10): Promise<void> {
  await deleteDatabase();
  await seedDatabase(version);
  const db = await openDatabase();

  expect(db.version).toBe(11);
  expect(db.objectStoreNames.contains('feed_cursors')).toBe(true);
  expect(db.objectStoreNames.contains('peer_connection_observations')).toBe(true);
  expect(db.objectStoreNames.contains('find_forwarding_observations')).toBe(true);
  expect(db.objectStoreNames.contains('object_supply_observations')).toBe(true);
  expect(db.objectStoreNames.contains(PEER_CANDIDATE_STORE)).toBe(true);
  expect(db.objectStoreNames.contains(PEER_METADATA_STATE_STORE)).toBe(true);
  for (const storeName of PRESERVED_STORES) expect(db.objectStoreNames.contains(storeName)).toBe(true);
  for (const storeName of REMOVED_STORES) expect(db.objectStoreNames.contains(storeName)).toBe(false);
  await expect(readRecord(db, 'identity', 'local')).resolves.toMatchObject({
    publicKey: 'preserved-key',
    metadataSequence: 0
  });
  await expect(readRecord(db, 'contacts', 'preserved-contact')).resolves.toEqual({
    publicKey: 'preserved-contact',
    fingerprint: 'aa:bb:cc:dd:ee:ff:00:11',
    displayName: 'Preserved contact',
    addedAt: '2026-10-01T00:00:00.000Z',
    followed: true,
    online: true,
    connected: true,
    lastSeen: '2026-10-04T10:00:00.000Z'
  });
  await expect(readRecord(db, 'profiles', 'preserved-author')).resolves.toBeDefined();
  await expect(readRecord(db, 'discovery_interactions', 'preserved-interaction')).resolves.toBeDefined();
  await expect(readRecord(db, 'inbox_cursors', 'preserved-identity')).resolves.toMatchObject({
    cursor: '2026-10-04T10:00:00.000Z'
  });
  db.close();
}

describe('inbox cursor IndexedDB persistence', () => {
  it('upgrades version 5, removes plaintext chat stores, and preserves application data', async () => {
    await expectUpgradedDatabase(5);
  });

  describe('feed cursor IndexedDB persistence', () => {
    const cursor = (minute: number, suffix: string): FeedCursor => ({
      created_at: new Date(Date.UTC(2026, 9, 7, 10, minute)).toISOString(),
      object_id: suffix.repeat(64)
    });

    it('round-trips cursors and isolates by local identity and peer', async () => {
      const first = cursor(0, 'a');
      const second = cursor(1, 'b');
      await saveFeedCursor('local-a', 'peer-a', first);
      await saveFeedCursor('local-a', 'peer-b', second);
      await saveFeedCursor('local-b', 'peer-a', second);

      await expect(loadFeedCursor('local-a', 'peer-a')).resolves.toEqual(first);
      await expect(loadFeedCursor('local-a', 'peer-b')).resolves.toEqual(second);
      await expect(loadFeedCursor('local-b', 'peer-a')).resolves.toEqual(second);
      await expect(loadFeedCursor('local-b', 'peer-b')).resolves.toBeNull();
    });

    it('never moves a stored keyset cursor backwards', async () => {
      const later = cursor(1, 'b');
      await saveFeedCursor('monotonic-local', 'monotonic-peer', later);
      await saveFeedCursor('monotonic-local', 'monotonic-peer', cursor(0, 'f'));
      await saveFeedCursor('monotonic-local', 'monotonic-peer', cursor(1, 'a'));

      await expect(loadFeedCursor('monotonic-local', 'monotonic-peer')).resolves.toEqual(later);
    });

    it('rejects malformed identities, peers, timestamps, and object ids', async () => {
      await expect(loadFeedCursor('', 'peer')).rejects.toThrow('identity key');
      await expect(loadFeedCursor('identity', '  ')).rejects.toThrow('peer id');
      await expect(saveFeedCursor('identity', 'peer', { created_at: 'invalid', object_id: 'a'.repeat(64) })).rejects.toThrow('ISO timestamp');
      await expect(saveFeedCursor('identity', 'peer', { created_at: '2026-10-07T10:00:00.000Z', object_id: 'invalid' })).rejects.toThrow('object id');
    });
  });

  it('upgrades version 6, removes plaintext chat stores, and preserves application data', async () => {
    await expectUpgradedDatabase(6);
  });

  it('upgrades version 7 while preserving prior stores and data', async () => {
    await expectUpgradedDatabase(7);
  });

  it('upgrades version 8 while preserving feed cursors and adding observation stores', async () => {
    await expectUpgradedDatabase(8);
  });

  it('upgrades the current version 9 schema while preserving existing Contact records', async () => {
    await expectUpgradedDatabase(9);
  });

  it('upgrades the version 10 schema and initializes the legacy identity sequence', async () => {
    await expectUpgradedDatabase(10);
  });

  it('creates a fresh version 11 database with candidate, metadata, and observation stores', async () => {
    await deleteDatabase();
    const db = await openDatabase();

    expect(db.version).toBe(11);
    expect(db.objectStoreNames.contains('inbox_cursors')).toBe(true);
    expect(db.objectStoreNames.contains('feed_cursors')).toBe(true);
    expect(db.objectStoreNames.contains('peer_connection_observations')).toBe(true);
    expect(db.objectStoreNames.contains('find_forwarding_observations')).toBe(true);
    expect(db.objectStoreNames.contains('object_supply_observations')).toBe(true);
    expect(db.objectStoreNames.contains(PEER_CANDIDATE_STORE)).toBe(true);
    expect(db.objectStoreNames.contains(PEER_METADATA_STATE_STORE)).toBe(true);
    for (const storeName of REMOVED_STORES) expect(db.objectStoreNames.contains(storeName)).toBe(false);
    db.close();
  });

  it('returns null when no cursor exists for an identity', async () => {
    await expect(loadInboxCursor('absent-identity')).resolves.toBeNull();
  });

  it('round-trips a saved cursor', async () => {
    const identity = 'round-trip-identity';
    const cursor = '2026-10-04T10:00:00.000Z';

    await expect(saveInboxCursor(identity, cursor)).resolves.toBe(cursor);
    await expect(loadInboxCursor(identity)).resolves.toBe(cursor);
  });

  it('persists backfill state alongside the high-water cursor', async () => {
    const identity = 'backfill-state-identity';
    const backfillState = {
      cursor: '2026-09-20T12:00:00.000Z',
      end: '2026-10-04T12:00:00.000Z'
    };

    await saveInboxBackfillState(identity, backfillState);
    await saveInboxCursor(identity, '2026-10-04T12:00:00.000Z');

    await expect(loadInboxCursor(identity)).resolves.toBe('2026-10-04T12:00:00.000Z');
    await expect(loadInboxBackfillState(identity)).resolves.toEqual(backfillState);

    await saveInboxBackfillState(identity, null);
    await expect(loadInboxBackfillState(identity)).resolves.toBeNull();
    await expect(loadInboxCursor(identity)).resolves.toBe('2026-10-04T12:00:00.000Z');
  });

  it('does not move an existing cursor backwards', async () => {
    const identity = 'monotonic-identity';
    await saveInboxCursor(identity, '2026-10-04T11:00:00.000Z');

    await expect(saveInboxCursor(identity, '2026-10-04T10:00:00.000Z')).resolves.toBe('2026-10-04T11:00:00.000Z');
    await expect(loadInboxCursor(identity)).resolves.toBe('2026-10-04T11:00:00.000Z');
  });

  it('advances an existing cursor when the new timestamp is later', async () => {
    const identity = 'advance-identity';
    await saveInboxCursor(identity, '2026-10-04T10:00:00.000Z');

    await expect(saveInboxCursor(identity, '2026-10-04T11:00:00.000Z')).resolves.toBe('2026-10-04T11:00:00.000Z');
  });

  it('isolates cursors by identity key', async () => {
    await saveInboxCursor('identity-a', '2026-10-04T10:00:00.000Z');
    await saveInboxCursor('identity-b', '2026-10-04T11:00:00.000Z');

    await expect(loadInboxCursor('identity-a')).resolves.toBe('2026-10-04T10:00:00.000Z');
    await expect(loadInboxCursor('identity-b')).resolves.toBe('2026-10-04T11:00:00.000Z');
  });

  it('persists lastReadAt through saveContact and loadContacts without a version bump', async () => {
    const db = await openDatabase();
    expect(db.version).toBe(11);
    db.close();

    await saveContact({
      publicKey: 'read-state-key',
      fingerprint: 'read-state-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: false,
      lastReadAt: '2026-10-04T12:00:00.000Z'
    });

    await expect(loadContacts()).resolves.toContainEqual(expect.objectContaining({
      publicKey: 'read-state-key',
      lastReadAt: '2026-10-04T12:00:00.000Z'
    }));
  });

  it('persists a connection lastSeen timestamp across reloads', async () => {
    const lastSeen = '2026-10-27T12:00:00.000Z';
    await saveContact({
      publicKey: 'last-seen-key',
      fingerprint: 'last-seen-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: false,
      lastSeen
    });

    await expect(loadContacts()).resolves.toContainEqual(expect.objectContaining({
      publicKey: 'last-seen-key',
      fingerprint: 'last-seen-peer',
      lastSeen
    }));
  });

  it('persists and clears an authenticated peer Web Push capability with its contact', async () => {
    const contact = {
      publicKey: 'push-capability-key',
      fingerprint: 'push-capability-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: false,
      webPush: {
        endpoint: 'https://push.example.test/subscription/1',
        p256dh: 'public-key',
        auth: 'auth-secret'
      }
    };
    await saveContact(contact);

    await expect(loadContacts()).resolves.toContainEqual(expect.objectContaining({
      publicKey: contact.publicKey,
      webPush: contact.webPush
    }));

    await saveContact({ ...contact, webPush: undefined });
    const savedContact = (await loadContacts()).find(({ publicKey }) => publicKey === contact.publicKey);
    expect(savedContact?.webPush).toBeUndefined();
  });

  describe('profile metadata freshness persistence', () => {
    const fields = (displayName: string, follower = false) => ({
      authenticatedDisplayName: displayName,
      follower,
      webPush: undefined
    });

    it('allocates the first and successive positive metadata sequences', async () => {
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-origin-key',
        privateKey: 'private-key',
        metadataSequence: 0
      });

      await expect(nextLocalMetadataSequence()).resolves.toBe(1);
      await expect(nextLocalMetadataSequence()).resolves.toBe(2);
      await expect(readRecord(await openDatabase(), 'identity', 'local')).resolves.toMatchObject({
        metadataSequence: 2
      });
    });

    it('exports the latest persisted origin sequence rather than a stale in-memory identity snapshot', async () => {
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-export-origin-key',
        privateKey: 'private-key',
        id: 'metadata-export-fingerprint',
        encryptionPublicKey: 'encryption-public-key',
        encryptionPrivateKey: 'encryption-private-key',
        metadataSequence: 0
      });
      await nextLocalMetadataSequence();

      await expect(loadCurrentIdentityBackupFields(
        'metadata-export-origin-key',
        'metadata-export-fingerprint'
      )).resolves.toMatchObject({
        publicKey: 'metadata-export-origin-key',
        metadataSequence: 1
      });
      await expect(loadCurrentIdentityBackupFields(
        'different-identity',
        'metadata-export-fingerprint'
      )).rejects.toThrow('could not be verified');
    });

    it('serializes concurrent sequence allocations without reuse', async () => {
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-concurrent-origin-key',
        privateKey: 'private-key',
        metadataSequence: 0
      });

      const allocated = await Promise.all(
        Array.from({ length: 12 }, () => nextLocalMetadataSequence())
      );

      expect([...allocated].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 1)
      );
    });

    it('persists allocated sequences across database connections and failed caller work', async () => {
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-restart-origin-key',
        privateKey: 'private-key',
        metadataSequence: 0
      });

      const first = await nextLocalMetadataSequence();
      const db = await openDatabase();
      db.close();
      await expect((async () => {
        await nextLocalMetadataSequence();
        throw new Error('caller failed after allocation');
      })()).rejects.toThrow('caller failed');

      const second = await nextLocalMetadataSequence();
      expect(first).toBe(1);
      expect(second).toBe(3);
    });

    it('does not let saving a stale same-identity snapshot reuse an allocated sequence', async () => {
      const identity = {
        key: 'local',
        publicKey: 'metadata-stale-save-origin-key',
        privateKey: 'private-key',
        metadataSequence: 0
      };
      await saveIdentity(identity);
      await expect(nextLocalMetadataSequence()).resolves.toBe(1);

      await saveIdentity({ ...identity, privateKey: 'updated-private-key' });

      await expect(nextLocalMetadataSequence()).resolves.toBe(2);
    });

    it('preserves counters only for the same identity and includes the persisted counter in backup fields', async () => {
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-backup-origin-a',
        privateKey: 'private-a',
        metadataSequence: 6
      });
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-backup-origin-a',
        privateKey: 'updated-private-a',
        metadataSequence: 2
      });

      const savedSameIdentity = await readRecord<{
        metadataSequence: number;
        publicKey: string;
      }>(await openDatabase(), 'identity', 'local');
      expect(savedSameIdentity?.metadataSequence).toBe(6);
      expect(identityBackupFields({
        key: 'local',
        publicKey: savedSameIdentity?.publicKey ?? '',
        privateKey: 'private-key',
        encryptionPublicKey: 'encryption-public-key',
        encryptionPrivateKey: 'encryption-private-key',
        metadataSequence: savedSameIdentity?.metadataSequence
      }).metadataSequence).toBe(6);

      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-backup-origin-b',
        privateKey: 'private-b'
      });
      const replacedIdentity = await readRecord<{
        publicKey: string;
        metadataSequence?: number;
      }>(await openDatabase(), 'identity', 'local');
      expect(replacedIdentity?.publicKey).toBe('metadata-backup-origin-b');
      expect(replacedIdentity?.metadataSequence).toBeUndefined();
      await expect(nextLocalMetadataSequence()).rejects.toThrow();
    });

    it('allows a valid same-identity backup counter to recover malformed local counter state', async () => {
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-recover-origin-key',
        privateKey: 'private-key',
        metadataSequence: Number.NaN
      });

      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-recover-origin-key',
        privateKey: 'restored-private-key',
        metadataSequence: 11
      });

      await expect(nextLocalMetadataSequence()).resolves.toBe(12);
    });

    it('accepts legacy backups without a counter but rejects malformed backup counters', () => {
      expect(parseIdentityMetadataSequence(undefined)).toBeUndefined();
      expect(parseIdentityMetadataSequence(0)).toBe(0);
      expect(parseIdentityMetadataSequence(12)).toBe(12);
      for (const sequence of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => parseIdentityMetadataSequence(sequence)).toThrow('metadata sequence is invalid');
      }
    });

    it.each([
      ['missing', undefined],
      ['malformed', Number.NaN],
      ['negative', -1]
    ])('fails allocation for a %s counter without resetting it', async (label, metadataSequence) => {
      await saveIdentity({
        key: 'local',
        publicKey: `metadata-invalid-origin-${label}-key`,
        privateKey: 'private-key',
        metadataSequence
      });

      await expect(nextLocalMetadataSequence()).rejects.toThrow();
      await expect(readRecord(await openDatabase(), 'identity', 'local')).resolves.toMatchObject({ metadataSequence });
    });

    it('fails allocation rather than wrapping at the maximum safe integer', async () => {
      await saveIdentity({
        key: 'local',
        publicKey: 'metadata-overflow-origin-key',
        privateKey: 'private-key',
        metadataSequence: Number.MAX_SAFE_INTEGER
      });

      await expect(nextLocalMetadataSequence()).rejects.toThrow();
      await expect(readRecord(await openDatabase(), 'identity', 'local')).resolves.toMatchObject({
        metadataSequence: Number.MAX_SAFE_INTEGER
      });
    });

    it('accepts a first and higher sequence and atomically persists contact and high-water state', async () => {
      const first = await acceptPeerMetadata(
        'metadata-peer-key',
        'metadata-peer-fingerprint',
        1,
        fields('First', true)
      );
      expect(first).toMatchObject({
        status: 'accepted',
        highestSequence: 1,
        contact: {
          publicKey: 'metadata-peer-key',
          fingerprint: 'metadata-peer-fingerprint',
          authenticatedDisplayName: 'First',
          followed: false,
          follower: true,
          online: true,
          connected: true
        }
      });

      const later = await acceptPeerMetadata(
        'metadata-peer-key',
        'metadata-peer-fingerprint',
        4,
        fields('Latest')
      );
      expect(later).toMatchObject({ status: 'accepted', highestSequence: 4 });

      const db = await openDatabase();
      await expect(readRecord(db, 'contacts', 'metadata-peer-key')).resolves.toMatchObject({
        authenticatedDisplayName: 'Latest',
        follower: false
      });
      await expect(readRecord(db, PEER_METADATA_STATE_STORE, 'metadata-peer-key')).resolves.toEqual({
        publicKey: 'metadata-peer-key',
        fingerprint: 'metadata-peer-fingerprint',
        highestSequence: 4
      });
    });

    it('rejects duplicate and lower sequences without changing either record', async () => {
      await acceptPeerMetadata('metadata-stale-key', 'metadata-stale-fingerprint', 5, fields('Accepted'));
      const originalContact = (await loadContacts()).find(({ publicKey }) => publicKey === 'metadata-stale-key');
      const db = await openDatabase();
      const originalState = await readRecord(db, PEER_METADATA_STATE_STORE, 'metadata-stale-key');

      await expect(acceptPeerMetadata(
        'metadata-stale-key',
        'metadata-stale-fingerprint',
        5,
        fields('Duplicate', true)
      )).resolves.toEqual({ status: 'stale', highestSequence: 5 });
      await expect(acceptPeerMetadata(
        'metadata-stale-key',
        'metadata-stale-fingerprint',
        3,
        fields('Older', true)
      )).resolves.toEqual({ status: 'stale', highestSequence: 5 });

      await expect(readRecord(db, 'contacts', 'metadata-stale-key')).resolves.toEqual(originalContact);
      await expect(readRecord(db, PEER_METADATA_STATE_STORE, 'metadata-stale-key')).resolves.toEqual(originalState);
    });

    it('rejects a mismatched fingerprint for existing metadata state or contact', async () => {
      await acceptPeerMetadata('metadata-identity-key', 'trusted-fingerprint', 2, fields('Trusted'));

      await expect(acceptPeerMetadata(
        'metadata-identity-key',
        'other-fingerprint',
        3,
        fields('Mismatch')
      )).resolves.toEqual({ status: 'identity-mismatch' });

      const db = await openDatabase();
      await expect(readRecord(db, 'contacts', 'metadata-identity-key')).resolves.toMatchObject({
        fingerprint: 'trusted-fingerprint',
        authenticatedDisplayName: 'Trusted'
      });
      await expect(readRecord(db, PEER_METADATA_STATE_STORE, 'metadata-identity-key')).resolves.toMatchObject({
        fingerprint: 'trusted-fingerprint',
        highestSequence: 2
      });

      await saveContact({
        publicKey: 'metadata-contact-identity-key',
        fingerprint: 'existing-contact-fingerprint',
        addedAt: '2026-10-01T00:00:00.000Z',
        followed: true
      });
      await expect(acceptPeerMetadata(
        'metadata-contact-identity-key',
        'incoming-fingerprint',
        1,
        fields('Mismatch')
      )).resolves.toEqual({ status: 'identity-mismatch' });
      await expect(readRecord(db, PEER_METADATA_STATE_STORE, 'metadata-contact-identity-key')).resolves.toBeUndefined();
    });

    it('preserves unrelated contact fields while applying accepted metadata', async () => {
      await saveContact({
        publicKey: 'metadata-preserve-key',
        fingerprint: 'metadata-preserve-fingerprint',
        addedAt: '2026-10-01T00:00:00.000Z',
        followed: true,
        displayName: 'Local name',
        lastReadAt: '2026-10-04T12:00:00.000Z',
        webPush: {
          endpoint: 'https://push.example.test/current',
          p256dh: 'public-key',
          auth: 'auth'
        }
      });

      const result = await acceptPeerMetadata(
        'metadata-preserve-key',
        'metadata-preserve-fingerprint',
        1,
        fields('Authenticated name')
      );

      expect(result).toMatchObject({
        status: 'accepted',
        contact: {
          displayName: 'Local name',
          followed: true,
          lastReadAt: '2026-10-04T12:00:00.000Z',
          authenticatedDisplayName: 'Authenticated name'
        }
      });
    });

    it('only applies a verified encryption key against the contact read in the transaction', async () => {
      await saveContact({
        publicKey: 'metadata-encryption-key',
        fingerprint: 'metadata-encryption-fingerprint',
        addedAt: '2026-10-01T00:00:00.000Z',
        followed: false,
        encryptionPublicKey: 'previous-encryption-key'
      });

      const result = await acceptPeerMetadata(
        'metadata-encryption-key',
        'metadata-encryption-fingerprint',
        1,
        { ...fields('Authenticated name'), verifiedEncryptionPublicKey: 'new-encryption-key' }
      );

      expect(result).toMatchObject({
        status: 'accepted',
        contact: {
          encryptionPublicKey: 'previous-encryption-key',
          encryptionKeyChanged: true
        }
      });
    });

    it('rejects invalid sequences without writing state', async () => {
      for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
        await expect(acceptPeerMetadata(
          'metadata-invalid-sequence-key',
          'metadata-invalid-sequence-fingerprint',
          sequence,
          fields('Invalid')
        )).resolves.toEqual({ status: 'invalid-input' });
      }
      const db = await openDatabase();
      await expect(readRecord(db, PEER_METADATA_STATE_STORE, 'metadata-invalid-sequence-key')).resolves.toBeUndefined();
      await expect(readRecord(db, 'contacts', 'metadata-invalid-sequence-key')).resolves.toBeUndefined();
    });

    it('returns storage-failure instead of accepted when IndexedDB cannot be opened', async () => {
      const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        throw new Error('sensitive database failure');
      });

      await expect(acceptPeerMetadata(
        'metadata-storage-failure-key',
        'metadata-storage-failure-fingerprint',
        1,
        fields('Should not be accepted')
      )).resolves.toEqual({ status: 'storage-failure' });

      openSpy.mockRestore();
    });

    it('leaves high-water state through contact deletion and requires a higher revision on re-add', async () => {
      await acceptPeerMetadata('metadata-readd-key', 'metadata-readd-fingerprint', 7, fields('Before deletion'));
      await deleteContact('metadata-readd-key');

      await expect(acceptPeerMetadata(
        'metadata-readd-key',
        'metadata-readd-fingerprint',
        7,
        fields('Replayed')
      )).resolves.toEqual({ status: 'stale', highestSequence: 7 });

      await expect(acceptPeerMetadata(
        'metadata-readd-key',
        'metadata-readd-fingerprint',
        8,
        fields('After re-add')
      )).resolves.toMatchObject({
        status: 'accepted',
        contact: { authenticatedDisplayName: 'After re-add', followed: false }
      });
    });

    it('leaves the highest revision and matching fields after concurrent out-of-order acceptance', async () => {
      const results = await Promise.all([
        acceptPeerMetadata('metadata-concurrent-peer', 'metadata-concurrent-fingerprint', 2, fields('Revision 2')),
        acceptPeerMetadata('metadata-concurrent-peer', 'metadata-concurrent-fingerprint', 5, fields('Revision 5')),
        acceptPeerMetadata('metadata-concurrent-peer', 'metadata-concurrent-fingerprint', 3, fields('Revision 3'))
      ]);

      expect(results.filter((result) => result.status === 'accepted').length).toBeGreaterThanOrEqual(1);
      const db = await openDatabase();
      await expect(readRecord(db, PEER_METADATA_STATE_STORE, 'metadata-concurrent-peer')).resolves.toMatchObject({
        highestSequence: 5
      });
      await expect(readRecord(db, 'contacts', 'metadata-concurrent-peer')).resolves.toMatchObject({
        authenticatedDisplayName: 'Revision 5'
      });
    });
  });

  it('conditionally clears only the exact persisted capability and preserves other contact data', async () => {
    const capability = {
      endpoint: 'https://push.example.test/subscription/atomic',
      p256dh: 'public-key-a',
      auth: 'auth-a'
    };
    const contact = {
      publicKey: 'atomic-capability-key',
      fingerprint: 'atomic-capability-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: true,
      follower: true,
      displayName: 'Contact name',
      authenticatedDisplayName: 'Authenticated name',
      webPush: capability
    };
    await saveContact(contact);

    await expect(clearContactWebPushCapabilityIfMatches(
      contact.publicKey,
      contact.fingerprint,
      capability
    )).resolves.toEqual({ ...contact, webPush: undefined });
    await expect(loadContacts()).resolves.toContainEqual({ ...contact, webPush: undefined });
  });

  it.each([
    ['endpoint', { endpoint: 'https://push.example.test/subscription/new', p256dh: 'public-key-a', auth: 'auth-a' }],
    ['p256dh', { endpoint: 'https://push.example.test/subscription/atomic', p256dh: 'public-key-b', auth: 'auth-a' }],
    ['auth', { endpoint: 'https://push.example.test/subscription/atomic', p256dh: 'public-key-a', auth: 'auth-b' }]
  ] as const)('preserves a concurrently replaced capability when %s differs', async (_field, currentCapability) => {
    const oldCapability = {
      endpoint: 'https://push.example.test/subscription/atomic',
      p256dh: 'public-key-a',
      auth: 'auth-a'
    };
    const contact = {
      publicKey: 'replaced-capability-key',
      fingerprint: 'replaced-capability-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: false,
      webPush: currentCapability
    };
    await saveContact(contact);

    await expect(clearContactWebPushCapabilityIfMatches(
      contact.publicKey,
      contact.fingerprint,
      oldCapability
    )).resolves.toBeNull();
    await expect(loadContacts()).resolves.toContainEqual(contact);
  });

  it('does nothing when the contact no longer exists or its identity changed', async () => {
    const capability = {
      endpoint: 'https://push.example.test/subscription/deleted',
      p256dh: 'public-key',
      auth: 'auth'
    };
    await expect(clearContactWebPushCapabilityIfMatches(
      'deleted-capability-key',
      'deleted-capability-peer',
      capability
    )).resolves.toBeNull();

    const contact = {
      publicKey: 'identity-changed-key',
      fingerprint: 'new-fingerprint',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: false,
      webPush: capability
    };
    await saveContact(contact);
    await expect(clearContactWebPushCapabilityIfMatches(
      contact.publicKey,
      'old-fingerprint',
      capability
    )).resolves.toBeNull();
    await expect(loadContacts()).resolves.toContainEqual(contact);
  });

  it('serializes concurrent invalidations without overwriting the contact', async () => {
    const capability = {
      endpoint: 'https://push.example.test/subscription/concurrent',
      p256dh: 'public-key',
      auth: 'auth'
    };
    const contact = {
      publicKey: 'concurrent-capability-key',
      fingerprint: 'concurrent-capability-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: true,
      webPush: capability
    };
    await saveContact(contact);

    const results = await Promise.all([
      clearContactWebPushCapabilityIfMatches(contact.publicKey, contact.fingerprint, capability),
      clearContactWebPushCapabilityIfMatches(contact.publicKey, contact.fingerprint, capability)
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(loadContacts()).resolves.toContainEqual({ ...contact, webPush: undefined });
  });

  it('preserves a newer authenticated capability written while the old dispatch is in flight', async () => {
    const oldCapability = {
      endpoint: 'https://push.example.test/subscription/old',
      p256dh: 'old-public-key',
      auth: 'old-auth'
    };
    const newCapability = {
      endpoint: 'https://push.example.test/subscription/new',
      p256dh: 'new-public-key',
      auth: 'new-auth'
    };
    const contact = {
      publicKey: 'in-flight-capability-key',
      fingerprint: 'in-flight-capability-peer',
      addedAt: '2026-10-01T00:00:00.000Z',
      followed: true,
      webPush: oldCapability
    };
    await saveContact(contact);

    await saveContact({ ...contact, webPush: newCapability });
    await expect(clearContactWebPushCapabilityIfMatches(
      contact.publicKey,
      contact.fingerprint,
      oldCapability
    )).resolves.toBeNull();
    await expect(loadContacts()).resolves.toContainEqual({ ...contact, webPush: newCapability });
  });

  it('rejects a non-ISO or unparseable cursor', async () => {
    await expect(saveInboxCursor('invalid-cursor-identity', 'not-a-date')).rejects.toThrow('ISO timestamp');
    await expect(saveInboxCursor('invalid-calendar-identity', '2026-02-30T10:00:00.000Z')).rejects.toThrow('ISO timestamp');
  });

  it('rejects an empty identity key for reads and writes', async () => {
    await expect(loadInboxCursor('')).rejects.toThrow('identity key');
    await expect(saveInboxCursor('   ', '2026-10-04T10:00:00.000Z')).rejects.toThrow('identity key');
  });

  it('clearAllLocalData clears remaining local stores', async () => {
    const db = await openDatabase();
    const tx = db.transaction([
      ...PRESERVED_STORES,
      'feed_cursors',
      'peer_connection_observations',
      'find_forwarding_observations',
      'object_supply_observations',
      PEER_CANDIDATE_STORE
    ], 'readwrite');
    tx.objectStore('identity').put({ key: 'local', publicKey: 'key' });
    tx.objectStore('contacts').put({ publicKey: 'contact' });
    tx.objectStore('profiles').put({ author: 'author' });
    tx.objectStore('discovery_interactions').put({ id: 'interaction' });
    tx.objectStore('inbox_cursors').put({ identity: 'clear-me', cursor: '2026-10-04T10:00:00.000Z' });
    tx.objectStore('feed_cursors').put({
      key: 'clear-identity|clear-peer',
      created_at: '2026-10-04T10:00:00.000Z',
      object_id: 'a'.repeat(64),
      updated_at: '2026-10-04T10:00:00.000Z'
    });
    tx.objectStore(PEER_CANDIDATE_STORE).put({ peerId: 'clear-candidate' });
    tx.objectStore(PEER_METADATA_STATE_STORE).put({
      publicKey: 'clear-metadata-peer',
      fingerprint: 'clear-metadata-fingerprint',
      highestSequence: 9
    });
    for (const storeName of [
      'peer_connection_observations',
      'find_forwarding_observations',
      'object_supply_observations'
    ]) {
      tx.objectStore(storeName).put({
        id: 'clear-me',
        updated_at: '2026-10-04T10:00:00.000Z',
        expires_at: '2026-11-04T10:00:00.000Z'
      });
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await clearAllLocalData();

    await expect(loadInboxCursor('clear-me')).resolves.toBeNull();
    const clearedDb = await openDatabase();
    await expect(readRecord(clearedDb, 'identity', 'local')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'contacts', 'contact')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'profiles', 'author')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'discovery_interactions', 'interaction')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, 'feed_cursors', 'clear-identity|clear-peer')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, PEER_CANDIDATE_STORE, 'clear-candidate')).resolves.toBeUndefined();
    await expect(readRecord(clearedDb, PEER_METADATA_STATE_STORE, 'clear-metadata-peer')).resolves.toBeUndefined();
    for (const storeName of [
      'peer_connection_observations',
      'find_forwarding_observations',
      'object_supply_observations',
      PEER_CANDIDATE_STORE
    ]) {
      await expect(readRecord(clearedDb, storeName, 'clear-me')).resolves.toBeUndefined();
    }
    clearedDb.close();
  });

  it('closes on versionchange and opens a fresh connection on the next call', async () => {
    await deleteDatabase();
    const first = await openDatabase();
    const close = vi.spyOn(first, 'close');

    first.onversionchange?.(new IDBVersionChangeEvent('versionchange', {
      oldVersion: 8,
      newVersion: 10
    }));

    expect(close).toHaveBeenCalledOnce();
    expect(() => first.transaction('contacts', 'readonly')).toThrow();
    const reopened = await openDatabase();
    expect(reopened.version).toBe(11);
    reopened.close();
  });

  it('completes an upgrade after a stale older-version connection closes', async () => {
    await deleteDatabase();
    await seedDatabase(6);
    const staleConnection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 6);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upgrade = openDatabase();

    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
      'IndexedDB upgrade is blocked by another open connection.'
    ));
    staleConnection.close();
    const upgraded = await upgrade;

    expect(upgraded.version).toBe(11);
    expect(upgraded.objectStoreNames.contains('inbox_cursors')).toBe(true);
    upgraded.close();
    warning.mockRestore();
  });
});
