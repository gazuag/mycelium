import { describe, expect, it } from 'vitest';
import { dedupeContactsByFingerprint } from './contact-utils';
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
