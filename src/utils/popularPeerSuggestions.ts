export const popularPeerSuggestionsStorageKey = 'popularPeerSuggestionsState';

export type PopularPeerSuggestionsState =
  | 'active'
  | 'waiting'
  | 'dismissed'
  | 'dismissed-following';

export function getInitialPopularPeerSuggestionsState(
  storedState: string | null,
  contactsLoaded: boolean,
  followedCount: number
): PopularPeerSuggestionsState {
  if (storedState === 'active') return 'active';

  if (storedState === 'dismissed' || storedState === 'true') {
    if (!contactsLoaded || followedCount === 0) return 'dismissed';
    return 'dismissed-following';
  }

  if (storedState === 'dismissed-following') {
    if (contactsLoaded && followedCount === 0) return 'active';
    return 'dismissed-following';
  }

  if (storedState === 'waiting') {
    return contactsLoaded && followedCount === 0 ? 'active' : 'waiting';
  }

  if (!contactsLoaded) return 'waiting';
  return followedCount === 0 ? 'active' : 'waiting';
}

export function advancePopularPeerSuggestionsState(
  state: PopularPeerSuggestionsState,
  contactsLoaded: boolean,
  followedCount: number,
  allSuggestedPeersFollowed: boolean
): PopularPeerSuggestionsState {
  if (!contactsLoaded) return state;

  if (state === 'waiting') {
    return followedCount === 0 ? 'active' : 'waiting';
  }

  if (state === 'active') {
    return allSuggestedPeersFollowed
      ? followedCount === 0 ? 'dismissed' : 'dismissed-following'
      : 'active';
  }

  if (state === 'dismissed') {
    return followedCount > 0 ? 'dismissed-following' : 'dismissed';
  }

  return followedCount === 0 ? 'active' : 'dismissed-following';
}

export function dismissPopularPeerSuggestions(
  followedCount: number
): PopularPeerSuggestionsState {
  return followedCount > 0 ? 'dismissed-following' : 'dismissed';
}
