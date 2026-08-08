# V2 Backlog — Phase 0

Phase 0 protects the tagged v1 corpus and removes the unknowns that could invalidate the controlled rewrite. Tasks are intentionally bounded; each produces reviewable evidence.

| Priority | Task | Acceptance criteria |
|---|---|---|
| Done | [TASK-001 — v1 baseline manifest](tasks/TASK-001-v1-baseline-manifest.md) | Deterministic manifest generated only from tag `v1` / `546f59b`; 351 files, hashes, IDs, and links verified byte-for-byte. |
| Done | [TASK-002 — renderer and fit baseline](tasks/TASK-002-renderer-fit-baseline.md) | Apex and v1 inputs frozen; 291 songs rendered; three browser profiles and screenshots recorded; physical iPad validation explicitly pending. |
| Done | [TASK-003 — legacy-route baseline](tasks/TASK-003-legacy-route-baseline.md) | All 27 v1 routes classified; 1,158 isolated requests and 10 explicit exclusions deterministically preserve the HTTP contract. |
| Done | [TASK-004 — backup and restore baseline](tasks/TASK-004-backup-restore-baseline.md) | Exact Git bundle and online SQLite backup restore cleanly; corpus, DB, routes, and five failure modes verify. |
| P0 | [TASK-005 — sync feasibility spike](tasks/TASK-005-sync-feasibility-spike.md) | Two-device operations prove idempotency, explicit conflicts, external-Git reconciliation, materialization, and failed-push recovery. |
| P1 | Measure bootstrap and storage | Full tagged corpus size, chunking, bootstrap timing, quota headroom, and interrupted-bootstrap recovery are measured on the target iPad profile or documented substitute. |
| P0 | Phase 0 exit review | Baseline rebuild/restore is exact, renderer and sync feasibility are demonstrated, open risks are listed, and Phase 1 estimates/scope are updated. |
