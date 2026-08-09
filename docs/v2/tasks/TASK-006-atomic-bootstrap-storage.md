# TASK-006: Atomic Bootstrap and Browser Storage

- **Priority:** P1
- **Phase:** 0
- **Status:** Done (Chromium observations recorded; physical Safari/iPad validation pending)

## Objective

Prove that the complete tagged library can be downloaded, staged, verified, and activated atomically in browser storage without losing the previous snapshot or pending local work when the network, tab, or upgrade is interrupted.

## Scope

Build a disposable browser harness—not the production React client—covering:

- a versioned bootstrap manifest and chunked payload for all 291 songs and 60 Set Lists;
- IndexedDB stores for snapshots, documents, metadata, pending operations, and activation state;
- stage/verify/activate transaction boundaries;
- interrupted download, checksum failure, tab close/reopen, and retry behavior;
- schema upgrade with pending outbox/draft preservation;
- active-snapshot rollback and orphaned-stage cleanup;
- service-worker shell/version interaction where necessary to prove bootstrap behavior;
- payload size, IndexedDB usage estimate, bootstrap duration, and quota headroom;
- Chromium browser measurements plus explicit physical Safari/iPad gaps.

Do not begin the production UI rewrite or claim Chromium emulation proves Safari/iPad storage behavior.

## Procedure

1. Generate a deterministic bootstrap payload only from tag `v1` and TASK-001 identities/hashes.
2. Serve a minimal isolated harness and payload from a temporary local origin.
3. Stage documents in bounded chunks with per-chunk and whole-snapshot verification.
4. Activate a complete snapshot with one durable pointer transition.
5. Inject interruption and corruption at multiple chunk boundaries and prove the previous active snapshot remains readable.
6. Seed pending local operations/drafts, perform a schema upgrade, and prove they survive activation and reopen.
7. Retry and clean orphaned staging data without touching active content.
8. Measure bootstrap timing and storage use across tablet portrait, tablet landscape, and phone profiles.
9. Record quota APIs and browser-engine limitations without extrapolating to physical Safari.

## Acceptance criteria

- The payload contains exactly 351 documents and matches TASK-001 hashes byte-for-byte.
- No incomplete or corrupt snapshot can become active.
- Interrupted bootstrap leaves the prior active snapshot and pending local writes intact after reopen.
- Retrying an interrupted generation is idempotent and removes obsolete staging data safely.
- Schema upgrade preserves drafts, outbox operations, active generation, and conflict placeholders.
- Activation is represented by one transactional active-generation pointer change.
- Measured browser storage use has substantial headroom relative to the reported quota.
- Machine-readable evidence is deterministic; runtime timing/quota measurements are clearly identified as recorded observations.
- Physical Safari/iPad quota, eviction, background suspension, and persistence tests remain explicit acceptance gaps.

## Completed evidence

- A deterministic 12-chunk payload contains all 351 tagged documents and 743,078 source bytes.
- Generation `v1-6d7881af4c153b3b4555f87c` and its snapshot digest derive from exact paths, hashes, and source bytes.
- All 13 logical bootstrap proofs pass in Chromium at tablet portrait, tablet landscape, and phone profiles.
- Interrupted and checksum-failed stages leave the prior active snapshot, pointer, outbox, draft, and conflict placeholder intact.
- V1→V2 IndexedDB upgrade adds only the conflict store and preserves pending writes.
- Successful activation changes the active-generation pointer exactly once, retains the prior snapshot for rollback, and makes all 351 verified documents readable.
- A repeated bootstrap is idempotent with no second pointer transition; orphan staging data is removed without touching active or pending state.
- Local-loopback full bootstrap measured 90.5–117 ms; these timings do not represent production network latency.
- Chromium reported approximately 10 GiB of headroom, over 14,000× the tagged source size, but did not grant persistent storage in any profile.
- Versioned service-worker shell cache `v2-bootstrap-shell-3` registered successfully; payload remained network-only for corruption testing.
- Physical Safari/iPad quota, eviction, persistence, background suspension, and reopen validation remain pending.

## Verification commands

The implementation should provide focused commands shaped like:

```sh
python3 scripts/build_v2_bootstrap_baseline.py
python3 scripts/build_v2_bootstrap_baseline.py --check
python3 scripts/build_v2_bootstrap_browser_summary.py
python3 scripts/build_v2_bootstrap_browser_summary.py --check
python3 -m unittest tests/test_build_v2_bootstrap_baseline.py tests/test_build_v2_bootstrap_browser_summary.py
```
