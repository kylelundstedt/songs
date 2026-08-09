# V2 migration artifacts

## V1 corpus baseline

`v1-corpus-manifest.json` is generated only from a fresh `git archive v1` at
commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6`; it never reads the mutable
working-tree `songs/` or `sets/` directories. Records are sorted by path and
rendered as UTF-8 JSON with two-space indentation and one final LF. Newline
styles are `LF`, `CRLF`, `CR`, `mixed`, or `none`.

Each Markdown link retains its authored `target` exactly. Relative targets are
resolved against the tagged file and classified as `resolved canonical file` or
`missing`; `unresolved:*`, URL destinations, and `#anchor` destinations are
classified as `unresolved: reference`, `external URL`, and `anchor`.

Regenerate or verify the checked-in artifact with:

```sh
python3 scripts/build_v2_baseline.py
python3 scripts/build_v2_baseline.py --check
```

The recorded `verification.output_sha256` is the SHA-256 of the canonical JSON
render with that field set to `null`, avoiding a self-referential hash.

## Phase 0 exit observation

`phase-0-exit-review.json` is a bounded, reproducible observation of current
`main` at commit `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5`. It records corpus drift from
`v1`, current identity/link/status counts, and an isolated Apex render check.
It does not replace the immutable v1 artifacts or the current-content baseline
to be frozen by TASK-008.

Regenerate or verify it with:

```sh
python3 scripts/build_v2_phase0_exit_review.py
python3 scripts/build_v2_phase0_exit_review.py --check
```

## Renderer and fit baseline

`renderer/` contains the TASK-002 Apex render corpus, song-only HTML fixtures,
Chromium-emulation fit captures, deterministic fit summary, and screenshots.
Physical Safari/iPad validation remains pending; see `renderer/README.md`.

## V1 route baseline

The TASK-003 HTTP contract is recorded in [`routes/route-baseline.json`](routes/route-baseline.json).

## Backup and restore baseline

TASK-004's deterministic ephemeral backup/restore drill is documented in
[`backup-restore/README.md`](backup-restore/README.md), with checked-in evidence
in [`backup-restore/backup-restore-baseline.json`](backup-restore/backup-restore-baseline.json).

## Sync feasibility spike

TASK-005's isolated durable-operation, SQLite, and local-Git proof is in
[`sync-spike/README.md`](sync-spike/README.md), with deterministic evidence in
[`sync-spike/sync-spike-evidence.json`](sync-spike/sync-spike-evidence.json).

## Atomic bootstrap storage spike

TASK-006's deterministic tagged payload and disposable IndexedDB/browser harness
are in [`bootstrap/README.md`](bootstrap/README.md). Recorded browser observations
are validated separately and do not constitute physical Safari/iPad proof.
