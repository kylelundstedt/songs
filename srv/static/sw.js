const CACHE = 'songs-shell-v4';
const SHELL = ['/', '/static/style.css', '/static/app.js', '/static/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_URLS') return;
  event.waitUntil(caches.open(CACHE).then(async cache => {
    for (const url of event.data.urls || []) {
      const response = await fetch(url, {credentials:'same-origin'});
      if (!response.ok) throw new Error(`Unable to cache ${url}`);
      await cache.put(url, response);
    }
  }).then(() => event.source?.postMessage({type:'CACHE_COMPLETE', set:event.data.set})).catch(error => event.source?.postMessage({type:'CACHE_ERROR', message:error.message})));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/'))));
});
