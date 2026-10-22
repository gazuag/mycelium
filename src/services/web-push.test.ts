import { describe, expect, it, vi } from 'vitest';
import { createWebPushManager, WEB_PUSH_ENABLED_STORAGE_KEY } from './web-push';

function createHarness({
  supported = true,
  permission = 'granted' as NotificationPermission,
  subscription = null as PushSubscription | null,
  applicationServerKey = 'AQIDBA'
} = {}) {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key))
  };
  let currentPermission = permission;
  const unsubscribe = vi.fn(async () => {
    subscription = null;
    return true;
  });
  const currentSubscription = () => subscription;
  const subscribe = vi.fn(async (_options: PushSubscriptionOptionsInit) => {
    subscription = { unsubscribe } as unknown as PushSubscription;
    return subscription;
  });
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => currentSubscription()),
      subscribe
    }
  } as unknown as ServiceWorkerRegistration;
  const requestPermission = vi.fn(async () => {
    currentPermission = 'granted';
    return currentPermission;
  });
  const getRegistration = vi.fn(async () => registration);
  const register = vi.fn(async () => registration);
  const manager = createWebPushManager({
    supported,
    applicationServerKey,
    storage,
    getPermission: () => currentPermission,
    requestPermission,
    getRegistration,
    register
  });

  return {
    manager,
    values,
    storage,
    registration,
    subscribe,
    unsubscribe,
    setSubscription: (value: PushSubscription | null) => { subscription = value; },
    requestPermission,
    getRegistration,
    register
  };
}

describe('Web Push subscription management', () => {
  it('reports unsupported Push API without touching storage or requesting permission', async () => {
    const harness = createHarness({ supported: false });

    await expect(harness.manager.getStatus()).resolves.toEqual({
      state: 'unsupported',
      subscribed: false
    });
    await expect(harness.manager.enable()).rejects.toThrow('not supported');
    expect(harness.requestPermission).not.toHaveBeenCalled();
  });

  it('does not request permission again after the browser denied it', async () => {
    const harness = createHarness({ permission: 'denied' });

    await expect(harness.manager.getStatus()).resolves.toMatchObject({ state: 'permission-denied' });
    await expect(harness.manager.enable()).rejects.toThrow('blocked in browser settings');
    expect(harness.requestPermission).not.toHaveBeenCalled();
    expect(harness.storage.setItem).not.toHaveBeenCalled();
  });

  it('enables after permission and a successful PushManager subscription', async () => {
    const harness = createHarness();

    await expect(harness.manager.enable()).resolves.toEqual({
      state: 'enabled',
      subscribed: true
    });
    expect(harness.requestPermission).not.toHaveBeenCalled();
    const subscribeOptions = harness.subscribe.mock.calls[0]?.[0];
    expect(subscribeOptions?.userVisibleOnly).toBe(true);
    expect(Array.from(new Uint8Array(subscribeOptions?.applicationServerKey as ArrayBuffer))).toEqual([1, 2, 3, 4]);
    expect(harness.values.get(WEB_PUSH_ENABLED_STORAGE_KEY)).toBe('true');
  });

  it('requests permission only when enabling after an explicit user action', async () => {
    const harness = createHarness({ permission: 'default' });
    const beforeEnable = await harness.manager.getStatus();

    expect(beforeEnable.state).toBe('permission-not-granted');
    expect(harness.requestPermission).not.toHaveBeenCalled();
    await harness.manager.enable();
    expect(harness.requestPermission).toHaveBeenCalledOnce();
  });

  it('detects and reuses an existing browser subscription', async () => {
    const harness = createHarness({ subscription: { unsubscribe: vi.fn() } as unknown as PushSubscription });

    await expect(harness.manager.getStatus()).resolves.toEqual({
      state: 'disabled',
      subscribed: true
    });
    await harness.manager.enable();
    expect(harness.subscribe).not.toHaveBeenCalled();
    expect(harness.values.get(WEB_PUSH_ENABLED_STORAGE_KEY)).toBe('true');
  });

  it('unsubscribes and clears the local enabled preference', async () => {
    const harness = createHarness();
    await harness.manager.enable();

    await harness.manager.disable();

    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.values.has(WEB_PUSH_ENABLED_STORAGE_KEY)).toBe(false);
  });

  it('does not persist enabled state when subscription creation fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.subscribe).mockRejectedValueOnce(new Error('subscription failed'));

    await expect(harness.manager.enable()).rejects.toThrow('subscription failed');
    expect(harness.values.has(WEB_PUSH_ENABLED_STORAGE_KEY)).toBe(false);
  });

  it('reports an enabled preference whose browser subscription has disappeared', async () => {
    const harness = createHarness();
    harness.values.set(WEB_PUSH_ENABLED_STORAGE_KEY, 'true');

    await expect(harness.manager.getStatus()).resolves.toEqual({
      state: 'subscription-unavailable',
      subscribed: false
    });
  });

  it('publishes only the current enabled, configured browser subscription', async () => {
    const harness = createHarness();
    const subscription = {
      endpoint: 'https://push.example.test/subscription/one',
      toJSON: () => ({
        endpoint: 'https://push.example.test/subscription/one',
        keys: { p256dh: 'public-key', auth: 'auth-secret' }
      })
    } as unknown as PushSubscription;
    harness.setSubscription(subscription);
    harness.values.set(WEB_PUSH_ENABLED_STORAGE_KEY, 'true');

    await expect(harness.manager.getPublishedCapability()).resolves.toEqual({
      endpoint: 'https://push.example.test/subscription/one',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });

    harness.values.delete(WEB_PUSH_ENABLED_STORAGE_KEY);
    await expect(harness.manager.getPublishedCapability()).resolves.toBeNull();
  });

  it('omits unavailable or malformed subscriptions and reads replacements afresh', async () => {
    const harness = createHarness();
    harness.values.set(WEB_PUSH_ENABLED_STORAGE_KEY, 'true');

    await expect(harness.manager.getPublishedCapability()).resolves.toBeNull();

    harness.setSubscription({
      endpoint: 'https://push.example.test/subscription/old',
      toJSON: () => ({
        endpoint: 'https://push.example.test/subscription/old',
        keys: { p256dh: 'old-key', auth: 'old-auth' }
      })
    } as unknown as PushSubscription);
    await expect(harness.manager.getPublishedCapability()).resolves.toMatchObject({
      endpoint: 'https://push.example.test/subscription/old'
    });

    harness.setSubscription({
      endpoint: 'https://push.example.test/subscription/new',
      toJSON: () => ({
        endpoint: 'https://push.example.test/subscription/new',
        keys: { p256dh: 'new-key', auth: 'new-auth' }
      })
    } as unknown as PushSubscription);
    await expect(harness.manager.getPublishedCapability()).resolves.toEqual({
      endpoint: 'https://push.example.test/subscription/new',
      p256dh: 'new-key',
      auth: 'new-auth'
    });
  });
});
