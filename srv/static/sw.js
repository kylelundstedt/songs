const CACHE_SCHEMA = 1;
const SHELL_CACHE = `songs-shell-v${CACHE_SCHEMA}`;
const META_CACHE = `songs-meta-v${CACHE_SCHEMA}`;
const LIBRARY_PREFIX = `songs-library-v${CACHE_SCHEMA}-`;
const ACTIVE_KEY = '/__songs_offline__/active';
const OFFLINE_PAGE = '/static/offline.html';
const ASSET_VERSION = '20260826-02';
const SHELL = [
  OFFLINE_PAGE,
  `/static/style.css?v=${ASSET_VERSION}`,
  `/static/app.js?v=${ASSET_VERSION}`,
  '/static/icon.svg',
  '/manifest.webmanifest'
];

let activeSnapshot;
let updateQueue = Promise.resolve();

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json'}});
}

async function readJSON(cache, key) {
  const response = await cache.match(key);
  if (!response) return null;
  try { return await response.json(); } catch { return null; }
}

async function readActiveSnapshot(force = false) {
  if (activeSnapshot !== undefined && !force) return activeSnapshot;
  const meta = await caches.open(META_CACHE);
  const pointer = await readJSON(meta, ACTIVE_KEY);
  if (!pointer || pointer.schema !== CACHE_SCHEMA || !pointer.cache_name || !Array.isArray(pointer.resources)) {
    activeSnapshot = null;
    return null;
  }
  if (!(await caches.has(pointer.cache_name))) {
    activeSnapshot = null;
    return null;
  }
  activeSnapshot = pointer;
  return pointer;
}

function post(client, type, data = {}) {
  try { client?.postMessage({type, ...data}); } catch {}
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== CACHE_SCHEMA || typeof manifest.snapshot_id !== 'string' || !manifest.snapshot_id || !Array.isArray(manifest.resources)) {
    throw new Error('Invalid offline library manifest');
  }
  if (manifest.resources.length < 1 || manifest.resources.length > 2000 || manifest.resource_count !== manifest.resources.length) {
    throw new Error('Invalid offline library resource count');
  }
  const seen = new Set();
  const allowed = pathname => pathname === '/' || pathname === '/songs' || pathname === '/set-lists' || pathname === '/about' || pathname === '/api/catalog' || pathname === '/manifest.webmanifest' || pathname.startsWith('/song/') || pathname.startsWith('/sets/') || pathname.startsWith('/static/');
  const allowedSource = pathname => allowed(pathname) || pathname === '/api/offline/resource';
  for (const resource of manifest.resources) {
    if (!resource || typeof resource.url !== 'string' || typeof resource.fingerprint !== 'string' || !resource.fingerprint || seen.has(resource.url)) throw new Error('Invalid offline library resource');
    const canonical = new URL(resource.url, self.location.origin);
    const source = new URL(resource.fetch_url || resource.url, self.location.origin);
    if (canonical.origin !== self.location.origin || source.origin !== self.location.origin || !allowed(canonical.pathname) || !allowedSource(source.pathname)) throw new Error('Offline manifest contains an unsupported URL');
    seen.add(resource.url);
  }
}

function validateFetchedResource(resource, response) {
  const pathname = new URL(resource.url, self.location.origin).pathname;
  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  let valid = false;
  if (pathname === '/api/catalog') valid = contentType.includes('application/json');
  else if (pathname.endsWith('.css')) valid = contentType.includes('text/css');
  else if (pathname.endsWith('.js')) valid = contentType.includes('javascript');
  else if (pathname.endsWith('.svg')) valid = contentType.includes('image/svg+xml');
  else if (pathname === '/manifest.webmanifest') valid = contentType.includes('json');
  else valid = contentType.includes('text/html');
  if (!valid) throw new Error(`Unexpected content for ${resource.url}`);
}

async function responseFingerprint(response) {
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2,'0')).join('');
}

async function verifyResponse(resource, response) {
  validateFetchedResource(resource, response);
  const fingerprint = await responseFingerprint(response);
  if (fingerprint !== resource.fingerprint) throw new Error(`Offline snapshot changed while downloading ${resource.url}`);
}

