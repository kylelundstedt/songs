# V2 Status

- **Baseline:** Git tag `v1` at commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6` (`546f59b`), not the mutable worktree.
- **Branch/worktree:** branch `v2`, worktree `/home/exedev/songs-v2`.
- **Phase:** Phase 0 — protect the v1 baseline and resolve discovery gates.
- **Completed:** V2 proposal/control plane; TASK-001 corpus; TASK-002 renderer/fit; TASK-003 routes; TASK-004 recovery; TASK-005 sync feasibility.
- **Current task:** [TASK-006](tasks/TASK-006-atomic-bootstrap-storage.md), measure full-library browser bootstrap, atomic activation, interruption recovery, and storage headroom.

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
go test ./internal/syncspike/...
go test ./...
git diff --check
```

## Next tasks

1. Complete TASK-006 atomic bootstrap and browser-storage measurements.
2. Perform the Phase 0 exit review and estimate Phase 1 from measured evidence.
3. Schedule physical Safari/iPad and rehearsal validation before writable-client cutover.
