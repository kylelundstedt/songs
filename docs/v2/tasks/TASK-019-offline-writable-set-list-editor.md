# TASK-019: Offline Writable Set List Editor and Outbox

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Complete (August 14, 2026)
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

## Completion evidence

- IndexedDB schema v3 additively preserves reviewed snapshots and legacy pending
  records while adding immutable authored revisions and durable sync state.
- The typed Set List domain persists stable set/section/entry identities in
  canonical Markdown comments, preserves duplicate occurrences, and implements
  atomic create, duplicate, metadata, add/remove/reorder, note, and forward-
  revision undo semantics.
- Every local command commits its draft, immutable revision, and exact retry
  envelope in one transaction; unattempted envelopes may coalesce while sent or
  failed envelopes remain byte-stable.
- Foreground-only sync registers a durable browser device, restores authoritative
  current/published mappings, persists pull results before acknowledgement, and
  retains retryable publication reservations and conflicts visibly.
- Hashed authored-state export/restore excludes device credentials and restores
  drafts, revisions, outbox, conflicts, cursor state, and opaque prior pending
  records transactionally.
- Locked Live continues to use the reviewed/published snapshot and never consumes
  local drafts; the editor labels local, server, conflict, and protected
  published state separately.
- `cmd/v2publisher -mode=bootstrap` installs the complete reviewed 373-document
  sync/publication baseline before writable deployment, including digit-leading
  frozen identities.
- Browser authoring requires both `-sync-enabled` and `-writable-enabled`; both
  default false and the tracked service remains read-only.
- Deterministic evidence is in `migration/v2/writable-set-lists/` (SHA-256
  `39d6b8443391a6933330d20880ec006b5948cb35e229c093ff12e96eb6e64a33`)
  and is checked by `make v2-writable-set-list-check`.

## Rollback

Disable writable controls and sync submission while preserving/exporting local
outbox and conflict state; read-only V2 and V1 remain available.
