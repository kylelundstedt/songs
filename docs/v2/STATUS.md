# V2 Status

- **Baseline:** Git tag `v1` at commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6` (`546f59b`), not the mutable worktree.
- **Branch/worktree:** branch `v2`, worktree `/home/exedev/songs-v2`.
- **Phase:** Phase 0 — protect the v1 baseline and resolve discovery gates.
- **Completed:** V2 proposal and control plane; TASK-001 deterministic v1 corpus manifest.
- **Current task:** [TASK-002](tasks/TASK-002-renderer-fit-baseline.md), freeze renderer and fit behavior before client work begins.

## Completed evidence

TASK-001 records the tagged corpus in `migration/v2/v1-corpus-manifest.json`:

- 351 Markdown documents: 291 songs and 60 Set Lists;
- 743,078 source bytes;
- 67 declared front-matter IDs;
- 1,484 resolved canonical links;
- 255 explicit `unresolved:` references;
- all records generated from `git archive v1`, never mutable corpus files.

## Verification commands

Run from `/home/exedev/songs-v2`:

```sh
git show -s --format='%H %D %s' v1
python3 -m unittest tests/test_build_v2_baseline.py
python3 scripts/build_v2_baseline.py --check
go test ./...
git diff --check
```

## Next tasks

1. Complete TASK-002 renderer/fit baseline and record physical-device gaps.
2. Capture legacy-route fixtures.
3. Exercise backup and restore.
4. Run sync and atomic-bootstrap feasibility spikes.
5. Perform the Phase 0 exit review and estimate Phase 1 from measured evidence.
