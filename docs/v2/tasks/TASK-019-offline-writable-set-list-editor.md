# TASK-019: Offline Writable Set List Editor and Outbox

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Planned after TASK-018
- **Dependencies:** TASK-017 and TASK-018
- **Estimate:** 8–12 focused engineering days

## Objective

Deliver the smallest useful writable browser slice: single-owner Set List
creation/editing that survives offline work, close/reopen, retries, and sync
failures without exposing lead-sheet authoring or unsafe publication shortcuts.

## Scope

- create and duplicate Set Lists;
- edit title, date, location, and band strings;
- add/remove existing reviewed lead sheets;
- reorder stable Set Entry IDs and preserve duplicate occurrences;
- edit per-entry performance notes;
- validate and commit every mutation locally before entering a durable outbox;
- provide autosave, undo, close/reopen recovery, explicit foreground sync, and
  visible local/server/published states;
- export/recover unsynced authored operations before writable physical testing;
- keep Live on the last server-validated/published revision by default, with any
  local-stage-ready opt-in separately acknowledged and labeled;
- use provisional functional UI sufficient to validate workflows; defer broad
  visual polish to TASK-022.

## Excluded

- lead-sheet editing;
- collaboration roles;
- spreadsheet import/export and printing;
- provider enrichment;
- default-route cutover or V1 retirement.

## Acceptance criteria

- every action has defined atomic semantics and deterministic undo behavior;
- offline edits survive process restart and browser reopen;
- outbox retry is idempotent and never reorders or collapses duplicate entries;
- unsynced work can be exported and restored before any physical writable pilot;
- conflicts and failed publication never masquerade as saved/published state;
- locked Live remains protected from incomplete/unacknowledged mutations;
- no data loss across quota, interruption, update, and retained-snapshot tests.

## Rollback

Disable writable controls and sync submission while preserving/exporting local
outbox and conflict state; read-only V2 and V1 remain available.
