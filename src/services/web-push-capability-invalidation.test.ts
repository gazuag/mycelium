import { describe, expect, it, vi } from 'vitest';
import type { WebPushCapability } from '../types';
import type { WebPushDispatchResult } from './web-push-dispatch';
import { invalidateWebPushCapabilityAfterDispatch } from './web-push-capability-invalidation';

const capability: WebPushCapability = {
  endpoint: 'https://push.example.test/subscription',
  p256dh: 'public-key',
  auth: 'auth-secret'
};

describe('invalid Web Push capability cleanup', () => {
  it('conditionally invalidates only the capability used for an invalid-subscription result', async () => {
    const invalidate = vi.fn(async () => {});

    await invalidateWebPushCapabilityAfterDispatch(
      { status: 'invalid-subscription' },
      'recipient-key',
      'recipient-fingerprint',
      capability,
      invalidate
    );

    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(
      'recipient-key',
      'recipient-fingerprint',
      capability
    );
  });

  it.each([
    { status: 'accepted' },
    { status: 'rate-limited' },
    { status: 'temporary-failure' },
    { status: 'delivery-unknown' },
    { status: 'rejected' },
    { status: 'skipped', reason: 'invalid-capability' }
  ] as const satisfies readonly WebPushDispatchResult[])(
    'does not invalidate for a $status result',
    async (result) => {
      const invalidate = vi.fn(async () => {});

      await invalidateWebPushCapabilityAfterDispatch(
        result,
        'recipient-key',
        'recipient-fingerprint',
        capability,
        invalidate
      );

      expect(invalidate).not.toHaveBeenCalled();
    }
  );

  it('isolates persistence failures and logs only a generic warning', async () => {
    const invalidate = vi.fn(async () => {
      throw new Error('sensitive storage detail');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(invalidateWebPushCapabilityAfterDispatch(
      { status: 'invalid-subscription' },
      'recipient-key',
      'recipient-fingerprint',
      capability,
      invalidate
    )).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Failed to invalidate unusable Web Push capability');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive storage detail');
  });
});
