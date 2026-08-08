# Decision 0001: Controlled Rewrite

- **Status:** Accepted
- **Date:** 2026-08-08

## Decision

Build V2 as a controlled frontend and synchronization rewrite: a TypeScript local-first PWA alongside a refactored Go service. Preserve the v1 Git tag, canonical Markdown corpus, migration evidence, proven fitter/stage behavior, and rollback routes while migrating incrementally.

## Alternatives rejected

- **Harden v1 in place:** insufficient boundary for durable local revisions, outbox operations, conflicts, and offline authoring.
- **Total rewrite:** discards proven content, rendering, Git history, and migration work while multiplying regression risk.

## Consequences

There will be temporary v1/v2 duplication and parity work. No v2 writable client ships until identity, sync, conflict, Git materialization, and recovery boundaries are tested.
