import { signString, signStringWithKey, verifySignedString } from '../crypto/identity';
import type { ObjectIdentity } from './types';

interface ExistingIdentityFields {
  readonly id: string;
  readonly publicKey: string;
}

export type ExistingIdentity = ExistingIdentityFields & (
  | { readonly privateKey: string; readonly signingKey?: never }
  | { readonly privateKey?: never; readonly signingKey: CryptoKey }
);

export function createObjectIdentity(identity: ExistingIdentity): ObjectIdentity {
  return {
    nodeId: identity.id,
    publicKey: identity.publicKey,
    sign: (data) => typeof identity.privateKey === 'string'
      ? signString(identity.privateKey, data)
      : signStringWithKey(identity.signingKey, data),
    verify: (publicKey, data, signature) => verifySignedString(publicKey, data, signature)
  };
}