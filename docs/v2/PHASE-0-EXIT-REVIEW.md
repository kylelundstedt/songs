# Phase 0 Exit Review

- **Review date:** August 9, 2026
- **Rollback baseline:** tag `v1` at `546f59b41d9e9bcf0e81b543c27900a31e26c9e6`
- **V2 evidence branch:** `v2`
- **Decision:** conditional go for an isolated read-only V2 slice; no-go for writable production use or cutover

## Executive conclusion

The controlled-rewrite architecture is technically feasible. Phase 0 proved deterministic corpus recovery, Apex rendering, route characterization, online backup/restore, an idempotent sync/publication kernel, and atomic browser snapshot activation.

Phase 0 **does not meet its strict exit criteria yet** for a user-visible V2 because:

1. the evidence corpus is the frozen `v1` rollback point, while current `main` has materially changed;
2. physical Safari/iPad storage, lifecycle, fit, and performance behavior remains untested;
3. the sync spike proves invariants, not a production authenticated service;
4. the local Markdown renderer proposed originally was not proven.

A read-only slice may proceed after the current-content baseline is refreshed and V2 is isolated from the v1 service worker. Writable client work remains blocked on production durability, authorization, publication leasing, recovery, and physical-device gates.

## Current-content drift discovered at exit review

At review time, current `main` was commit `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5` from August 9, 2026. Compared with `v1`:

- 27 commits had landed;
- songs increased from 291 to 339;
- Set Lists decreased from 60 to 34;
- canonical documents increased from 351 to 373;
- source bytes increased from 743,078 to 748,034;
- 48 songs were added;
- 26 Set Lists were deleted;
- 27 existing canonical files were modified;
- explicit unresolved Set List references decreased from 255 to 0;
- current Set Lists contain 1,076 resolved song links;
- all 339 current songs rendered successfully through Apex 1.1.14 in an isolated read-only check.

The measured observation is reproducible from `migration/v2/phase-0-exit-review.json`; it is pinned to the exact review commit rather than mutable `main`.

The rollback tag remains valid, but a V2 demo built from its payload would omit current songs and resurrect deleted Set Lists. TASK-008 must freeze and regenerate a current-content baseline before Phase 1 parity work.

At the observed commit, identity coverage is 55 of 339 songs and all 34 Set Lists. The 284 legacy songs without declared IDs confirm that sidecars remain the correct migration strategy. TASK-008 must derive the actual sidecar population again from its newly frozen source rather than assume these observed counts remain current.

## Evidence conclusions

| Task | Conclusion | Status after review |
|---|---|---|
| TASK-001 corpus | Exact `v1` rollback corpus is reproducible: 351 documents and 743,078 bytes. | Closed for rollback; stale for current-content parity. |
| TASK-002 renderer/fit | Apex renders 291/291 v1 songs. Chromium portrait fits 291; landscape has two explicit failures; phone is scrollable. | Closed as v1 regression oracle; physical Safari and local renderer remain open. |
| TASK-003 routes | All 27 v1 routes are classified through 1,158 isolated requests. | Closed as inventory; requires preserve/redirect/retire policy, not blind parity. |
| TASK-004 recovery | Git bundle and online SQLite backup restore exactly and fail closed. | Closed for v1; V2 ledger/browser recovery becomes a pre-write requirement. |
| TASK-005 sync | Twenty proofs establish the operation, cursor, conflict, publication, and reconciliation kernel. | Feasible with mandatory production hardening. |
| TASK-006 bootstrap | Thirteen Chromium proofs establish atomic IndexedDB staging, activation, retry, and upgrade preservation. | Feasible in Chromium; physical Safari/iPad remains a blocker for readiness claims. |

## Go/no-go matrix

| Decision | Result | Conditions |
|---|---|---|
| Continue controlled rewrite | **GO** | Preserve v1 rollback and current Markdown history. |
| Refresh/freeze current-content evidence | **GO — mandatory next task** | Resolve latest `main`, regenerate corpus/render/route/bootstrap evidence, and retain v1 artifacts separately. |
| Build isolated read-only V2 PWA | **CONDITIONAL GO** | Current baseline complete; separate origin preferred, otherwise explicit root-worker bypass/handoff contract; no writes or root-route changes. |
| Implement production writable backend | **NO-GO today** | Requires identity migration, auth/device binding, durable ledger backup, publication lease, Apex validation, and reconciliation hardening. |
| Enable browser writes | **NO-GO today** | Requires production backend gates plus local recovery/export and physical Safari tests. |
| Claim iPad offline readiness | **NO-GO** | Requires named physical iPad/Safari acceptance suite. |
| Redirect default routes or retire v1 | **NO-GO** | Requires rehearsal, offline real-gig pilot, rollback drill, and owner approval. |

