# TASK-021: Writable Conflict, Recovery, and Physical Acceptance

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Software implementation complete; physical owner execution pending
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

## Software implementation status — August 14, 2026

The software portion now provides:

- a durable typed conflict-resolution outbox with immutable current/candidate
  revision identities and explicit `keep-local`, `keep-server`, and `manual`
  modes;
- side-by-side browser conflict review that retains both candidates and queues
  resolution before network I/O;
- exact conflict resolve HTTP handling, response-identity checks, durable retry,
  CAS-failure preservation, and compaction/resnapshot recovery that preserves
  every local apply base so unseen remote changes still produce conflicts;
- export/restore coverage for queued resolution work without device credentials;
- explicit local, queued, acknowledged, server/Apex-validated, published, and
  conflicted status language;
- deterministic evidence at SHA-256
  `9ed40bbebd7f51d122847daf2c1df92e20011f75a0e68d4385d0dd05b71fb85e`,
  plus a two-device checklist, signoff template, and writable recovery runbook;
  embedded release `shell-96ab0f5519cd6a1bff86220f` contains the gated
  TASK-021 conflict/recovery UI.

TASK-021 is **not complete**. Physical iPad execution and owner signoff remain
mandatory. In particular, inherited PHY-028, PHY-029, PHY-032, PHY-037, and
PHY-038 and every blocking WRT checklist row remain `PENDING` until observed on
the approved devices. Writable pilot approval remains `NO` while any row is
pending or failed.

## Rollback

Turn off writable controls/endpoints, export all pending authored state, and keep
V1 plus read-only V2 available while resolving defects.
