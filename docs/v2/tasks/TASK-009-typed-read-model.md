# TASK-009: Typed Read Model and Frozen Identity Projection

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Done on August 10, 2026
- **Estimate:** 2–4 focused engineering days

## Objective

Implement the production TypeScript read model that consumes TASK-008's frozen
corpus and identity sidecars without rewriting canonical Markdown. Establish
lossless typed projections for every document, Set section, and Set Entry before
the read-only bootstrap API and React client are built.

## Scope

- define typed `LeadSheet`, `SetList`, `SetSection`, and `SetEntry` projections;
- read canonical Markdown bytes only from `git archive v2-phase1-content-2026-08-10`; load manifest/identity contracts only from evidence tag `v2-phase1-evidence-2026-08-10` (`migration/v2/current/`);
- preserve declared IDs and sidecar IDs exactly;
- parse current Set headings, links, singer/note annotations, and source metadata
  without changing canonical bytes;
- fail on missing/duplicate IDs, missing targets, or source-hash drift;
- produce deterministic fixtures and import reports for all 373 documents and
  1,076 Set Entries.

Do not add a browser mutation path, local Markdown rendering authority, sync
submission, Git publication, or route cutover.

## Acceptance criteria

- all 373 frozen documents and 1,076 Set Entries project exactly once;
- repeated imports retain identical immutable IDs and ordering;
- every resolved Set Entry points to the correct typed lead-sheet ID;
- canonical source hashes and bytes remain unchanged;
- parser failures are typed and never silently drop source content;
- deterministic TypeScript tests cover representative legacy and current files;
- the resulting package is suitable for the versioned read-only bootstrap API.

## Completed evidence

- `v2/packages/read-model` defines immutable TypeScript projections and a Node-only Git import adapter while keeping rendering and mutation out of scope;
- both annotated tag objects and peeled commits are verified, replacement objects are disabled, contracts are read from the pinned evidence commit, and canonical bytes are read only through `git archive` of the pinned source commit;
- all 373 documents, 339 lead sheets, 34 Set Lists, 36 frozen-snapshot Set section projections, 1,076 Set Entries, 373 slug routes, and 748,034 source bytes project exactly once;
- canonical UTF-8 text and base64 bytes round-trip exactly, every Set List body line is retained, and strict failsafe YAML preserves lexical scalars and unknown metadata;
- Set Entry target paths are independently resolved from Markdown and checked against both manifest links and sidecars before immutable lead-sheet IDs are accepted;
- deterministic fixtures include a complete import report and representative legacy, declared-ID, and three-section projections;
- nine TypeScript tests cover full-corpus determinism plus hostile source, identity, target, YAML, archive, and tag-baseline failures;
- adversarial architecture and code reviews found no remaining material issues.
