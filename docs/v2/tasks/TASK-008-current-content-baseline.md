# TASK-008: Freeze Current Content and Refresh Parity Evidence

- **Priority:** P0
- **Phase:** 0 closure
- **Status:** Done
- **Estimate:** 4–7 focused engineering days

## Objective

Create the current-content baseline required for a truthful read-only V2 while preserving tag `v1` and every existing Phase 0 rollback artifact. Resolve the latest `main` into the V2 branch, freeze an exact current commit, and regenerate parity evidence without resurrecting deleted Set Lists or omitting newly added songs.

## Scope

- merge or otherwise reconcile the latest clean `main` into `v2` with explicit conflict review;
- create a named immutable Phase 1 content baseline after reconciliation;
- keep all `v1` artifacts under their existing paths unchanged;
- generate separate current corpus, identity, renderer/fit, route, recovery, and bootstrap evidence;
- classify legacy routes as preserve, redirect, retire, or defer;
- define a separate-origin coexistence plan, or explicitly patch/test the v1 root service worker's bypass and controller handoff before allowing `/v2/`;
- record current Set List lifecycle/status limitations and active-set fallback behavior.

Do not alter canonical content solely to satisfy a test, expose V2 writes, or change default production routes.

## Procedure

1. Resolve latest `main` and record its exact commit before work begins.
2. Reconcile branch history while preserving current canonical additions, modifications, and deletions.
3. Verify current corpus counts, source hashes, links, IDs, and Apex rendering.
4. Generate current browser-fit evidence and identify all fit-floor/failure cases.
5. Regenerate read-only route and recovery evidence against current content/server behavior.
6. Generate the current bootstrap payload and rerun atomic Chromium observations.
7. Produce sidecar identity mappings for every frozen-source document lacking a declared ID and deterministic Set Entry IDs without rewriting Markdown.
8. Add the route policy and V2 coexistence contract. Prefer a separate origin; if `/v2/` is retained, make the root v1 worker bypass V2 and test controller handoff for existing controlled clients.
9. Freeze/tag the exact Phase 1 content baseline and rerun all checks.

## Acceptance criteria

- `v1` still resolves to `546f59b41d9e9bcf0e81b543c27900a31e26c9e6` and all existing v1 artifacts remain byte-identical.
- Current baseline counts and hashes match the reconciled canonical tree exactly.
- Newly added current songs are present and intentionally deleted Set Lists remain absent.
- Current unresolved references, renderer outcomes, fit outcomes, route behavior, recovery, and bootstrap results are recorded.
- Every current document and Set Entry has a stable immutable identity outside preserved legacy bodies where necessary.
- Separate-origin isolation passes, or the root v1 worker explicitly bypasses V2 and controller-handoff tests pass for an already-controlled client, first load, update, and offline restart; manifest, cache, and IndexedDB names remain distinct.
- Route behavior has an explicit preserve/redirect/retire/defer classification.
- The frozen current baseline is suitable as the only input to Phase 1 read-only parity work.

## Completed evidence

- Merged `main` commit `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5` into `v2`; reconciled `songs/`, `sets/`, and `srv/` match that source exactly.
- Created annotated source tag `v2-phase1-content-2026-08-10` at the exact current-main commit; the TASK-008 completion commit is pinned separately by evidence tag `v2-phase1-evidence-2026-08-10`, while `v1` remains unchanged at `546f59b`.
- `migration/v2/current/corpus-manifest.json` freezes 373 documents, 339 songs, 34 Set Lists, and 748,034 source bytes.
- `identity-sidecars.json` preserves 89 declared IDs, adds deterministic sidecars for 284 legacy songs, assigns 1,076 Set Entry IDs from order-independent fingerprints plus duplicate occurrence, and records 373 slug-to-ID routes without rewriting Markdown.
- Apex renders 339/339 songs. Chromium records 339/339 portrait fits, 334/339 landscape fits with five named failures, and 339/339 scrollable phone results.
- The current route baseline covers all 27 registrations through 1,198 requests; route policy classifies 12 preserve, 1 redirect, 1 retire, and 13 defer, with legacy slugs mapped explicitly to immutable sidecar IDs.
- Git bundle plus online SQLite recovery restores 373 files, 339 song rows, 34 Set List rows, focused routes, and five fail-closed cases.
- The 12-chunk current bootstrap passes all 13 logical proofs in three Chromium profiles; persistence remains ungranted and physical Safari/iPad remains pending.
- Separate-origin Chromium evidence exercises the actual frozen v1 worker and a synthetic reserved V2 namespace on another origin; the real V2 shell/public port 8001 remains a P1-004 acceptance test, while no v1 root-worker patch is required for the selected topology.

## Verification commands

```sh
python3 -m unittest discover -s tests
python3 scripts/build_v2_current_baseline.py --check
python3 scripts/build_v2_current_renderer_baseline.py --check
python3 scripts/build_v2_current_browser_fit_baseline.py --check
python3 scripts/build_v2_current_route_baseline.py --check
python3 scripts/build_v2_current_backup_restore_baseline.py --check
python3 scripts/build_v2_current_bootstrap_baseline.py --check
python3 scripts/build_v2_current_bootstrap_browser_summary.py --check
python3 scripts/build_v2_current_contracts.py --check
python3 scripts/build_v2_current_coexistence_summary.py --check
go test ./...
go test -race ./internal/syncspike/...
go vet ./...
git diff --check
git status --short --branch
```
