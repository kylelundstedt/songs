/* Disposable TASK-006 harness: no dependencies, no production UI. */
(() => {
'use strict';
const q = new URLSearchParams(location.search);
const profile = q.get('profile') || 'default';
const DB = q.get('db') || `v2-bootstrap-spike-${profile}`;
const VERSION = 2;
const PAYLOAD = '../payload/';
const LEGACY_PATH = 'legacy/active.md';
const text = new TextEncoder();
const status = document.querySelector('#status');
const now = () => performance.now();
const BASE_STORES = ['snapshots', 'documents', 'chunks', 'meta', 'outbox', 'drafts'];
const V2_STORES = [...BASE_STORES, 'conflicts'];

const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
async function hash(value) {
  const bytes = value instanceof Uint8Array || value instanceof ArrayBuffer ? value : text.encode(value);
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}
function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}
function createBaseStores(database) {
  if (!database.objectStoreNames.contains('snapshots')) database.createObjectStore('snapshots', {keyPath: 'generation'});
  if (!database.objectStoreNames.contains('documents')) database.createObjectStore('documents', {keyPath: ['generation', 'path']});
  if (!database.objectStoreNames.contains('chunks')) database.createObjectStore('chunks', {keyPath: ['generation', 'index']});
  if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', {keyPath: 'key'});
  if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox', {keyPath: 'id'});
  if (!database.objectStoreNames.contains('drafts')) database.createObjectStore('drafts', {keyPath: 'id'});
}
function open(version = VERSION) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, version);
    request.onupgradeneeded = event => {
      const database = request.result;
      // A v1 seed must contain exactly the historical stores. A v2 open from
      // v1 adds only conflicts; a fresh v2 open builds base stores then conflicts.
      if (event.oldVersion < 1) createBaseStores(database);
      if (event.oldVersion < 2 && version >= 2 && !database.objectStoreNames.contains('conflicts')) {
        database.createObjectStore('conflicts', {keyPath: 'id'});
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function schema(version = VERSION) {
  const database = await open(version);
  const result = {version: database.version, stores: [...database.objectStoreNames].sort()};
  database.close();
  return result;
}
async function readAll(store) {
  const database = await open();
  const transaction = database.transaction(store);
  const result = await req(transaction.objectStore(store).getAll());
  await done(transaction);
  database.close();
  return result;
}
async function get(store, key) {
  const database = await open();
  const transaction = database.transaction(store);
  const result = await req(transaction.objectStore(store).get(key));
  await done(transaction);
  database.close();
  return result;
}
async function eraseDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('close other connections before reset'));
  });
}
async function reset() { await eraseDatabase(); return {db: DB, reset: true}; }
async function seedV1State() {
  await eraseDatabase();
  const legacy = 'old-active\n';
  const legacyHash = await hash(legacy);
  const database = await open(1);
  const transaction = database.transaction(BASE_STORES, 'readwrite');
  transaction.objectStore('snapshots').put({generation: 'old-v1', state: 'active', schema: 1, document_count: 1});
  transaction.objectStore('documents').put({generation: 'old-v1', path: LEGACY_PATH, bytes: text.encode(legacy).length, sha256: legacyHash, content_base64: btoa(legacy)});
  transaction.objectStore('meta').put({key: 'active-generation', value: 'old-v1'});
  transaction.objectStore('meta').put({key: 'pointer-transitions', value: 0});
  transaction.objectStore('outbox').put({id: 'pending-outbox', kind: 'edit', body: 'pending'});
  transaction.objectStore('drafts').put({id: 'pending-draft', body: 'draft'});
  await done(transaction);
  database.close();
  return {seeded: true, expected_legacy: {path: LEGACY_PATH, bytes: text.encode(legacy).length, sha256: legacyHash}, ...(await schema(1)), active_generation: 'old-v1'};
}
async function reopen() { return {reopened: true, ...(await schema())}; }
async function manifest() {
  const response = await fetch(PAYLOAD + 'manifest.json', {cache: 'no-store'});
  if (!response.ok) throw new Error(`manifest fetch ${response.status}`);
  return response.json();
}
function b64bytes(value) {
  const raw = atob(value), out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}
