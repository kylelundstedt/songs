# V2 Backlog

Phase 0 software feasibility and current-content closure are complete. Phase 1 now builds the isolated read-only vertical slice from the frozen current baseline; physical Safari/iPad acceptance remains a later mandatory gate.

| Priority | Task | Acceptance criteria |
|---|---|---|
| Done | [TASK-001 — v1 baseline manifest](tasks/TASK-001-v1-baseline-manifest.md) | Deterministic manifest generated only from tag `v1` / `546f59b`; 351 files, hashes, IDs, and links verified byte-for-byte. |
| Done | [TASK-002 — renderer and fit baseline](tasks/TASK-002-renderer-fit-baseline.md) | Apex and v1 inputs frozen; 291 songs rendered; three browser profiles and screenshots recorded; physical iPad validation explicitly pending. |
| Done | [TASK-003 — legacy-route baseline](tasks/TASK-003-legacy-route-baseline.md) | All 27 v1 routes classified; 1,158 isolated requests and 10 explicit exclusions deterministically preserve the HTTP contract. |
| Done | [TASK-004 — backup and restore baseline](tasks/TASK-004-backup-restore-baseline.md) | Exact Git bundle and online SQLite backup restore cleanly; corpus, DB, routes, and five failure modes verify. |
| Done | [TASK-005 — sync feasibility spike](tasks/TASK-005-sync-feasibility-spike.md) | 20 proofs establish idempotent operations, cursor acknowledgement, explicit conflicts, durable publication recovery, and external reconciliation. |
| Done | [TASK-006 — atomic bootstrap and storage](tasks/TASK-006-atomic-bootstrap-storage.md) | 13 Chromium proofs establish atomic activation, interruption/corruption recovery, upgrade preservation, idempotent retry, and measured headroom. |
| Done | [TASK-007 — Phase 0 exit review](tasks/TASK-007-phase-0-exit-review.md) | Conditional go: architecture feasible, read-only slice approved, writable/cutover blocked, and current baseline refresh required. |
| Done | [TASK-008 — current-content baseline](tasks/TASK-008-current-content-baseline.md) | Source tag `v2-phase1-content-2026-08-10` freezes 373 documents; evidence tag `v2-phase1-evidence-2026-08-10` freezes renderer/fit, route/policy, recovery, bootstrap, identity, and coexistence artifacts while preserving `v1`. |
| Done | [TASK-009 — typed read model](tasks/TASK-009-typed-read-model.md) | All 373 frozen documents, 36 section projections, and 1,076 Set Entries project losslessly from pinned tags with typed failures and deterministic fixtures. |
| Done | [TASK-010 — versioned read-only bootstrap API](tasks/TASK-010-read-only-bootstrap-api.md) | Reviewed manifest plus 12 chunks serve complete source/projection/Apex/fit data from isolated port 8001 with startup trust-anchor validation and authenticated JSON-only failures. |
| Done | [TASK-011 — isolated React/Vite read-only shell](tasks/TASK-011-isolated-read-only-shell.md) | Embedded release verifies the complete snapshot before rendering, serves read-only library/song/Set-List/status UI, and isolates its worker/cache with no IndexedDB or v1 changes. |
| Done | [TASK-012 — production IndexedDB snapshot activation](tasks/TASK-012-production-indexeddb-snapshot.md) | Stages and reverifies raw chunks/documents, atomically activates one fenced physical instance, retains/recover predecessors, repairs corruption, and cold-restarts with zero API requests. |
| Done | [TASK-013 — offline library, search, and snapshot diagnostics](tasks/TASK-013-offline-library-search-status.md) | Deterministic active-pointer indexes provide zero-API offline browse/search, exact reviewed diagnostics, latest-date active Set List fallback, and Chromium accessibility evidence without writes. |

Phase 1 packet definitions, estimates, dependencies, rollback points, and model routing are in [`PHASE-1-PLAN.md`](PHASE-1-PLAN.md).
