const CACHE_NAME = 'mycelium-pwa-v1';
const URLS_TO_CACHE = ['/', '/index.html', '/styles.css', '/manifest.webmanifest'];
const PUSH_STAGING_CACHE = 'mycelium-web-push-staging-v1';
const PUSH_STAGING_PATH = '/__mycelium_push_staging_v1__/';
const PUSH_ENVELOPE_MAX_BYTES = 3900;
const PUSH_STAGING_MAX_ENTRIES = 32;
const PUSH_STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUSH_STAGED_MESSAGE_TYPE = 'MYCELIUM_PUSH_STAGED_V1';
let stagingQueue = Promise.resolve();

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(URLS_TO_CACHE))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.open(CACHE_NAME)
      .then((cache) => cache.match(event.request))
      .then((response) => response || fetch(event.request))
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (message.type === 'MYCELIUM_PUSH_DRAIN_V1') {
    event.waitUntil(sendStagedItems(event.source));
  } else if (message.type === 'MYCELIUM_PUSH_ACK_V1') {
    event.waitUntil(removeStagedItems(message.ids));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
});

async function handlePush(event) {
  try {
    if (!event.data) return;
    const bytes = await event.data.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > PUSH_ENVELOPE_MAX_BYTES) return;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const envelope = parseEnvelope(JSON.parse(text));
    if (!envelope) return;
    const id = envelope.type === 'object' ? envelope.object.object_id : envelope.object_id;
    await enqueueStaging(() => storeEnvelope(id, envelope));
    await notifyOpenClients([{ id, envelope }]);
  } catch {
    return;
  }
}

function parseEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  if (value.type === 'reference'
    && hasExactKeys(value, ['version', 'type', 'object_id'])
    && isObjectId(value.object_id)) {
    return { version: 1, type: 'reference', object_id: value.object_id };
  }
  const object = value.object;
  if (value.type !== 'object'
    || !hasExactKeys(value, ['version', 'type', 'object'])
    || !object || typeof object !== 'object' || Array.isArray(object)
    || !isObjectId(object.object_id)) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PUSH_ENVELOPE_MAX_BYTES) return null;
  } catch {
    return null;
  }
  return { version: 1, type: 'object', object };
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function stagedRequest(id) {
  return new Request(new URL(`${PUSH_STAGING_PATH}${id}`, self.location.origin));
}

function enqueueStaging(operation) {
  const result = stagingQueue.then(operation);
  stagingQueue = result.catch(() => {});
  return result;
}

async function storeEnvelope(id, envelope) {
  const cache = await caches.open(PUSH_STAGING_CACHE);
  const request = stagedRequest(id);
  await cache.put(request, new Response(JSON.stringify(envelope), {
    headers: {
      'Content-Type': 'application/json',
      'X-Mycelium-Staged-At': String(Date.now())
    }
  }));
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - PUSH_STAGING_MAX_ENTRIES))) {
    if (key.url !== request.url) await cache.delete(key);
  }
}

async function notifyOpenClients(items) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(clients.map(async (client) => {
    try {
      client.postMessage({ type: PUSH_STAGED_MESSAGE_TYPE, items });
    } catch {
      return;
    }
  }));
}

async function sendStagedItems(client) {
  if (!client || typeof client.postMessage !== 'function') return;
  try {
    const cache = await caches.open(PUSH_STAGING_CACHE);
    const keys = await cache.keys();
    const items = [];
    for (const key of keys.slice(0, PUSH_STAGING_MAX_ENTRIES)) {
      const id = new URL(key.url).pathname.slice(PUSH_STAGING_PATH.length);
      if (!isObjectId(id)) continue;
      const response = await cache.match(key);
      if (!response) continue;
      const stagedAt = Number(response.headers.get('X-Mycelium-Staged-At'));
      if (!Number.isFinite(stagedAt) || Date.now() - stagedAt > PUSH_STAGING_TTL_MS) {
        await cache.delete(key);
        continue;
      }
      const envelope = parseEnvelope(await response.json());
      if (!envelope || (envelope.type === 'object' ? envelope.object.object_id : envelope.object_id) !== id) {
        await cache.delete(key);
        continue;
      }
      items.push({ id, envelope });
    }
    client.postMessage({ type: PUSH_STAGED_MESSAGE_TYPE, items });
  } catch {
    return;
  }
}

async function removeStagedItems(ids) {
  if (!Array.isArray(ids) || ids.length > PUSH_STAGING_MAX_ENTRIES) return;
  try {
    const cache = await caches.open(PUSH_STAGING_CACHE);
    await Promise.all(ids.filter(isObjectId).map((id) => cache.delete(stagedRequest(id))));
  } catch {
    return;
  }
}