async function stagedGeneration(generation) {
  const active = (await get('meta', 'active-generation'))?.value;
  if (active === generation) throw new Error('refusing to replace active generation');
  const [documents, chunks] = await Promise.all([readAll('documents'), readAll('chunks')]);
  const database = await open();
  const transaction = database.transaction(['documents', 'chunks', 'snapshots'], 'readwrite');
  for (const item of documents) if (item.generation === generation) transaction.objectStore('documents').delete([item.generation, item.path]);
  for (const item of chunks) if (item.generation === generation) transaction.objectStore('chunks').delete([item.generation, item.index]);
  transaction.objectStore('snapshots').delete(generation);
  await done(transaction);
  database.close();
}
function identityPart(parts, raw) {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(raw.length));
  parts.push(length, raw);
}
async function fullDigest(documentRows) {
  const parts = [];
  for (const item of [...documentRows].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    identityPart(parts, text.encode(item.path));
    identityPart(parts, text.encode(item.sha256));
    identityPart(parts, b64bytes(item.content_base64));
  }
  const whole = new Uint8Array(parts.reduce((total, item) => total + item.length, 0));
  let offset = 0;
  for (const item of parts) { whole.set(item, offset); offset += item.length; }
  return hash(whole);
}
async function stage(options = {}) {
  const began = now(), payloadManifest = await manifest(), generation = payloadManifest.generation;
  await stagedGeneration(generation);
  let staged = [];
  for (const chunk of payloadManifest.chunks) {
    if (options.interrupt_after_chunk === chunk.index) return {generation, staged: false, failure: 'interrupted', interrupted_chunk: chunk.index, duration_ms: now() - began};
    const response = await fetch(PAYLOAD + chunk.path, {cache: 'no-store'});
    if (!response.ok) throw new Error(`chunk fetch ${chunk.index}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (options.corrupt_chunk === chunk.index && bytes.length) bytes[bytes.length - 1] ^= 1;
    if (await hash(bytes) !== chunk.sha256) return {generation, staged: false, failure: 'chunk-checksum', corrupt_chunk: chunk.index, duration_ms: now() - began};
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return {generation, staged: false, failure: 'chunk-json', duration_ms: now() - began}; }
    if (payload.generation !== generation || payload.index !== chunk.index || !Array.isArray(payload.documents)) return {generation, staged: false, failure: 'chunk-shape', duration_ms: now() - began};
    for (const document of payload.documents) {
      if (document.bytes !== b64bytes(document.content_base64).length || await hash(b64bytes(document.content_base64)) !== document.sha256) return {generation, staged: false, failure: 'document-checksum', duration_ms: now() - began};
    }
    // Fetch/hash work is complete before this short per-chunk write transaction.
    const database = await open();
    const transaction = database.transaction(['chunks', 'documents', 'snapshots'], 'readwrite');
    transaction.objectStore('chunks').put({generation, index: chunk.index, sha256: chunk.sha256, source_bytes: chunk.source_bytes});
    for (const document of payload.documents) transaction.objectStore('documents').put({generation, ...document});
    transaction.objectStore('snapshots').put({generation, state: 'staging', snapshot_digest: payloadManifest.snapshot_digest, document_count: payloadManifest.corpus.documents, source_bytes: payloadManifest.corpus.bytes});
    await done(transaction);
    database.close();
    staged = staged.concat(payload.documents);
  }
  if (staged.length !== payloadManifest.corpus.documents || await fullDigest(staged) !== payloadManifest.snapshot_digest) return {generation, staged: false, failure: 'snapshot-checksum', duration_ms: now() - began};
  return {generation, staged: true, chunk_count: payloadManifest.chunks.length, document_count: staged.length, duration_ms: now() - began};
}
async function activate(generation) {
  const payloadManifest = await manifest();
  if (generation !== payloadManifest.generation) throw new Error('unknown generation');
  const rows = (await readAll('documents')).filter(item => item.generation === generation);
  if (rows.length !== payloadManifest.corpus.documents || await fullDigest(rows) !== payloadManifest.snapshot_digest) return {activated: false, failure: 'snapshot-checksum'};
  const database = await open();
  const transaction = database.transaction(['snapshots', 'meta'], 'readwrite');
  const snapshots = transaction.objectStore('snapshots'), meta = transaction.objectStore('meta');
  // These are IDB requests only; no network/crypto await occurs in activation.
  const snapshot = await req(snapshots.get(generation));
  const activePointer = await req(meta.get('active-generation'));
  const pointerTransitions = await req(meta.get('pointer-transitions'));
  const previousGeneration = activePointer?.value || null;
  const previousSnapshot = previousGeneration ? await req(snapshots.get(previousGeneration)) : null;
  if (!snapshot || snapshot.state !== 'staging') { database.close(); return {activated: false, failure: 'not-complete'}; }
  if (previousSnapshot && previousGeneration !== generation) snapshots.put({...previousSnapshot, state: 'retained'});
  snapshots.put({...snapshot, state: 'active'});
  meta.put({key: 'active-generation', value: generation});
  meta.put({key: 'pointer-transitions', value: (pointerTransitions?.value || 0) + 1});
  await done(transaction);
  database.close();
  return {activated: true, generation, previous_generation: previousGeneration};
}
async function retry(options = {}) {
  const payloadManifest = await manifest();
  if ((await get('meta', 'active-generation'))?.value === payloadManifest.generation) return {generation: payloadManifest.generation, staged: true, activated: true, idempotent: true, duration_ms: 0};
  const result = await stage(options);
  return result.staged ? {...result, ...(await activate(result.generation))} : result;
}
async function cleanup() {
  const active = (await get('meta', 'active-generation'))?.value;
  const snapshots = await readAll('snapshots');
  const removed = [];
  for (const snapshot of snapshots) if (snapshot.generation !== active && snapshot.state === 'staging') { await stagedGeneration(snapshot.generation); removed.push(snapshot.generation); }
  return {active_generation: active || null, removed};
}
async function inspect() {
  const [snapshots, documents, chunks, meta, outbox, drafts, conflicts] = await Promise.all(V2_STORES.map(readAll));
  const active = meta.find(item => item.key === 'active-generation')?.value || null;
  const legacy = documents.find(item => item.generation === 'old-v1' && item.path === LEGACY_PATH);
  const legacyContentSha256 = legacy ? await hash(b64bytes(legacy.content_base64)) : null;
  return {
    db: DB,
    ...(await schema()),
    active_generation: active,
    pointer_transitions: meta.find(item => item.key === 'pointer-transitions')?.value || 0,
    snapshots: snapshots.map(item => ({generation: item.generation, state: item.state, document_count: item.document_count})).sort((a, b) => a.generation.localeCompare(b.generation)),
    documents_by_generation: Object.fromEntries([...new Set(documents.map(item => item.generation))].sort().map(generation => [generation, documents.filter(item => item.generation === generation).length])),
    chunk_count: chunks.length,
    outbox_count: outbox.length,
    draft_count: drafts.length,
    conflict_count: conflicts.length,
    legacy_document: legacy ? {path: legacy.path, bytes: legacy.bytes, sha256: legacy.sha256, content_sha256: legacyContentSha256, content_matches_record: legacy.sha256 === legacyContentSha256} : null,
  };
}
async function storage() {
  const estimate = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
  let persisted = null, persistResult = null;
  if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
  if (navigator.storage && navigator.storage.persist) persistResult = await navigator.storage.persist();
  return {usage: estimate.usage ?? null, quota: estimate.quota ?? null, persisted, persist_result: persistResult};
}
async function expectedShellCache() {
  const source = await (await fetch('./sw.js', {cache: 'no-store'})).text();
  const match = source.match(/const VERSION = '([^']+)'/);
  return match && /^v2-bootstrap-shell-[A-Za-z0-9._-]+$/.test(match[1]) ? match[1] : null;
}
async function serviceWorker() {
  const expectedCacheName = await expectedShellCache();
  if (!('serviceWorker' in navigator)) return {supported: false, registered: false, expected_cache_name: expectedCacheName, cache_name: null, cache_matches_expected: false};
  await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  const cacheNames = await caches.keys();
  const cacheName = expectedCacheName && cacheNames.includes(expectedCacheName) ? expectedCacheName : null;
  return {supported: true, registered: true, expected_cache_name: expectedCacheName, cache_name: cacheName, cache_matches_expected: cacheName === expectedCacheName && cacheName !== null};
}
async function verifiedRows(rows) {
  for (const row of rows) if (row.bytes !== b64bytes(row.content_base64).length || await hash(b64bytes(row.content_base64)) !== row.sha256) return false;
  return true;
}
function sameStores(left, right) { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
function activeSnapshots(inspection) { return inspection.snapshots.filter(item => item.state === 'active'); }
function legacyMatches(inspection, expected) {
  const legacy = inspection.legacy_document;
  return !!legacy && legacy.path === expected.path && legacy.bytes === expected.bytes && legacy.sha256 === expected.sha256 && legacy.content_sha256 === expected.sha256 && legacy.content_matches_record === true;
}
async function fullScenario() {
  const usageBefore = await storage();
  const seeded = await seedV1State();
  const upgraded = await reopen();
  const database = await open();
  const conflictTransaction = database.transaction('conflicts', 'readwrite');
  conflictTransaction.objectStore('conflicts').put({id: 'pending-conflict', body: 'placeholder'});
  await done(conflictTransaction);
  database.close();

  const interrupted = await stage({interrupt_after_chunk: 1});
  const afterInterrupted = await inspect();
  const orphanCleanup = await cleanup();
  const afterOrphanCleanup = await inspect();
  const reopenedAfterInterrupt = await reopen();
  const corrupt = await stage({corrupt_chunk: 2});
  const afterCorrupt = await inspect();
  const success = await retry();
  const afterSuccess = await inspect();
  const idempotentRetry = await retry();
  const afterIdempotentRetry = await inspect();
  const finalCleanup = await cleanup();
  const usageAfter = await storage();
  const sw = await serviceWorker();
  const payloadManifest = await manifest();
  const rows = (await readAll('documents')).filter(item => item.generation === payloadManifest.generation);
  const documentVerification = {count: rows.length, hashes_valid: await verifiedRows(rows), snapshot_digest: await fullDigest(rows), expected_snapshot_digest: payloadManifest.snapshot_digest};
  const active = activeSnapshots(afterSuccess);
  const proofs = {
    schema_upgrade: seeded.version === 1 && upgraded.version === 2 && sameStores(seeded.stores, BASE_STORES) && sameStores(upgraded.stores, V2_STORES) && sameStores(reopenedAfterInterrupt.stores, V2_STORES),
    interruption_failure: interrupted.failure === 'interrupted' && interrupted.staged === false,
    checksum_failure: corrupt.failure === 'chunk-checksum' && corrupt.staged === false,
    previous_active_survived_failures: legacyMatches(afterInterrupted, seeded.expected_legacy) && legacyMatches(afterCorrupt, seeded.expected_legacy),
    active_pointer_survived_failures: afterInterrupted.active_generation === 'old-v1' && afterCorrupt.active_generation === 'old-v1' && afterInterrupted.pointer_transitions === 0 && afterCorrupt.pointer_transitions === 0,
    pending_writes_preserved: afterIdempotentRetry.outbox_count === 1 && afterIdempotentRetry.draft_count === 1,
    conflict_preserved: afterIdempotentRetry.conflict_count === 1,
    activation_pointer_transition_exactly_one: afterSuccess.pointer_transitions === 1 && afterIdempotentRetry.pointer_transitions === 1,
    single_active_snapshot_and_pointer_authority: active.length === 1 && active[0].generation === payloadManifest.generation && afterSuccess.active_generation === payloadManifest.generation && afterSuccess.snapshots.some(item => item.generation === 'old-v1' && item.state === 'retained'),
    idempotent_retry: idempotentRetry.idempotent === true && idempotentRetry.activated === true && afterIdempotentRetry.active_generation === afterSuccess.active_generation && afterIdempotentRetry.documents_by_generation[payloadManifest.generation] === afterSuccess.documents_by_generation[payloadManifest.generation],
    all_documents_readable: documentVerification.count === payloadManifest.corpus.documents && documentVerification.hashes_valid === true && documentVerification.snapshot_digest === documentVerification.expected_snapshot_digest,
    orphan_cleanup: orphanCleanup.removed.includes(payloadManifest.generation) && legacyMatches(afterOrphanCleanup, seeded.expected_legacy) && finalCleanup.removed.length === 0,
    service_worker: sw.supported === true && sw.registered === true && sw.expected_cache_name !== null && sw.cache_matches_expected === true,
  };
  return {
    baseline: payloadManifest.baseline,
    generation: payloadManifest.generation,
    profile,
    scenario_proof: proofs,
    scenario: {schema: {seeded, upgraded, reopened_after_interrupt: reopenedAfterInterrupt}, stages: {interrupted, after_interrupted: afterInterrupted, orphan_cleanup: orphanCleanup, after_orphan_cleanup: afterOrphanCleanup, corrupt, after_corrupt: afterCorrupt, success, after_success: afterSuccess, idempotent_retry: idempotentRetry, after_idempotent_retry: afterIdempotentRetry, final_cleanup: finalCleanup}, document_verification: documentVerification},
    documents: rows.length,
    source_bytes: payloadManifest.corpus.bytes,
    durations_ms: {interrupted: interrupted.duration_ms, corrupt: corrupt.duration_ms, success: success.duration_ms, idempotent_retry: idempotentRetry.duration_ms},
    storage: {before: usageBefore, after: usageAfter},
    service_worker: sw,
  };
}
window.BootstrapSpike = {reset, seedV1State, inspect, stage, activate, retry, cleanup, reopen, fullScenario, storage, serviceWorker, hash};
status.textContent = `BootstrapSpike ready (${DB})`;
})();
