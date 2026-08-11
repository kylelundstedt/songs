# Phase 1 Plan — Isolated Read-Only V2 Vertical Slice

Phase 1's TASK-008 prerequisite completed on August 10, 2026. Read-only delivery reads canonical bytes from source tag `v2-phase1-content-2026-08-10` and contracts/artifacts from evidence tag `v2-phase1-evidence-2026-08-10`. The goal is the smallest production-shaped offline PWA that proves browse, search, Set List viewing, and locked Live mode without introducing user writes.

## Boundary

### Included

- React + TypeScript + Vite application on a separate origin when available, or under `/v2/` after an explicit v1 root-worker bypass/handoff contract;
- typed read model and lossless sidecar identity projection;
- versioned read-only bootstrap API containing source metadata and authoritative Apex HTML;
- atomic IndexedDB snapshots using the TASK-006 activation contract;
- offline library, search, Set List detail, and locked Live mode;
- existing fitter behavior with explicit fit warnings;
- snapshot freshness, persistence, storage, unresolved, and update status;
- versioned service-worker shell isolated from v1;
- feature-flagged browser and offline regression testing.

### Excluded

- all browser mutations and outbox submission;
- production sync operation endpoints;
- Set List or lead-sheet editing;
- conflict-resolution UI;
- local Markdown parser/renderer as an authority;
- Git publication from V2;
- collaboration roles;
- lyrics, Shelley, Notion, or other online enrichment workflows;
- root-route or root-service-worker cutover.

## Estimate

| Measure | Range |
|---|---:|
| Current-baseline closure, TASK-008 | 4–7 focused engineering days |
| Phase 1 base implementation | 18–30 focused engineering days |
| 25–30% implementation risk reserve | 5–9 focused engineering days |
| Phase 1 software commitment | **23–39 focused engineering days** |
| Physical-device pilot/support | 3–5 engineering days plus owner/device time |

The range assumes agent-assisted implementation with small commits and deterministic test gates. It excludes calendar waiting for physical-device access and owner acceptance.

## Work packets

### Prerequisite P1-001 / TASK-008 — Current baseline and coexistence contract

- **Status:** Done on August 10, 2026

- **Estimate:** included in TASK-008, 4–7 days
- **Dependencies:** none
- **Work:** merge/freeze current `main`; regenerate current corpus, renderer/fit, route, recovery, and bootstrap evidence; define `/v2/` boundary and route policy.
- **Demonstration:** current song/Set List counts match the frozen current commit while `v1` artifacts remain unchanged.
- **Rollback:** reset V2 branch to the pre-merge checkpoint; v1/main remains deployable.
- **Model routing:** Luna for mechanical regeneration, Terra for merge/API review, Sol for final parity review.

### P1-002 — Typed read model and frozen identity projection

- **Status:** Done on August 10, 2026

- **Estimate:** 2–4 days
- **Dependencies:** P1-001
- **Work:** implement typed `LeadSheet`, `SetList`, `SetSection`, and `SetEntry` projections that consume the immutable document and Set Entry sidecars frozen by TASK-008.
- **Demonstration:** deterministic projection of every frozen document and entry with source hashes, paths, and the same immutable IDs on repeated imports.
- **Acceptance:** import/export leaves canonical bytes unchanged; duplicate/missing IDs fail; links and identity counts match the TASK-008 artifact rather than hard-coded TASK-007 observations.
- **Rollback:** remove generated projections; canonical corpus and frozen sidecars are untouched.
- **Model routing:** Predictable for fixtures, Terra for schema/lossless projection, Sol review.

### P1-003 — Read-only V2 bootstrap API

- **Status:** Done on August 10, 2026; tracked as TASK-010

- **Estimate:** 2–3 days
- **Dependencies:** P1-002
- **Work:** versioned manifest/chunk endpoints, typed errors, revision metadata, source hashes, authoritative Apex HTML, and route authorization appropriate for private reads.
- **Demonstration:** isolated client verifies the complete current snapshot.
- **Acceptance:** every current document appears once; corrupt/missing chunks fail explicitly; API failures never return HTML fallback.
- **Rollback:** disable `/api/v2`; v1 APIs/routes remain unchanged.
- **Model routing:** Terra implementation, Predictable fixtures, Sol security review.

### P1-004 — Isolated React/Vite shell

- **Status:** Done on August 10, 2026; tracked as TASK-011

- **Estimate:** 2–3 days
- **Dependencies:** P1-001 and P1-003 contract
- **Work:** prefer a separate-origin shell; if deployed at `/v2/`, add a root v1-worker bypass plus explicit controller handoff; use independent manifest, service worker, cache names, IndexedDB names, update state, theme foundation, accessibility structure, and feature flag.
- **Demonstration:** v1 and V2 run concurrently without service-worker or cache interference, including a client already controlled by v1 before its first V2 visit.
- **Acceptance:** separate-origin V2 is independently controlled, or `/v2/` passes root-controller bypass/handoff tests for first load, update, and offline restart; disabling the flag removes V2 without touching v1.
- **Rollback:** disable `/v2/` route/flag and unregister only the V2 worker.
- **Model routing:** Luna implementation, Predictable build fixtures, Terra deployment review.

### P1-005 — Production IndexedDB snapshot integration

- **Status:** Done on August 11, 2026; tracked as TASK-012

