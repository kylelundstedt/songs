# TASK-007: Phase 0 Exit Review

- **Priority:** P0
- **Phase:** 0
- **Status:** Ready

## Objective

Reconcile TASK-001 through TASK-006 into an evidence-based go/no-go decision for the writable V2 implementation. Convert measured findings into a bounded Phase 1 vertical-slice plan, estimates, acceptance gates, and explicit human/device validation requirements.

## Scope

Review:

- corpus identity, route compatibility, renderer/fit evidence, and rollback guarantees;
- backup/restore ordering and future durable-ledger backup requirements;
- sync protocol, publication transaction boundaries, reconciliation, and production hardening gaps;
- atomic browser bootstrap, IndexedDB upgrade/recovery behavior, storage persistence, and eviction risk;
- architecture decisions that remain valid, require revision, or must become production acceptance criteria;
- product assumptions delegated by the owner and decisions requiring confirmation before cutover;
- Phase 1 scope, task decomposition, dependencies, estimates, risk reserve, and checkpoint demonstrations.

Do not begin the production writable client in this task.

## Procedure

1. Re-run every checked-in deterministic generator, Go/Python test, and integrity check.
2. Cross-reference all baselines to exact `v1` and identify contradictions or evidence gaps.
3. Classify each Phase 0 risk as closed, mitigated with a production requirement, blocked on physical/user validation, or deferred with rationale.
4. Update architecture decisions based on measured sync, storage, and recovery findings.
5. Define the Phase 1 read-only vertical slice and the smallest subsequent writable slice.
6. Estimate implementation effort by bounded task rather than one aggregate rewrite estimate.
7. Define objective exit gates for browser, physical iPad, rehearsal, and real-gig checkpoints.
8. Record a go/no-go recommendation and the next authorized task.

## Acceptance criteria

- Every Phase 0 task has reproducible evidence and an explicit conclusion.
- No open architectural contradiction is hidden behind passing tests.
- Production requirements derived from spike limitations are written as acceptance criteria.
- Physical Safari/iPad and user-validation gaps are separated from software feasibility.
- Phase 1 has bounded tasks, dependencies, estimates, demonstrations, and rollback points.
- The recommendation states whether implementation can continue autonomously and where owner/device input becomes mandatory.
- Status, backlog, architecture summary, and decision records agree.

## Verification commands

```sh
python3 -m unittest discover -s tests
go test ./...
go test -race ./internal/syncspike/...
git diff --check
```
