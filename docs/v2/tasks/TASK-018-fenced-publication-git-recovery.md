# TASK-018: Fenced Publication, Git Reconciliation, and Recovery

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Planned after TASK-017
- **Dependencies:** TASK-017; TASK-005 publication feasibility
- **Estimate:** 7–11 focused engineering days

## Objective

Turn durable accepted operations into validated Git/Markdown publication without
losing acknowledged work, duplicating publication, or corrupting the canonical
archive.

## Scope

- persist publication intents with expected document revision, expected prior
  published revision, and expected Git base;
- acquire a fenced multi-process publication lease;
- materialize changes in an isolated Git worktree;
- run schema, identity, link, Apex, and corpus validation before commit/push;
- separate local commit, remote push, SQLite finalization, and client
  acknowledgement into recoverable states;
- reconcile external Git edits, deletes, and renames against the last imported
  published revision;
- implement ledger/Git backup and restore across skewed states;
- prove crash recovery at every publication boundary.

## Excluded

- browser editor UI;
- visual redesign;
- printing/export;
- hidden background provider sync;
- default-route cutover or V1 retirement.

## Acceptance criteria

- concurrent publishers cannot both act under one lease generation;
- stale Git bases fail without overwriting external changes;
- failed validation never reaches Git publication;
- retry after commit/push/finalization crashes converges without duplicate commits
  or lost acknowledgements;
- external reconciliation preserves explicit conflict candidates;
- backup/restore recovers all tested Git/ledger skew combinations;
- V1 and the read-only V2 pilot remain usable throughout failure drills.

## Rollback

Fence and disable publication workers while retaining durable accepted operations
for later recovery; do not discard acknowledged browser work.
