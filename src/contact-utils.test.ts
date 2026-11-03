import { describe, expect, it } from 'vitest';
import { contactWithIdentityProfile, dedupeContactsByFingerprint } from './contact-utils';
import type { IdentityObject } from './object-layer/identity-object';
import type { Contact } from './types';

function contact(lastReadAt?: string): Contact {
  return {
    publicKey: 'contact-key',
    fingerprint: 'peer-id',
    addedAt: '2026-10-01T00:00:00.000Z',
    followed: false,
    lastReadAt
  };
}

describe('contact unread read-state merging', () => {
  it('preserves the newest lastReadAt when App deduplicates contacts', () => {
    const merged = dedupeContactsByFingerprint([
      contact('2026-10-04T12:00:00.000Z'),
      { ...contact(), displayName: 'Merged contact' }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      displayName: 'Merged contact',
      lastReadAt: '2026-10-04T12:00:00.000Z'
    });
  });
});

describe('identity profile contact updates', () => {
  it('does not make a retrieved profile a followed or trusted relationship', () => {
    const profile: IdentityObject = {
      object_id: 'profile-id',
      object_type: 'mycelium.identity',
      author: 'signing-key',
      created_at: '2026-10-01T00:00:00.000Z',
      payload: {
        display_name: 'Retrieved name',
        bio: '',
        encryption_public_key: 'encryption-key',
        encryption_key_binding: {
          signing_public_key: 'signing-key',
          encryption_public_key: 'encryption-key',
          created_at: '2026-10-01T00:00:00.000Z',
          signature: 'signature'
        }
      },
      signature: 'signature',
      replication_policy: {}
    };
    const updated = contactWithIdentityProfile(undefined, profile, 'peer-id');

    expect(updated).toMatchObject({
      fingerprint: 'peer-id',
      displayName: 'Retrieved name',
      followed: false
    });
    expect(updated).not.toHaveProperty('trusted');
  });
});
