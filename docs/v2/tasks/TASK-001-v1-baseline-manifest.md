# TASK-001: V1 Baseline Manifest

- **Priority:** P0
- **Phase:** 0
- **Status:** Done

## Objective

Create a deterministic corpus manifest from Git tag `v1` at `546f59b41d9e9bcf0e81b543c27900a31e26c9e6`. The tagged tree is the only input: never read `songs/`, `sets/`, generated output, or rendered fixtures from the mutable worktree.

## Scope

Include every canonical lead sheet and set list in the tagged tree, with repository-relative path, kind, byte size, SHA-256, stable/front-matter ID when present, and links or referenced paths resolved from the tagged content. Record the tag and commit in the manifest header. Reserve fields for approved rendered-fixture references without inventing fixtures in this task.

The output format must be line-oriented and sorted by path (for example, canonical JSON or TSV with a documented header). JSON serialization, field order, newline handling, and hash encoding must be fixed and documented so identical inputs produce identical bytes.

## Procedure

1. Resolve and verify `v1` to `546f59b41d9e9bcf0e81b543c27900a31e26c9e6`.
2. Export the tag to a temporary directory with `git archive v1`; do not use the worktree as corpus input.
3. Enumerate only the agreed canonical content roots and parse links/IDs from those exported bytes.
4. Sort records and write the manifest with a recorded generator version/command.
5. Re-run from a fresh export and compare manifest bytes and record count.

## Acceptance criteria

- The manifest is reproducible byte-for-byte from two fresh `git archive v1` exports.
- The manifest names the exact tag and full commit, and fails if the tag resolves elsewhere.
- Every in-scope tagged document has one record, SHA-256, size, and path; no mutable-worktree file can affect output.
- IDs and links are derived from tagged bytes and unresolved references remain visible rather than silently dropped.
- Verification records the command, record count, and output SHA-256.
- The generator and manifest are reviewed before downstream baseline, renderer, or migration work relies on them.

## Completed artifacts

- `scripts/build_v2_baseline.py`
- `tests/test_build_v2_baseline.py`
- `migration/v2/v1-corpus-manifest.json`
- `migration/v2/README.md`

## Verification command shape

```sh
tmp=$(mktemp -d)
git archive v1 | tar -x -C "$tmp"
# Run the pinned manifest generator against "$tmp".
# Repeat with a second fresh "$tmp" and compare output bytes.
```