## Risk disposition

### Closed for the frozen rollback point

- exact corpus manifest and byte hashes;
- deterministic Apex output and browser-profile fit baseline;
- v1 route inventory;
- clean Git/SQLite restore;
- software feasibility of atomic snapshots and sync/publication invariants.

### Converted into production acceptance requirements

- sidecar IDs for 284 legacy songs and stable Set Entry IDs;
- authenticated actor/device binding and owner-first authorization;
- monotonic acknowledged cursors and idempotent operation receipt;
- a fenced multi-process publication lease, not an in-process mutex;
- durable publication intents containing expected Git base and prior published revision;
- isolated Git worktree, failed-push/finalization recovery, and external change reconciliation;
- explicit handling of external delete/rename and multi-file changes;
- Apex/schema/link validation before publication;
- online backup/restore for the V2 ledger, revisions, conflicts, audit, and publication queue;
- client export/recovery for unsynced drafts and outbox operations;
- typed preserve/redirect/retire policy for legacy routes.

### Blocked on physical device or owner validation

- exact supported iPad model and minimum Safari version;
- Home Screen install, airplane-mode launch, process kill/reopen, background resume, and update behavior;
- nonpersistent storage, eviction, and low-storage recovery;
- portrait/landscape safe areas, touch targets, sunlight, dark-stage readability, and wake behavior;
- rehearsal and offline real-gig acceptance;
- owner approval of active-set/dashboard behavior and Live-mode draft policy.

### Deferred deliberately

- local Markdown renderer: Phase 1 will use authoritative server-rendered Apex HTML plus the proven fitter;
- CRDT/automatic Markdown merge: explicit revision conflict resolution remains the model;
- multi-user roles: first writable slice remains single-owner/multi-device;
- external Git delete/rename UI and automatic multi-file reconciliation;
- remote lyrics, Shelley, and other provider workflows.

## Architecture corrections from measured evidence

1. **Two baselines:** `v1` is permanent rollback/regression evidence; a separately frozen current-content baseline feeds user-visible V2 work.
2. **Isolated PWA scope:** a separate origin is preferred while v1 remains deployed. `/v2/` is allowed only after the root v1 worker explicitly bypasses V2 routes/assets and controller-handoff tests cover already-controlled clients, first load, update, and offline restart. V2 must still use independent manifest, cache, and IndexedDB names.
3. **Authoritative read rendering:** Phase 1 bootstraps Apex HTML and source metadata. Local rendering is not on the critical path.
4. **Atomic snapshots:** document payloads stage and verify independently; one transaction retains the prior snapshot, activates the new snapshot, and changes the active-generation pointer exactly once.
5. **No persistence assumption:** `navigator.storage.persist()` was denied in all Chromium captures. The UI must expose persistence/retention state and provide export/recovery rather than relying on quota size.
6. **Acknowledged cursors:** pull is read-only; a cursor becomes durable only after client persistence and explicit acknowledgement.
7. **Publication intents:** each intent persists operation identity, expected document revision, expected prior published revision, and expected Git base. Remote acceptance and SQLite finalization are independently recoverable.
8. **Publication serialization:** production needs a fenced lease valid across processes/restarts.
9. **Reconciliation source of truth:** compare external Markdown with the database's last imported published revision, not an editable sidecar hash claim.
10. **Recovery before writes:** V2 ledger and browser-draft recovery moves ahead of any real writable pilot; it cannot wait for a late hardening phase.
11. **Route policy, not bug compatibility:** preserve canonical bookmarks while retiring accidental behavior such as browsable `/static/`, arbitrary offline fallback to `/`, and authoring controls in Live mode.

## Product defaults until owner review

- single owner across multiple devices; collaboration roles deferred;
- React + TypeScript + Vite for the production client;
- full-library bootstrap by default;
- 13-inch tablet portrait is the primary browser profile; landscape remains supported with explicit fit warnings;
- Live uses the last server-validated/published revision by default;
- a local stage-ready draft may enter Live only after a future explicit owner opt-in and visible acknowledgement;
- Set List `status: draft` metadata is not used to infer dashboard lifecycle because 33 of the current 34 Set Lists carry it despite being historical;
- until scheduling entities exist, the dashboard uses an explicitly pinned active Set List and otherwise falls back to recently used/recently dated content.

## Recommendation

**Do not declare Phase 0 fully closed yet.** Complete TASK-008 to freeze current content and refresh parity evidence. After that task, begin the isolated read-only Phase 1 vertical slice autonomously.

No further owner input is needed for TASK-008 or the software packets preceding physical-device validation. Owner and target-device participation become mandatory before Phase 1 physical acceptance and before any writable or cutover decision.
