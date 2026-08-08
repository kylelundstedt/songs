# V2 Status

- **Baseline:** Git tag `v1` at commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6` (`546f59b`), not the mutable worktree.
- **Branch/worktree:** branch `v2`, worktree `/home/exedev/songs-v2`.
- **Phase:** Phase 0 — protect the v1 baseline and resolve discovery gates.
- **Completed:** V2 proposal and control plane; TASK-001 deterministic v1 corpus manifest; TASK-002 renderer and browser-fit baseline.
- **Current task:** [TASK-003](tasks/TASK-003-legacy-route-baseline.md), freeze the public and offline route contract before v2 routing work.

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

## Verification commands

Run from `/home/exedev/songs-v2`:

```sh
git show -s --format='%H %D %s' v1
python3 -m unittest discover -s tests
python3 scripts/build_v2_baseline.py --check
python3 scripts/build_v2_renderer_baseline.py --check
python3 scripts/build_v2_browser_fit_baseline.py --check
go test ./...
git diff --check
```

## Next tasks

1. Complete TASK-003 legacy-route baseline.
2. Exercise backup and restore.
3. Run sync and atomic-bootstrap feasibility spikes.
4. Perform the Phase 0 exit review and estimate Phase 1 from measured evidence.
