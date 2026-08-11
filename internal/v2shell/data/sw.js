const CACHE_PREFIX = "songs-v2-shell-";
const CACHE_NAME = CACHE_PREFIX + "39849548e3b7192a1c76aa6e";
const RELEASE = "shell-39849548e3b7192a1c76aa6e";
const ACCEPTED_BOOTSTRAP_MANIFESTS = ["a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"];
const PRECACHE = [
  "/assets/index-BO5cP3PF.js",
  "/assets/index-DCAKHP9c.css",
  "/icon.svg",
  "/index.html",
  "/manifest.webmanifest"
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => {
      const previous = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
      return Promise.all(previous.slice(0, Math.max(0, previous.length - 1)).map((name) => caches.delete(name)));
    }),
    self.clients.claim(),
  ]));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_COMPATIBILITY') {
    event.ports[0]?.postMessage({release: RELEASE, accepted_bootstrap_manifest_sha256: ACCEPTED_BOOTSTRAP_MANIFESTS});
    return;
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api/v2' || url.pathname.startsWith('/api/v2/')) return;
  if (event.request.mode === 'navigate') {
    if (url.searchParams.has('auth-refresh') || (url.pathname !== '/' && url.pathname !== '/index.html')) return;
    event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match('/index.html')).then((cached) => cached || fetch(event.request)));
    return;
  }
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(event.request)).then((cached) => cached || fetch(event.request)));
  }
});