- **Estimate:** 2–4 days
- **Dependencies:** P1-003 and P1-004
- **Work:** integrate staged chunks, document verification, retained snapshot, one-pointer activation, retry, cleanup, schema upgrade, and persistence/storage status.
- **Demonstration:** interrupt/corrupt bootstrap, reopen, retain prior snapshot, then activate current content.
- **Acceptance:** TASK-006 logical proofs pass against the production client; pending-state stores survive upgrades even though writes are not exposed.
- **Rollback:** reactivate retained generation or disable V2.
- **Model routing:** Terra for storage core, Luna integration, Predictable failure fixtures.

### P1-006 — Offline library, search, and status

- **Status:** Ready; tracked as TASK-013

- **Estimate:** 2–3 days
- **Dependencies:** P1-005
- **Work:** local song/Set List indexes, title/slug/metadata search, recent/pinned active Set List, snapshot freshness, persistence, quota, and fit status.
- **Demonstration:** browse/search the current library with the server stopped.
- **Acceptance:** no network during browse/search; deleted frozen-baseline Set Lists do not reappear; unresolved and resolved reference counts match the TASK-008 artifact.
- **Rollback:** hide V2 navigation and use v1 library.
- **Model routing:** Luna UI, Predictable search fixtures.

### P1-007 — Offline Set List detail and locked Live mode

- **Estimate:** 3–5 days
- **Dependencies:** P1-002, P1-005, P1-006
- **Work:** Set List detail, local entry resolution, Apex HTML display, fitter port, previous/next controls, bright/dark themes, and performance-only Live surface.
- **Demonstration:** run a complete current Set List offline with no network requests.
- **Acceptance:** every current Set List opens; every entry resolves; portrait corpus gate passes; landscape floor/failure warnings are explicit; no authoring/provider controls appear in Live.
- **Rollback:** disable V2 Live route and retain v1 Live.
- **Model routing:** Luna implementation, Terra fitter integration, Sol stage-safety review.

### P1-008 — Browser, accessibility, and failure hardening

- **Estimate:** 3–5 days
- **Dependencies:** P1-004 through P1-007
- **Work:** desktop/tablet/phone automation, offline/no-network assertions, update/interruption tests, route compatibility, keyboard/touch accessibility, and retained-snapshot recovery.
- **Demonstration:** repeatable CI report for the isolated read-only slice.
- **Acceptance:** all deterministic Phase 0/current-baseline checks pass; separate-origin isolation or root-worker bypass/handoff passes for existing controlled clients; failed updates retain the active snapshot; V2 remains opt-in.
- **Rollback:** do not promote the feature flag.
- **Model routing:** Predictable test generation, Luna fixes, Sol release review.

### P1-009 — Software checkpoint and physical-device package

- **Estimate:** 2–3 days software; physical validation separately 3–5 days
- **Dependencies:** P1-008
- **Work:** install/runbook, test matrix, storage/export status, v1 fallback, and physical-device checklist.
- **Demonstration:** owner can install the isolated V2 PWA and execute the checklist without changing default routes.
- **Acceptance:** software checkpoint passes before requesting physical signoff.
- **Rollback:** leave V2 opt-in and v1 default.
- **Model routing:** Sol checkpoint review with Luna/Terra support.

## Phase 1 software exit gate

- current baseline is frozen and reproducible;
- v1 remains default and unchanged;
- V2 runs on a separate origin or passes the explicit v1 root-worker bypass/controller-handoff contract with independent storage names;
- current library, Set Lists, and Live mode work after one bootstrap with the server unreachable;
- no read-only workflow makes a network request after bootstrap;
- corrupt/interrupted updates retain the prior snapshot;
- status distinguishes snapshot completeness, freshness, persistence, storage, and fit;
- browser/accessibility checks pass;
- no mutation path is exposed.

Physical iPad validation is a separate mandatory gate before calling Phase 1 stage-ready.

## Smallest subsequent writable slice

The first writable slice is single-owner Set List editing only:

- create/duplicate a Set List;
- edit title/date/location/band strings;
- add/remove existing lead sheets;
- reorder stable Set Entry IDs;
- edit per-entry performance notes;
- local autosave, undo, close/reopen recovery;
- explicit foreground sync and visible conflicts.

It excludes lead-sheet editing, collaboration, imports, and provider workflows.

### Hard prerequisites

- production authenticated actor/device binding and owner ACL;
- durable operation receipt, CAS, acknowledged cursors, and compaction/resnapshot policy;
- fenced multi-process publication lease;
- isolated Git materializer and Apex/schema/link validation;
- failed-push/finalization recovery and external delete/rename reconciliation;
- backup/restore of the V2 ledger and skewed Git/ledger states;
- browser export/recovery for unsynced work;
- defined atomic operation semantics for add/delete/reorder actions;
- physical-iPad Phase 1 approval.

### Estimate

| Writable packet | Base range |
|---|---:|
| Authenticated device/owner boundary and durable sync API | 7–11 days |
| Fenced publication, Git reconciliation, and server recovery | 7–11 days |
| Offline Set List editor, undo/reopen recovery, and outbox | 8–12 days |
| Conflict UI, end-to-end failure tests, and pilot packaging | 6–10 days |
| **Writable Set List base** | **28–44 days** |

| Measure | Range |
|---|---:|
| Writable Set List base | 28–44 focused engineering days |
| 25–30% reserve | 8–13 focused engineering days |
| Commitment range | **36–57 focused engineering days** |

## Owner/device checkpoints

Autonomous implementation may continue through P1-008. Owner and physical-device participation becomes mandatory for:

- exact supported iPad/Safari contract;
- Home Screen, process-restart, background, eviction, and low-storage testing;
- active/pinned Set List dashboard behavior;
- local-stage-ready Live opt-in;
- rehearsal and real-gig acceptance;
- any writable or default-route decision.
