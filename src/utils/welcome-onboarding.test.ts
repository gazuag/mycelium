import { describe, expect, it } from 'vitest';
import {
  completeWelcomeOnboarding,
  prepareWelcomeOnboarding,
  WELCOME_ONBOARDING_STATUS_KEY
} from './welcome-onboarding';

function createStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

describe('welcome onboarding persistence', () => {
  it('marks a newly created identity welcome as pending and restores it on startup', () => {
    const storage = createStorage();

    expect(prepareWelcomeOnboarding(storage, true)).toBe(true);
    expect(storage.getItem(WELCOME_ONBOARDING_STATUS_KEY)).toBe('pending');
    expect(prepareWelcomeOnboarding(storage, false)).toBe(true);
  });

  it('does not show the welcome again after completion', () => {
    const storage = createStorage();
    prepareWelcomeOnboarding(storage, true);

    completeWelcomeOnboarding(storage);

    expect(storage.getItem(WELCOME_ONBOARDING_STATUS_KEY)).toBe('completed');
    expect(prepareWelcomeOnboarding(storage, false)).toBe(false);
  });

  it('does not show the welcome for an existing identity without a pending welcome', () => {
    expect(prepareWelcomeOnboarding(createStorage(), false)).toBe(false);
  });
});
