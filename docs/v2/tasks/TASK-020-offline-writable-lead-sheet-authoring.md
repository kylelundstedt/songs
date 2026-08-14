# TASK-020: Offline Writable Lead-Sheet Authoring and Enrichment

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Completed 2026-08-14
- **Dependencies:** TASK-017 through TASK-019; Apex validation contract
- **Estimate:** Completed in one focused implementation cycle

## Objective

Bring the product's lead-sheet authoring workflows into the local-first V2 model:
create/edit source and metadata offline, preserve legacy Markdown exactly when
untouched, preview safely, and turn provider/Shelley suggestions into local
reviewable drafts rather than direct publication.

## Scope

- create lead sheets and edit source plus validated metadata;
- losslessly preserve unknown fields, ordering, comments, quoting, and untouched
  body bytes;
- provide local draft validation and preview with explicit distinction from
  authoritative server/Apex validation;
- support undo, autosave, close/reopen recovery, durable outbox, export/restore,
  explicit sync, conflicts, and publication states;
- add existing lyrics-provider search/import and Shelley assistance as explicitly
  online actions that create local drafts for review;
- support adding a local lead-sheet draft to a Set List while clearly labeling
  local-stage-ready, server-validated, and published states;
- keep provisional functional UI; defer the product-wide visual redesign to
  TASK-022.

## Excluded

- silent generic-YAML rewriting of historical files;
- provider or AI output publishing without owner review;
- collaboration roles beyond the first owner workflow;
- printing/spreadsheet export;
- default-route cutover or V1 retirement.

## Acceptance criteria

- untouched historical bytes remain unchanged after view/edit workflows;
- offline create/edit survives restart and restores from exported authored state;
- local preview limitations are explicit and server/Apex validation gates
  publication;
- provider/Shelley failures never discard the local draft or block core offline
  authoring;
- conflicts retain both local and remote revisions without whole-document
  last-write-wins;
- local/server/published readiness is always visible and never collapsed into
  an ambiguous `Ready` state.

## Rollback

Disable lead-sheet mutation/enrichment controls while preserving/exporting every
local draft, outbox operation, and conflict. Keep Set List editing, read-only V2,
and V1 available according to their independent gates.

## Completion

Completed on August 14, 2026.

- A byte-first lead-sheet domain opens all 339 reviewed sources without drift and
  surgically patches managed scalar spans while preserving unknown YAML,
  ordering, comments, quoting, hard-break spaces, and untouched body bytes.
- Valid source revisions share TASK-019's immutable revision/outbox/sync model;
  invalid intermediate source is separately CAS-saved as a durable workspace.
- Local approximation, sync acceptance, exact-source server/Apex receipts,
  conflicts, and publication mappings remain distinct readiness states.
- Provider and Shelley endpoints are authenticated, bounded, same-origin,
  disabled independently, and return review candidates only; neither endpoint
  can write sync state, Git, or publication state.
- New and reviewed lead sheets edit offline, undo through forward revisions,
  survive export/restore, and appear in the local Songs recovery list. Set Lists
  may reference local authored lead sheets with explicit readiness labels.
- Server and browser write gates are independent for Set Lists and lead sheets;
  all writing/enrichment defaults remain disabled and the tracked service stays
  read-only.
- Deterministic evidence is in `migration/v2/writable-lead-sheets/` at SHA-256
  `1743d4bebde58de9165525259b47dc2399b651a2a6e742768e8bbccb2a51ece6`;
  embedded release `shell-ffe70456e479eb1529d157f0` contains the gated UI.
