/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E_TEST_API?: string;
}

interface MyceliumE2ETestAPI {
  state(): {
    identityId: string;
    connectedPeers: string[];
    signallingStatus: string;
    followingPeerIds: string[];
    contacts: Array<{ peerId: string; followed: boolean; follower: boolean }>;
    logs: string[];
  };
  connectPeer(peerId: string): Promise<void>;
  disconnectPeer(peerId: string): boolean;
  sendAuthenticatedProfile(peerId: string): Promise<void>;
  discoverConnectedPeerProfiles(): Promise<{
    discoveredPeerIds: string[];
    connectedPeerIds: string[];
    activeAttemptPeerIds: string[];
  }>;
  followPeer(peerId: string, followed: boolean): Promise<void>;
  identityProfiles(): Promise<Array<{ peerId: string; author: string; objectId: string }>>;
  findIdentityProfiles(peerId: string, authorConnected?: boolean, ttl?: number): Promise<{
    responderPeerId: string;
    requestId: string;
    authors: string[];
  }>;
  findObjectsByQuery(peerId: string, objectType: string, authorConnected?: boolean, ttl?: number): Promise<{
    responderPeerId: string;
    requestId: string;
    authors: string[];
  }>;
  findObject(objectId: string, peerId: string): Promise<{ found: boolean; objectId?: string; requestId: string }>;
  createLocalTestPost(content: string): Promise<string>;
  objectIdForPost(content: string): Promise<string | null>;
  deleteObject(objectId: string): Promise<void>;
  sendObject(objectId: string, peerId: string): Promise<void>;
  sendInvalidObject(objectId: string, peerId: string): Promise<void>;
}

interface Window {
  __MYCELIUM_E2E__?: MyceliumE2ETestAPI;
}

declare module 'virtual:mycelium-username-vocabulary' {
  export const adjectives: readonly string[];
  export const singularNouns: readonly string[];
  export const pluralNouns: readonly string[];
  export const verbs: readonly string[];
}