function canonicalRequest(resource) {
  return new Request(new URL(resource.url, self.location.origin), {method:'GET', credentials:'same-origin'});
}

async function snapshotComplete(pointer) {
  if (!pointer?.cache_name || !Array.isArray(pointer.resources)) return false;
  const cache = await caches.open(pointer.cache_name);
  const keys = await cache.keys();
  if (keys.length !== pointer.resources.length) return false;
  for (const resource of pointer.resources) {
    if (!(await cache.match(canonicalRequest(resource)))) return false;
  }
  return true;
}

async function cleanupAfterCommit(activeCacheName) {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key =>
    (key.startsWith(LIBRARY_PREFIX) && key !== activeCacheName) ||
    (key.startsWith('songs-shell-') && key !== SHELL_CACHE)
  ).map(key => caches.delete(key)));
}

async function updateLibrary(client, jobId) {
  post(client, 'LIBRARY_CACHE_PROGRESS', {job_id:jobId, phase:'manifest', completed:0, total:0});
  const response = await fetch('/api/offline/library', {cache:'no-store', credentials:'same-origin'});
  if (!response.ok) throw new Error(`Unable to load offline library manifest (${response.status})`);
  const manifest = await response.json();
  validateManifest(manifest);

  const oldPointer = await readActiveSnapshot(true);
  if (oldPointer?.snapshot_id === manifest.snapshot_id && await snapshotComplete(oldPointer)) {
    post(client, 'LIBRARY_CACHE_COMPLETE', {job_id:jobId, snapshot_id:manifest.snapshot_id, total:manifest.resource_count, reused:manifest.resource_count, downloaded:0, unchanged:true, updated_at:oldPointer.updated_at});
    return;
  }

  const oldResources = new Map((oldPointer?.resources || []).map(resource => [resource.url, resource]));
  const oldCache = oldPointer ? await caches.open(oldPointer.cache_name) : null;
  const cacheName = `${LIBRARY_PREFIX}staging-${jobId}`;
  await caches.delete(cacheName);
  const staging = await caches.open(cacheName);
  let reused = 0;
  let downloaded = 0;
  let committed = false;

  try {
    for (let index = 0; index < manifest.resources.length; index++) {
      const resource = manifest.resources[index];
      const destination = canonicalRequest(resource);
      const previous = oldResources.get(resource.url);
      let cached = null;
      if (oldCache && previous?.fingerprint === resource.fingerprint) cached = await oldCache.match(destination);
      if (cached) {
        await staging.put(destination, cached.clone());
        reused++;
      } else {
        const source = new Request(new URL(resource.fetch_url || resource.url, self.location.origin), {method:'GET', credentials:'same-origin', cache:'no-store'});
        const fetched = await fetch(source);
        if (!fetched.ok || fetched.status !== 200) throw new Error(`Unable to cache ${resource.url} (${fetched.status})`);
        await verifyResponse(resource, fetched);
        await staging.put(destination, fetched.clone());
        downloaded++;
      }
      post(client, 'LIBRARY_CACHE_PROGRESS', {job_id:jobId, phase:'resources', completed:index+1, total:manifest.resources.length, reused, downloaded, url:resource.url});
    }

    const keys = await staging.keys();
    if (keys.length !== manifest.resources.length) throw new Error(`Offline library verification failed (${keys.length}/${manifest.resources.length})`);

    const pointer = {
      schema:CACHE_SCHEMA,
      snapshot_id:manifest.snapshot_id,
      cache_name:cacheName,
      resource_count:manifest.resource_count,
      resources:manifest.resources,
      updated_at:new Date().toISOString()
    };
    const meta = await caches.open(META_CACHE);
    await meta.put(ACTIVE_KEY, jsonResponse(pointer));
    committed = true;
    activeSnapshot = pointer;
    post(client, 'LIBRARY_CACHE_COMPLETE', {job_id:jobId, snapshot_id:pointer.snapshot_id, total:pointer.resource_count, reused, downloaded, unchanged:false, updated_at:pointer.updated_at});
    await cleanupAfterCommit(cacheName).catch(() => {});
  } catch (error) {
    if (!committed) await caches.delete(cacheName).catch(() => {});
    throw error;
  }
}

