# TASK-012: Production IndexedDB Snapshot Activation

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Done on August 11, 2026
- **Estimate:** 2–4 focused engineering days

## Objective

Integrate TASK-006's proven staged-chunk, retained-generation, and one-pointer
activation model into the production TASK-011 shell while keeping the UI
strictly read-only.

## Scope

- open only the reserved `songs-v2` IndexedDB namespace;
- stage manifest/chunks/documents under a pending generation;
- verify all hashes/counts/identities before one atomic active-generation
  pointer update;
- retain the previous verified generation through interruption, corruption,
  quota, schema-upgrade, and failed-update scenarios;
- expose persistence/quota/update status without adding content mutations;
- delete only unreachable V2 generations after successful activation.

Do not add edit controls, sync submission, Git publication, local Markdown
rendering authority, v1 storage changes, or route cutover.

## Acceptance criteria

- the production shell passes TASK-006's interruption, corruption, retry,
  upgrade, and retained-snapshot proofs;
- no partial or pending generation is visible to selectors or routes;
- offline restart uses the last active verified generation with zero network;
- a corrupt/newer generation cannot replace or delete the retained snapshot;
- all stores/indexes and cleanup operations remain inside `songs-v2`;
- disabling V2 leaves v1 worker, caches, routes, and storage unchanged;
- Chromium software evidence passes while physical Safari/iPad acceptance
  remains pending.

## Completed evidence

- production database `songs-v2` schema version 2 contains only `snapshots`,
  `documents`, `chunks`, `meta`, `outbox`, `drafts`, and `conflicts`;
- the v1→v2 additive schema upgrade preserves exact pending outbox/draft values,
  adds only `conflicts`, rejects blocked/newer/malformed schemas, and never
  deletes a database to recover;
- preferred network bytes and accepted retained generations pass canonical JSON,
  raw manifest/chunk hashes, self-hashes, framed document hashes,
  source/projection/document/Apex/fit/route identities, and logical snapshot
  generation verification;
- chunks and decoded source artifacts stage in short per-chunk transactions;
  durable rows are read back and fully reverified before a generation can be
  marked verified;
- one activation transaction uses the active physical instance and transition
  epoch as a CAS fence, retains the previous active instance, and updates the
  pointer exactly once; idempotent retries do not increment it;
- physical storage instance IDs allow a corrupt sole active generation to be
  repaired without overwriting it, while stale shells cannot downgrade a valid
  unknown/newer active generation;
- accepted-predecessor tests activate A, activate B, corrupt B, and recover A
  offline with zero fetches; A→B→A ABA tests reject and clean stale stages;
- interrupted, checksum, transport, persistence, and quota failures never expose
  a partial generation and retain the verified active snapshot when one exists;
- cleanup runs only after activation/recovery, protects only current-epoch
  reachable generations, and never opens pending stores for writing;
- the service worker bypasses `/api/v2/`, opens no database, serves only its own
  named cache, retains one prior V2 shell cache, and advertises a manifest
  compatibility contract before explicit update activation;
- 39 web tests cover storage, runtime, integrity, update, UI, and accessibility
  behavior;
- reproducible native Chromium capture bootstraps 373 documents, corrupts the
  active chunk, repairs into a distinct instance, retains the prior instance,
  then reloads with the proxy unavailable and zero API requests;
- evidence is recorded under `migration/v2/phase1/storage/`; persistence was not
  granted in Chromium and physical Safari/iPad eviction, background, Home
  Screen, and low-storage acceptance remain pending;
- final adversarial architecture and code reviews found no remaining material
  issues.
