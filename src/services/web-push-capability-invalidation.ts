import type { WebPushCapability } from '../types';
import type { WebPushDispatchResult } from './web-push-dispatch';

export type InvalidateWebPushCapability = (
  publicKey: string,
  fingerprint: string,
  capability: WebPushCapability
) => Promise<void>;

export async function invalidateWebPushCapabilityAfterDispatch(
  result: WebPushDispatchResult,
  publicKey: string,
  fingerprint: string,
  capability: WebPushCapability,
  invalidate?: InvalidateWebPushCapability
): Promise<void> {
  if (result.status !== 'invalid-subscription' || !invalidate) return;
  try {
    await invalidate(publicKey, fingerprint, capability);
  } catch {
    console.warn('Failed to invalidate unusable Web Push capability');
  }
}
