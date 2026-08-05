const CACHE_NAME = 'mycelium-pwa-v1';
const ASSETS_TO_CACHE = ['/', '/index.html', '/src/main.tsx', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', (event: any) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('fetch', (event: any) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
