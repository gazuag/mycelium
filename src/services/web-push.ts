export const WEB_PUSH_ENABLED_STORAGE_KEY = 'mycelium:web-push-enabled';
const SERVICE_WORKER_URL = '/service-worker.js';
const APPLICATION_SERVER_KEY = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY as string | undefined;

export type WebPushState =
  | 'unsupported'
  | 'configuration-missing'
  | 'disabled'
  | 'permission-not-granted'
  | 'permission-denied'
  | 'enabled'
  | 'subscription-unavailable';

export interface WebPushStatus {
  readonly state: WebPushState;
  readonly subscribed: boolean;
}

interface WebPushPlatform {
  readonly supported: boolean;
  readonly applicationServerKey?: string;
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  getPermission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  getRegistration(): Promise<ServiceWorkerRegistration | null>;
  register(): Promise<ServiceWorkerRegistration | null>;
}

export interface WebPushManager {
  getStatus(): Promise<WebPushStatus>;
  enable(): Promise<WebPushStatus>;
  disable(): Promise<void>;
}

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export function registerMyceliumServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!registrationPromise) {
    const serviceWorker = navigator.serviceWorker;
    registrationPromise = Promise.resolve()
      .then(() => serviceWorker.register(SERVICE_WORKER_URL))
      .catch((error: unknown) => {
        console.warn('Mycelium service worker registration failed:', error);
        return null;
      })
      .then((registration) => {
        if (!registration) registrationPromise = null;
        return registration;
      });
  }
  return registrationPromise;
}

export function createWebPushManager(platform: WebPushPlatform): WebPushManager {
  const getStatus = async (): Promise<WebPushStatus> => {
    if (!platform.supported) return { state: 'unsupported', subscribed: false };
    const permission = platform.getPermission();
    if (permission === 'denied') return { state: 'permission-denied', subscribed: false };
    if (!platform.applicationServerKey?.trim()) {
      return { state: 'configuration-missing', subscribed: false };
    }

    const registration = await platform.getRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    const enabled = platform.storage.getItem(WEB_PUSH_ENABLED_STORAGE_KEY) === 'true';
    if (enabled) {
      return subscription
        ? { state: 'enabled', subscribed: true }
        : { state: 'subscription-unavailable', subscribed: false };
    }
    return {
      state: permission === 'granted' ? 'disabled' : 'permission-not-granted',
      subscribed: Boolean(subscription)
    };
  };

  const enable = async (): Promise<WebPushStatus> => {
    if (!platform.supported) throw new Error('Web Push is not supported by this browser.');
    const applicationServerKey = platform.applicationServerKey?.trim();
    if (!applicationServerKey) throw new Error('Web Push is not configured for this deployment.');

    let permission = platform.getPermission();
    if (permission === 'denied') {
      throw new Error('Notifications are blocked in browser settings.');
    }
    if (permission !== 'granted') permission = await platform.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');

    const registration = await platform.getRegistration() ?? await platform.register();
    if (!registration) throw new Error('The service worker is unavailable.');

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(applicationServerKey)
      });
    }
    if (!subscription) throw new Error('The browser did not provide a Push subscription.');

    platform.storage.setItem(WEB_PUSH_ENABLED_STORAGE_KEY, 'true');
    return { state: 'enabled', subscribed: true };
  };

  const disable = async (): Promise<void> => {
    let unsubscribeError: unknown;
    try {
      if (platform.supported) {
        const registration = await platform.getRegistration();
        const subscription = registration ? await registration.pushManager.getSubscription() : null;
        if (subscription && !(await subscription.unsubscribe())) {
          throw new Error('The browser could not unsubscribe from Web Push.');
        }
      }
    } catch (error) {
      unsubscribeError = error;
    } finally {
      platform.storage.removeItem(WEB_PUSH_ENABLED_STORAGE_KEY);
    }
    if (unsubscribeError) throw unsubscribeError;
  };

  return { getStatus, enable, disable };
}

export const webPushManager = createWebPushManager({
  get supported() {
    return typeof navigator !== 'undefined'
      && 'serviceWorker' in navigator
      && typeof Notification !== 'undefined'
      && typeof PushManager !== 'undefined';
  },
  applicationServerKey: APPLICATION_SERVER_KEY,
  get storage() {
    return localStorage;
  },
  getPermission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  getRegistration: async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    return await navigator.serviceWorker.getRegistration('/')
      ?? await registerMyceliumServiceWorker();
  },
  register: registerMyceliumServiceWorker
});

function decodeApplicationServerKey(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}
