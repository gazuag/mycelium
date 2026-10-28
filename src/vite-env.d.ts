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
    logs: string[];
  };
  connectPeer(peerId: string): Promise<void>;
  followPeer(peerId: string, followed: boolean): Promise<void>;
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
