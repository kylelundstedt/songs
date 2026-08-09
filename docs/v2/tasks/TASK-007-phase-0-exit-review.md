# TASK-007: Phase 0 Exit Review

- **Priority:** P0
- **Phase:** 0
- **Status:** Done — conditional go; Phase 0 remains open for TASK-008 current-baseline closure

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

## Completed evidence

- `docs/v2/PHASE-0-EXIT-REVIEW.md` records the evidence matrix, risk disposition, architecture corrections, product defaults, and go/no-go decision.
- `docs/v2/PHASE-1-PLAN.md` defines one current-baseline prerequisite plus eight read-only delivery packets, rollback points, model routing, and a 23–39 focused-engineering-day Phase 1 software range.
- `migration/v2/phase-0-exit-review.json` mechanically pins the current-main observation, corpus/diff/link/identity counts, and 339-song Apex result to commit `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5`.
- The review therefore keeps `v1` as rollback evidence but rejects it as the user-visible Phase 1 content source.
- The controlled rewrite and read-only slice receive a conditional go; writable production use, Safari/iPad readiness claims, root-route changes, and cutover remain no-go.
- Decisions 0003–0006 capture derived sync/publication requirements, atomic browser snapshot requirements, the conditional Phase 0 exit, and delegated product defaults.
- TASK-008 is the mandatory next task; physical owner/device input is not required until the later pilot gate.

## Verification commands

```sh
python3 -m unittest discover -s tests
python3 scripts/build_v2_baseline.py --check
python3 scripts/build_v2_renderer_baseline.py --check
python3 scripts/build_v2_browser_fit_baseline.py --check
python3 scripts/build_v2_route_baseline.py --check
python3 scripts/build_v2_backup_restore_baseline.py --check
python3 scripts/build_v2_sync_spike_evidence.py --check
python3 scripts/build_v2_bootstrap_baseline.py --check
python3 scripts/build_v2_bootstrap_browser_summary.py --check
python3 scripts/build_v2_phase0_exit_review.py --check
go test ./...
go test -race ./internal/syncspike/...
go vet ./...
git diff --check
```
