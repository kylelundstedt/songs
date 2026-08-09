# Decision 0004: Atomic Browser Snapshots and Evictable Storage

- **Status:** Accepted production requirements derived from Phase 0 evidence
- **Date:** 2026-08-09

## Decision

Browser domain data is stored in versioned IndexedDB generations. Bootstrap stages and verifies chunks without changing the active generation. Activation occurs through one transaction that retains the prior complete snapshot, marks the new snapshot active, and changes one active-generation pointer.

The TASK-006 v1→v2 test proved that drafts and outbox operations survived while the conflicts store was introduced. Production migrations must extend that rule so every existing pending draft, outbox operation, and conflict survives future snapshot activation and schema upgrades.

The application must treat browser storage as potentially evictable. It requests persistence where available but never labels data durable merely because quota is large or `persist()` was requested.

## Consequences

Incomplete or corrupt generations cannot activate. Retry and orphan cleanup never remove active content or pending writes. The UI must expose completeness, freshness, persistence, and recovery status. Unsynced work needs an emergency export/recovery path before writable offline use.
