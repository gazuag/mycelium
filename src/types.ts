export type ConnectionState = 'idle' | 'signalling' | 'connecting' | 'connected' | 'disconnected';

export type FeedSource = 'local' | 'peer' | 'discovery';

export interface Contact {
  publicKey: string;
  fingerprint: string;
  displayName?: string;
  profile?: SignedProfile;
  addedAt: string;
  followed: boolean;
  online?: boolean;
  connected?: boolean;
  lastConnectionStatus?: string;
  lastSeen?: string;
  unreadMessages?: number;
}

export interface SignedPost {
  protocol: 'mycelium';
  version: 1;
  type: 'post';
  id: string;
  author: string;
  timestamp: string;
  content: string;
  tags: string[];
  reaction?: 'like' | 'dislike';
  repostOf?: string;
  originalAuthor?: string;
  signature: string;
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

export interface StoredPost extends SignedPost {
  source: FeedSource;
  receivedAt: string;
  valid?: boolean;
  saved?: boolean;
  liked?: boolean;
  disliked?: boolean;
  notInterested?: boolean;
  seen?: boolean;
  authorDisplayName?: string;
}
