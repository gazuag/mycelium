import type { DistributedObject } from '../object-layer/types';
import type { WebPushCapability } from '../types';
import { isWebPushCapability } from './web-push';
import { encryptWebPushPayload, type EncryptedWebPushRequest } from './web-push-encryption';
import {
  sendEncryptedWebPush,
  type WebPushSendResult
} from './web-push-sender';
import { WEB_PUSH_ENVELOPE_MAX_BYTES } from './web-push-inbox';

const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export type WebPushDispatchResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'invalid-subscription' }
  | { readonly status: 'rate-limited' }
  | { readonly status: 'temporary-failure' }
  | { readonly status: 'delivery-unknown' }
  | { readonly status: 'rejected' }
  | {
    readonly status: 'skipped';
    readonly reason: 'invalid-object' | 'invalid-capability' | 'configuration-missing' | 'identity-unavailable';
  };

export interface WebPushDispatchDependencies {
  readonly encrypt: (
    payload: string,
    capability: WebPushCapability
  ) => Promise<EncryptedWebPushRequest>;
  readonly send: (
    encrypted: EncryptedWebPushRequest,
    capability: WebPushCapability
  ) => Promise<WebPushSendResult>;
}

export function createWebPushDispatcher(dependencies: WebPushDispatchDependencies) {
  return async (
    object: DistributedObject,
    capability: WebPushCapability
  ): Promise<WebPushDispatchResult> => {
    if (!object || typeof object !== 'object' || !OBJECT_ID_PATTERN.test(object.object_id)) {
      return { status: 'skipped', reason: 'invalid-object' };
    }
    if (!isWebPushCapability(capability)) {
      return { status: 'skipped', reason: 'invalid-capability' };
    }

    const inlineEnvelope = JSON.stringify({ version: 1, type: 'object', object });
    const envelope = encoder.encode(inlineEnvelope).byteLength <= WEB_PUSH_ENVELOPE_MAX_BYTES
      ? inlineEnvelope
      : JSON.stringify({ version: 1, type: 'reference', object_id: object.object_id });

    let encrypted: EncryptedWebPushRequest;
    try {
      encrypted = await dependencies.encrypt(envelope, capability);
    } catch (error) {
      if (error instanceof TypeError) return { status: 'skipped', reason: 'invalid-capability' };
      throw error;
    }

    return mapSendResult(await dependencies.send(encrypted, capability));
  };
}

export const dispatchWebPushObject = createWebPushDispatcher({
  encrypt: encryptWebPushPayload,
  send: sendEncryptedWebPush
});

function mapSendResult(result: WebPushSendResult): WebPushDispatchResult {
  switch (result.status) {
    case 'accepted':
    case 'invalid-subscription':
    case 'rate-limited':
    case 'temporary-failure':
    case 'delivery-unknown':
      return result;
    case 'request-rejected':
      return { status: 'rejected' };
    case 'invalid-capability':
      return { status: 'skipped', reason: 'invalid-capability' };
    case 'configuration-missing':
      return { status: 'skipped', reason: 'configuration-missing' };
    case 'identity-unavailable':
      return { status: 'skipped', reason: 'identity-unavailable' };
  }
}
