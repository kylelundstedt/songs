# TASK-005: Sync Feasibility Spike

- **Priority:** P0
- **Phase:** 0
- **Status:** Done

## Objective

Prove or disprove the proposed durable operation-ledger and Git-materialization model before building the writable browser client. The spike must demonstrate two independent devices, idempotent retries, explicit conflicts, and recoverable publication failures.

## Scope

Build a minimal disposable Go/SQLite prototype covering:

- immutable document and revision IDs plus per-device operation IDs;
- pull cursors and ordered server operation sequence numbers;
- idempotent push, duplicate retry, and partially repeated batches;
- optimistic base-revision checks and preserved conflict records;
- independent edits from two simulated devices, including non-conflicting and conflicting cases;
- validated Markdown materialization into an isolated Git repository;
- external Git edit detection and deliberate reconciliation;
- commit-success/push-failure recovery without losing acknowledged operations;
- audit evidence sufficient to reconstruct every accepted transition.

Do not expose a production API, modify the canonical corpus, push to a real remote, or build the React client in this task.

## Procedure

1. Define the smallest protocol and schema capable of representing documents, revisions, operations, device cursors, conflicts, and publication attempts.
2. Initialize an isolated bare Git remote and working repository with representative v1 fixtures.
3. Simulate two devices pulling a common revision and submitting operations with stable operation IDs.
4. Retry full and partial batches and prove exactly-once state transitions.
5. Exercise divergent edits, conflict visibility, conflict resolution, and ordered pull continuation.
6. Materialize accepted publication state to Markdown and Git with stable identity preserved outside legacy bodies.
7. Inject external Git changes, validation failure, commit failure, and remote push failure.
8. Recover each failure without losing acknowledged operations or silently overwriting published content.
9. Record measured behavior, schema/protocol decisions, rejected alternatives, and remaining risks.

## Acceptance criteria

- Replaying an accepted operation or batch does not create a second revision or Git commit.
- Two devices can pull ordered changes using durable cursors and resume after interruption.
- Divergent same-base edits produce an explicit conflict containing both candidate revisions.
- A resolved conflict produces a new revision without deleting conflict history.
- Git materialization is deterministic and never rewrites preserved legacy source bodies merely to add identity.
- External Git changes are detected and reconciled deliberately rather than silently overwritten.
- A failed remote push leaves a durable retryable publication record; retry reaches the expected remote commit exactly once.
- Validation or Git failures never discard accepted application operations.
- The prototype and evidence are deterministic, isolated, tested, and disposable.

## Completed evidence

- `internal/syncspike` implements the disposable SQLite ledger and isolated Git materializer with no HTTP surface.
- Thirteen device operations produce 15 durable revisions/events with exact full and partial replay behavior.
- Read-only pulls plus monotonic cursor acknowledgements recover safely from a lost response.
- Two conflicts preserve candidates and both resolve without deleting history.
- Twenty publication/reconciliation proofs cover eligibility, validation, commit failure, push rejection, remote-accepted/finalization-loss repair, old-publication acknowledgement, remote drift, reconciliation, and post-reconciliation publication.
- Nine deterministic isolated Git commits include two external commits; submitted legacy bodies remain byte-identical and identity remains in sidecars.
- SQLite records 23 publication attempts and 38 reconstructable audit events and passes full integrity/foreign-key checks.
- The architecture is feasible only if the demonstrated CAS, cursor acknowledgement, durable retry state, isolated Git worktree, reconciliation gate, and production-grade publication lease remain first-class components.
- HTTP/auth/ACL, distributed locking, external delete/rename reconciliation, Apex parity, and automatic merging remain outside this spike.

## Verification commands

The implementation should provide focused commands shaped like:

```sh
go test ./internal/syncspike/...
python3 scripts/build_v2_sync_spike_evidence.py
python3 scripts/build_v2_sync_spike_evidence.py --check
```
