export interface AuthenticatedPeerAuthorEntry<TManager> {
  readonly manager: TManager;
  readonly publicKey: string;
}

export type AuthenticatedPeerAuthorMap<TManager> = Map<string, AuthenticatedPeerAuthorEntry<TManager>>;

export function recordAuthenticatedPeerAuthor<TManager>(
  authors: AuthenticatedPeerAuthorMap<TManager>,
  peerId: string,
  manager: TManager,
  publicKey: string
) {
  authors.set(peerId, { manager, publicKey });
}

export function removeAuthenticatedPeerAuthor<TManager>(
  authors: AuthenticatedPeerAuthorMap<TManager>,
  peerId: string,
  manager: TManager
) {
  if (authors.get(peerId)?.manager !== manager) return false;
  return authors.delete(peerId);
}

export function getAuthenticatedConnectedAuthors<TManager extends { isDataChannelOpen(): boolean }>(
  authors: AuthenticatedPeerAuthorMap<TManager>,
  peerManagers: Readonly<Record<string, TManager>>,
  authenticatedManagers: Pick<WeakSet<TManager>, 'has'>
) {
  const connectedAuthors = new Set<string>();
  for (const [peerId, entry] of authors) {
    if (peerManagers[peerId] !== entry.manager
      || !authenticatedManagers.has(entry.manager)
      || !entry.manager.isDataChannelOpen()) continue;
    connectedAuthors.add(entry.publicKey);
  }
  return connectedAuthors;
}
