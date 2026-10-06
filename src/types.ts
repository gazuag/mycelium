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
  unreadMessages?: number;
  encryptionPublicKey?: string;
  encryptionKeyChanged?: boolean;
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
