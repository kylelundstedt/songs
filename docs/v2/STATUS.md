# V2 Status

- **Baseline:** Git tag `v1` at commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6` (`546f59b`), not the mutable worktree.
- **Branch/worktree:** branch `v2`, worktree `/home/exedev/songs-v2`.
- **Phase:** Phase 0 closure — architecture feasible; current-content evidence refresh still required.
- **Completed:** V2 proposal/control plane; TASK-001 through TASK-007, including the conditional Phase 0 exit review.
- **Current task:** [TASK-008](tasks/TASK-008-current-content-baseline.md), reconcile latest `main`, freeze current content, and refresh parity evidence before Phase 1.

## Completed evidence

TASK-001 records the tagged corpus in `migration/v2/v1-corpus-manifest.json`:

- 351 Markdown documents: 291 songs and 60 Set Lists;
- 743,078 source bytes;
- 67 declared front-matter IDs;
- 1,484 resolved canonical links;
- 255 explicit `unresolved:` references;
- all records generated from `git archive v1`, never mutable corpus files.

TASK-002 freezes Apex 1.1.14 and the v1 browser fitter:

- 291/291 tagged songs render successfully with the exact v1 Apex flags;
- four deterministic song-only HTML fixtures cover available renderer features;
- Chromium emulation records 291/291 portrait fits, 289/291 landscape fits, and 291/291 scrollable phone results;
- `can-t-stop` and `paradise-city` are the two landscape `needs-editing` cases;
- physical Safari/iPad validation remains pending and is not inferred from Chromium.

TASK-003 freezes the v1 HTTP and offline route contract:

- all 27 registered routes are classified and covered by fixtures or explicit exclusions;
- 1,158 isolated requests include 1,113 canonical song/Set List route records;
- every canonical family returns 200 for all 291 songs and 60 Set Lists;
- ten destructive or remote executions are excluded, while safe authentication/validation boundaries are recorded;
- v1 edge behavior includes case-sensitive IDs, trailing-slash 404s, encoded-ID resolution, path-cleaning redirects, and a browsable `/static/` directory.

TASK-004 proves clean backup and restoration:

- an exact `v1` Git bundle restores two clean checkouts at `546f59b`;
- SQLite's online backup API captures a running WAL database without copying live DB/WAL files;
- all 351 Markdown files, 291 song-index rows, and 60 Set List rows restore and verify;
- five focused routes match TASK-003 after restore;
- five missing/corrupt/wrong-baseline cases fail closed;
- v1 SQLite is rebuildable cache state, while V2 must protect its future durable ledger and unsynced client drafts.

TASK-005 proves the proposed sync core is feasible with strict conditions:

- 13 device operations produce 15 revisions/events with exact idempotent replay;
- read-only pull plus monotonic acknowledgement survives response loss without cursor regression;
- two conflicts preserve both candidates and resolve durably;
- 20 evidence proofs cover publication eligibility, commit/push/finalization failures, remote drift, external reconciliation, and successful post-reconciliation publication;
- 9 deterministic isolated Git commits preserve legacy bodies and sidecar identity;
- 23 publication attempts and 38 audit events reconstruct the tested transitions;
- production still requires HTTP/auth/ACL, a multi-process publication lease, Apex validation, and explicit delete/rename reconciliation.

TASK-006 proves atomic full-library browser bootstrap in Chromium:

- a 12-chunk deterministic payload contains all 351 documents and 743,078 source bytes;
- 13 logical proofs pass in portrait, landscape, and phone profiles;
- interrupted/corrupt staging never changes the prior active pointer or pending local work;
- IndexedDB v1→v2 upgrade preserves outbox/drafts and adds conflicts;
- successful activation changes one pointer once, retains rollback data, and verifies all document hashes;
- local-loopback bootstrap measured 90.5–117 ms with roughly 10 GiB reported headroom;
- Chromium did not grant persistent storage, and physical Safari/iPad eviction/background behavior remains unverified.

TASK-007 completed the exit review with a conditional go:

- the controlled rewrite and isolated read-only PWA remain approved;
- current `main` at review commit `17c326c` contains 339 songs and 34 Set Lists, so the `v1` payload is rollback evidence rather than a truthful current-content source;
- TASK-008 must reconcile and freeze current content before Phase 1 parity work;
- Phase 1 software is estimated at 23–39 focused engineering days after the 4–7 day current-baseline closure;
- writable production use remains blocked on authorization, a fenced publication lease, Apex validation, durable V2 recovery, and physical Safari/iPad gates;
- detailed findings and plans are in `docs/v2/PHASE-0-EXIT-REVIEW.md` and `docs/v2/PHASE-1-PLAN.md`.

## Verification commands

Run from `/home/exedev/songs-v2`:

```sh
git show -s --format='%H %D %s' v1
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
go test ./internal/syncspike/...
go test ./...
go vet ./...
git diff --check
```

## Next tasks

1. Complete TASK-008 current-content reconciliation and baseline refresh.
2. Begin Phase 1 P1-002 typed read model/identity projection from the frozen current baseline.
3. Continue autonomously through the Phase 1 software checkpoint.
4. Require owner/physical-iPad participation before stage-readiness, writable work, or cutover.
