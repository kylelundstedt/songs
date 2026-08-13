# TASK-020: Offline Writable Lead-Sheet Authoring and Enrichment

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Planned after TASK-019
- **Dependencies:** TASK-017 through TASK-019; Apex validation contract
- **Estimate:** To be refined after serializer/preview spike

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
