# Frozen Phase 1 current-content baseline

- **Source tag:** `v2-phase1-content-2026-08-10`
- **Source commit:** `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5`
- **Evidence tag:** `v2-phase1-evidence-2026-08-10` (TASK-008 completion commit)
- **Frozen:** August 10, 2026

The source tag freezes canonical content and the current v1 server only. The
separate evidence tag freezes this directory, identity sidecars, decisions, and
generators. Together they are the only authorized content/evidence input for
the Phase 1 read-only V2 slice. Existing `v1` rollback artifacts remain
independent and unchanged.

## Measured corpus and identity

- 373 documents: 339 songs and 34 Set Lists;
- 748,034 canonical source bytes;
- 89 declared document IDs and 284 lossless legacy-song sidecar IDs;
- 1,076 stable Set Entry sidecar IDs derived from set ID plus order-independent
  entry fingerprint/duplicate occurrence, with ordinal stored separately;
- 373 explicit legacy slug-to-immutable-ID route mappings;
- 1,076 resolved Set Entries and zero explicit unresolved entries;
- canonical Markdown bytes are unchanged by identity generation.

Artifacts:

- `corpus-manifest.json`
- `identity-sidecars.json`

## Renderer and browser fit

Apex 1.1.14 renders 339/339 songs. Recorded Chromium outcomes are:

- portrait: 339/339 `fit`;
- landscape: 334 `fit`, with `can-t-stop`, `father-of-mine`, `love-shack`,
  `paradise-city`, and `troublemaker` marked `needs-editing` at the 16px floor;
- phone: 339/339 `scrollable` at 20px in one column.

These are Chromium observations, not physical Safari/iPad proof.

See [`renderer/README.md`](renderer/README.md).

## Routes and policy

The exact current server exposes the same 27 registered routes. The current
capture contains 1,198 requests, including 1,153 canonical document requests.
The policy classifies all routes: 12 preserve, 1 redirect, 1 retire, and 13
defer. Redirects are policy targets only; v1 remains the default origin.

See [`routes/README.md`](routes/README.md).

## Recovery

The current tag and online SQLite index restore into two clean checkouts. All
373 files, 339 song-index rows, 34 Set List rows, focused routes, and five
fail-closed cases verify.

See [`backup-restore/README.md`](backup-restore/README.md).

## Atomic bootstrap

The current payload contains 12 chunks, 373 documents, and 748,034 source bytes.
All 13 logical proofs pass in portrait, landscape, and phone Chromium profiles.
Successful activation measured 94.3–128.4 ms on loopback. Browser persistence
was not granted in any profile; physical Safari/iPad storage behavior remains
pending.

See [`bootstrap/README.md`](bootstrap/README.md).

## Separate-origin coexistence

Parallel deployment selects v1 at the default origin and reserves explicit port
8001 for the opt-in V2 pilot. Chromium loopback evidence exercises the actual
frozen v1 worker on one origin and a synthetic V2 cache/IndexedDB namespace
reservation on another. This proves the partitioning mechanism and that no v1
root-worker patch is required; the real V2 shell and public port 8001 remain
P1-004 acceptance tests.

See [`coexistence/README.md`](coexistence/README.md).

## Regenerate or verify

```sh
python3 scripts/build_v2_current_baseline.py --check
python3 scripts/build_v2_current_renderer_baseline.py --check
python3 scripts/build_v2_current_browser_fit_baseline.py --check
python3 scripts/build_v2_current_route_baseline.py --check
python3 scripts/build_v2_current_backup_restore_baseline.py --check
python3 scripts/build_v2_current_bootstrap_baseline.py --check
python3 scripts/build_v2_current_bootstrap_browser_summary.py --check
python3 scripts/build_v2_current_contracts.py --check
python3 scripts/build_v2_current_coexistence_summary.py --check
```
