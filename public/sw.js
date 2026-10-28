/* Server Chat service worker: caches the visual shell only; chat/API/signalling remain online-only. */
const CACHE_NAME = 'server-chat-shell-v3';
const SHELL_ASSETS = ['/offline.html', '/experience.css', '/ubuntu-cosmic.css', '/status.html', '/status.js', '/legal.html', '/manifest.webmanifest', '/app-icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('server-chat-shell-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Always leave realtime sockets, TURN credentials, health checks and APIs to the network.
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/', copy)).catch(() => {});
        }
        return response;
      }).catch(async () => (await caches.match('/offline.html')) || Response.error())
    );
    return;
  }

  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(async () => (await caches.match(request)) || Response.error())
    );
  }
});

