import { signString, verifySignedString } from '../crypto/identity';
import type { ObjectIdentity } from './types';

export interface ExistingIdentity {
  readonly id: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export function createObjectIdentity(identity: ExistingIdentity): ObjectIdentity {
  return {
    nodeId: identity.id,
    publicKey: identity.publicKey,
    sign: (data) => signString(identity.privateKey, data),
    verify: (publicKey, data, signature) => verifySignedString(publicKey, data, signature)
  };
}