async function removeLibrary() {
  const pointer = await readActiveSnapshot(true);
  if (pointer?.cache_name) await caches.delete(pointer.cache_name);
  const meta = await caches.open(META_CACHE);
  await meta.delete(ACTIVE_KEY);
  activeSnapshot = null;
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(LIBRARY_PREFIX)).map(key => caches.delete(key)));
}

async function libraryStatus() {
  const pointer = await readActiveSnapshot(true);
  if (!pointer || !(await snapshotComplete(pointer))) return {ready:false};
  return {ready:true, snapshot_id:pointer.snapshot_id, resource_count:pointer.resource_count, updated_at:pointer.updated_at};
}

async function matchLibrary(request, navigation = false) {
  const pointer = await readActiveSnapshot();
  if (!pointer) return null;
  const cache = await caches.open(pointer.cache_name);
  if (!navigation) return cache.match(request);
  const url = new URL(request.url);
  return cache.match(new Request(new URL(url.pathname, self.location.origin), {credentials:'same-origin'}));
}

self.addEventListener('install', event => event.waitUntil((async () => {
  const shell = await caches.open(SHELL_CACHE);
  await shell.addAll(SHELL);
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  await readActiveSnapshot(true);
})()));

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'CACHE_URLS') {
    const client = event.source;
    const jobId = `legacy-${Date.now()}-${Math.random()}`;
    const job = updateQueue.then(async () => {
      try { await updateLibrary(client, jobId); post(client, 'CACHE_COMPLETE', {set:data.set}); }
      catch (error) { post(client, 'CACHE_ERROR', {message:error?.message || 'Unable to prepare offline library'}); }
    });
    updateQueue = job.catch(() => {});
    event.waitUntil(job);
    return;
  }
  if (data.type === 'UPDATE_LIBRARY') {
    const client = event.source;
    const jobId = String(data.job_id || `${Date.now()}-${Math.random()}`);
    const job = updateQueue.then(async () => {
      try { await updateLibrary(client, jobId); }
      catch (error) {
        const pointer = await readActiveSnapshot(true);
        post(client, 'LIBRARY_CACHE_ERROR', {job_id:jobId, message:error?.message || 'Unable to prepare offline library', preserved_active_snapshot:!!pointer});
      }
    });
    updateQueue = job.catch(() => {});
    event.waitUntil(job);
    return;
  }
  if (data.type === 'GET_LIBRARY_STATUS') {
    event.waitUntil(libraryStatus().then(status => post(event.source, 'LIBRARY_CACHE_STATUS', {job_id:data.job_id, ...status})));
    return;
  }
  if (data.type === 'REMOVE_LIBRARY') {
    const client = event.source;
    const job = updateQueue.then(async () => {
      try { await removeLibrary(); post(client, 'LIBRARY_CACHE_REMOVED', {job_id:data.job_id}); }
      catch (error) { post(client, 'LIBRARY_CACHE_ERROR', {job_id:data.job_id, message:error?.message || 'Unable to remove offline library'}); }
    });
    updateQueue = job.catch(() => {});
    event.waitUntil(job);
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/markdown') || url.pathname === '/api/offline/library') {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(request, {cache:'no-store'}); }
      catch {
        const cached = await matchLibrary(request, true);
        if (cached) return cached;
        const shell = await caches.open(SHELL_CACHE);
        return await shell.match(OFFLINE_PAGE) || new Response('This page is not available offline.', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}});
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      const shell = await caches.open(SHELL_CACHE);
      return await shell.match(request) || await matchLibrary(request) || fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    try { return await fetch(request, {cache:'no-store'}); }
    catch {
      const cached = await matchLibrary(request);
      if (cached) return cached;
      if (url.pathname.startsWith('/api/')) return jsonResponse({error:'offline', message:'This resource is not available offline.'}, 503);
      return new Response('This resource is not available offline.', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
  })());
});
