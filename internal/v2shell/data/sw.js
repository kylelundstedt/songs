const CACHE_PREFIX = "songs-v2-shell-";
const CACHE_NAME = CACHE_PREFIX + "72d3106d38dfec5cc2eaf403";
const PRECACHE = [
  "/assets/index-Bb_-wwX_.css",
  "/assets/index-oDvr8QXe.js",
  "/icon.svg",
  "/index.html",
  "/manifest.webmanifest"
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api/v2' || url.pathname.startsWith('/api/v2/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
    return;
  }
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
