export const WELCOME_ONBOARDING_STATUS_KEY = 'myceliumWelcomeOnboardingStatus';

type WelcomeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function prepareWelcomeOnboarding(storage: WelcomeStorage, identityWasCreated: boolean): boolean {
  if (identityWasCreated) {
    storage.setItem(WELCOME_ONBOARDING_STATUS_KEY, 'pending');
    return true;
  }
  return storage.getItem(WELCOME_ONBOARDING_STATUS_KEY) === 'pending';
}

export function completeWelcomeOnboarding(storage: WelcomeStorage): void {
  storage.setItem(WELCOME_ONBOARDING_STATUS_KEY, 'completed');
}
