const VERSION = 'v2-bootstrap-shell-3';
const SHELL = [ './', './index.html', './app.js', './sw.js' ];
self.addEventListener('install', event => event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('v2-bootstrap-shell-') && key !== VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Payload is intentionally network-only: cache must not hide corruption injection.
  if (url.pathname.includes('/payload/')) return;
  if (event.request.method === 'GET' && SHELL.some(x => url.pathname.endsWith(x.replace('./','/')))) event.respondWith(caches.match(event.request).then(x => x || fetch(event.request)));
});
