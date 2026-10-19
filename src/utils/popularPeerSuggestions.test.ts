import { describe, expect, it } from 'vitest';
import {
  advancePopularPeerSuggestionsState,
  dismissPopularPeerSuggestions,
  getInitialPopularPeerSuggestionsState
} from './popularPeerSuggestions';

describe('popular peer suggestion lifecycle', () => {
  it('keeps an active banner visible while only some suggested peers are followed', () => {
    const state = getInitialPopularPeerSuggestionsState('active', true, 0);

    expect(advancePopularPeerSuggestionsState(state, true, 1, false)).toBe('active');
    expect(getInitialPopularPeerSuggestionsState('active', true, 1)).toBe('active');
  });

  it('hides and persists the banner when every suggested peer is followed', () => {
    const state = advancePopularPeerSuggestionsState('active', true, 2, true);

    expect(state).toBe('dismissed-following');
    expect(getInitialPopularPeerSuggestionsState(state, true, 2)).toBe('dismissed-following');
  });

  it('keeps an X dismissal after refresh until followed peers return to zero', () => {
    const dismissed = dismissPopularPeerSuggestions(0);

    expect(getInitialPopularPeerSuggestionsState(dismissed, true, 0)).toBe('dismissed');
    const following = advancePopularPeerSuggestionsState(dismissed, true, 1, false);
    expect(following).toBe('dismissed-following');
    expect(advancePopularPeerSuggestionsState(following, true, 0, false)).toBe('active');
  });

  it('waits for all peers to be unfollowed before starting a new cycle', () => {
    const initialState = getInitialPopularPeerSuggestionsState(null, true, 2);

    expect(initialState).toBe('waiting');
    expect(advancePopularPeerSuggestionsState(initialState, true, 1, false)).toBe('waiting');
    expect(advancePopularPeerSuggestionsState(initialState, true, 0, false)).toBe('active');
  });
});
