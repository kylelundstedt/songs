# TASK-021: Writable Conflict, Recovery, and Physical Acceptance

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Next after TASK-020
- **Dependencies:** TASK-017 through TASK-020 plus completion of deferred blocking P1-009 G4 checks before physical writable acceptance
- **Estimate:** 6–10 focused engineering days plus owner/device time

## Objective

Harden the complete writable Set List and lead-sheet slice across conflicts,
failure recovery, multi-device behavior, and physical iPad workflows before any
writable pilot can be approved.

## Scope

- conflict review and explicit keep-local/keep-server/manual-resolution flows;
- multi-device concurrent edit, stale cursor, retry, revocation, and clock-skew
  scenarios;
- browser quota, eviction, upgrade, interrupted sync, server restart, failed
  validation, failed push, and external Git reconciliation drills;
- authored-data export/restore and server backup/restore;
- current Safari/iPad writable workflow checklist on the approved device;
- verify status language distinguishes local, queued, acknowledged,
  server-validated, published, and conflicted states;
- preserve V1 and read-only V2 fallback throughout.

## Excluded

- broad visual redesign beyond safety/usability blockers;
- collaboration roles beyond the initial owner contract;
- printing/spreadsheet export;
- default-route cutover or V1 retirement.

## Acceptance criteria

- no failure mode loses accepted or locally committed authored work;
- conflicts are explicit and retain both candidates;
- export/restore recovers unsynced work on a clean browser profile;
- physical iPad create/edit/reorder/offline/reopen/sync/conflict workflows pass;
- published Git bytes and server ledger converge after every recovery drill;
- writable pilot approval remains a separate owner decision after evidence review.

## Rollback

Turn off writable controls/endpoints, export all pending authored state, and keep
V1 plus read-only V2 available while resolving defects.
