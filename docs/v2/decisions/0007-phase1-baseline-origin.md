# Decision 0007: Frozen Phase 1 Baseline and Separate Pilot Origin

- **Status:** Accepted
- **Date:** 2026-08-10

## Decision

Use annotated source tag `v2-phase1-content-2026-08-10` at
`17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5` as the immutable canonical source
for the Phase 1 read-only slice. Use annotated evidence tag
`v2-phase1-evidence-2026-08-10` to freeze `migration/v2/current/`, identity
sidecars, generators, and TASK-008 decisions. Together they are the only
authorized Phase 1 inputs. Tag `v1` remains the independent rollback oracle.

Run the parallel V2 pilot on the separate origin
`https://kgl-songs.exe.xyz:8001/` while v1 remains at the default origin. V2
reserves cache prefix `songs-v2-shell-` and IndexedDB name `songs-v2`.

## Consequences

The v1 root service worker cannot control the V2 pilot origin and requires no
Phase 1 modification. Chromium TASK-008 evidence exercises the actual frozen v1
worker and a synthetic V2 namespace reservation; P1-004 must still validate the
real V2 shell and public port 8001. Default routes do not change. If V2 must
later move under `/v2/`, deployment is blocked until root-worker bypass and
controller-handoff tests pass.

The current Chromium fit baseline is an implementation gate: 339 portrait fits,
334 landscape fits plus five explicit `needs-editing` songs, and 339 scrollable
phone results. Physical Safari/iPad acceptance remains pending.
