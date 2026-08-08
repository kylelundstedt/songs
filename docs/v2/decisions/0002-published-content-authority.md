# Decision 0002: Published Content Authority

- **Status:** Accepted
- **Date:** 2026-08-08

## Decision

Git remains the authoritative **published archive**. After V2 cutover, the application is the sole automated writer of published Markdown. Direct external Git edits are not silently merged into live state; a deliberate reconciliation command must match stable IDs, validate lossless parsing, compare against the last imported published revision, create conflicts when needed, and record the source commit and actor.

The browser's IndexedDB is authoritative only for its local operational state, drafts, revisions, and queued operations until synchronization and publication complete.

## Consequences

Published content remains portable, inspectable, and reviewable in Git. The service needs durable operation/audit state, a Git materializer, external-change reconciliation, and retryable failed-push handling before writable V2 clients ship.
