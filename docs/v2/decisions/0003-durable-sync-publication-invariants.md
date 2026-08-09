# Decision 0003: Durable Sync and Publication Invariants

- **Status:** Accepted production requirements derived from Phase 0 evidence
- **Date:** 2026-08-09

## Decision

Production sync must preserve the invariants proven by TASK-005:

- operation identity is `(device ID, operation ID)` plus a canonical payload hash, with production authentication binding the device to an authorized actor;
- pull is read-only and cursors advance only after explicit client acknowledgement;
- base revisions are document-bound and stale edits create durable candidate conflicts;
- publication accepts only eligible current revisions with no open conflict;
- each publication intent records the expected prior published revision and expected Git base;
- commit creation, remote acceptance, SQLite finalization, and acknowledgement are separately recoverable;
- publication is serialized by a fenced multi-process lease and isolated worktree;
- external Git changes require deliberate reconciliation against the database's last imported published revision;
- sidecar identities locate documents but editable sidecar hash claims are not authoritative.

The durable-operation and recovery states above were proven in a single-process spike. The fenced lease, authenticated device binding, and complete external reconciliation are production hardening requirements derived from its limitations.

## Consequences

An in-process mutex, direct Git writes, unacknowledged server cursors, or best-effort audit records are insufficient. Production HTTP/auth/ACL, lease fencing, delete/rename reconciliation, Apex validation, and ledger backup/recovery are hard gates before browser writes.
