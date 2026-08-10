# TASK-012: Production IndexedDB Snapshot Activation

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Ready
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
