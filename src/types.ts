import type { EncryptionKeyBinding } from './crypto/dm-crypto';

export type ConnectionState = 'idle' | 'signalling' | 'connecting' | 'connected' | 'disconnected';

export interface Contact {
  publicKey: string;
  fingerprint: string;
  displayName?: string;
  profile?: SignedProfile;
  addedAt: string;
  followed: boolean;
  follower?: boolean;
  online?: boolean;
  connected?: boolean;
  lastConnectionStatus?: string;
  lastSeen?: string;
  lastReadAt?: string;
  encryptionPublicKey?: string;
  encryptionKeyChanged?: boolean;
  webPush?: WebPushCapability;
}

export interface WebPushCapability {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PeerMetadata {
  author: string;
  publicKey?: string;
  displayName: string;
  following: boolean;
  timestamp: string;
  bio?: string;
  tags?: string[];
  encryptionKeyBinding?: EncryptionKeyBinding;
  webPush?: WebPushCapability;
}

export interface SignedProfile {
  protocol: 'mycelium';
  version: 1;
  type: 'profile';
  id: string;
  author: string;
  timestamp: string;
  displayName?: string;
  bio?: string;
  tags?: string[];
  signature: string;
}
