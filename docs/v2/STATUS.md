# V2 Status

- **Rollback baseline:** Git tag `v1` at commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6` (`546f59b`).
- **Phase 1 content source:** annotated tag `v2-phase1-content-2026-08-10` at `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5` (`17c326c`).
- **Phase 1 evidence package:** annotated tag `v2-phase1-evidence-2026-08-10` at the TASK-008 completion commit.
- **Branch/worktree:** branch `v2`, worktree `/home/exedev/songs-v2`.
- **Phase:** Phase 1 — isolated read-only vertical slice; physical Safari/iPad acceptance remains pending.
- **Completed:** V2 proposal/control plane and TASK-001 through TASK-011.
- **Current task:** [TASK-012](tasks/TASK-012-production-indexeddb-snapshot.md), integrate retained, atomic production IndexedDB snapshot activation.

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

TASK-008 froze current content and cleared the software prerequisite for Phase 1:

- current `main` was merged without conflict and frozen as annotated tag `v2-phase1-content-2026-08-10` at `17c326c`;
- current evidence contains 373 documents, 339 songs, 34 Set Lists, and 748,034 source bytes;
- lossless sidecars cover 284 legacy songs, all 1,076 Set Entries through order-independent fingerprints, and 373 legacy slug routes while canonical Markdown remains unchanged;
- Apex renders 339/339 songs; Chromium records 339 portrait fits, 334 landscape fits plus five named failures, and 339 scrollable phone results;
- 27 routes are covered through 1,198 requests and have explicit preserve/redirect/retire/defer policy;
- current recovery and 12-chunk bootstrap evidence pass, including all 13 logical browser proofs;
- separate-origin Chromium evidence exercises the actual frozen v1 worker and a synthetic V2 namespace reservation; the real V2 shell/public port is still a P1-004 gate;
- source tag `v2-phase1-content-2026-08-10` and evidence tag `v2-phase1-evidence-2026-08-10` are now the only authorized Phase 1 inputs.

TASK-009 completed the typed read-model foundation:

- `@songs-v2/read-model` verifies annotated tags and imports only pinned Git objects, with replacement objects disabled;
- all 373 documents, 36 frozen-snapshot section projections, 1,076 Set Entries, 373 slug routes, and 748,034 canonical bytes project deterministically;
- exact source text/base64, complete front matter, every Set List body line, identity source, annotation, fingerprint occurrence, and resolved target are retained;
- source targets are independently resolved from Markdown and checked against manifest, sidecar, and actual lead-sheet identity;
- deterministic full-corpus and representative fixtures pass nine TypeScript tests, including hostile archive, YAML, target, source, and identity cases;
- the package is ready for TASK-010's generated manifest/chunk API and does not add rendering, mutation, sync, publication, or route-cutover behavior.

TASK-010 completed the isolated read-only API:

- generation is anchored to reviewed TASK-009 commit `2cbf78a` and reads only pinned TASK-008 source/evidence commits;
- 12 deterministic chunks contain all 373 typed projections, 1,076 Set Entries, canonical source bytes, 339 verified Apex outputs, three fit profiles per lead sheet, and 373 slug routes;
- manifest SHA `a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f` and generation `phase1-f9634173e25ef4ca4b8330a3` are reviewed runtime trust anchors;
- TypeScript and Go reject fully re-signed semantic substitutions plus missing, unexpected, corrupt, duplicate, reordered, unsupported, or noncanonical assets;
- `cmd/v2api` preloads embedded bytes and serves authenticated JSON-only manifest/chunk routes without Node, Git, Apex, filesystem, or importer work per request;
- `songs-v2-api.service` runs separately on port 8001, while the frozen v1 `srv/` tree and default routes remain byte-identical to TASK-008.

TASK-011 completed the isolated read-only shell:

- deterministic React/Vite release `shell-72d3106d38dfec5cc2eaf403` is bound to the reviewed TASK-010 manifest and embedded behind a strict Go asset inventory/trust anchor;
- all 373 documents remain hidden until the browser verifies the manifest, 12 chunks, sources, Apex outputs, fit records, routes, entries, and exact counts;
- read-only library, lead-sheet, Set List, status, loading, authentication, corruption, offline, update, and not-found surfaces expose no renderer or mutation controls;
- the worker controls only the isolated origin, caches only `songs-v2-shell-*`, bypasses the private API, and opens no IndexedDB database before TASK-012;
- the origin binds loopback-only; the public port-8001 proxy provides TLS 1.3/private login and does not pass forged unauthenticated identity headers;
- ten browser-unit/integration tests and three Chromium profile captures cover accessibility, focus, contrast, responsive overflow, Apex semantics/links, corruption races, auth redirects, and namespace isolation;
- browser evidence is recorded under `migration/v2/phase1/shell/`; physical Safari/iPad acceptance remains pending.

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
python3 scripts/build_v2_current_baseline.py --check
python3 scripts/build_v2_current_renderer_baseline.py --check
python3 scripts/build_v2_current_browser_fit_baseline.py --check
python3 scripts/build_v2_current_route_baseline.py --check
python3 scripts/build_v2_current_backup_restore_baseline.py --check
python3 scripts/build_v2_current_bootstrap_baseline.py --check
python3 scripts/build_v2_current_bootstrap_browser_summary.py --check
python3 scripts/build_v2_current_contracts.py --check
python3 scripts/build_v2_current_coexistence_summary.py --check
npm --prefix v2 ci
make v2-check
make v2-api-build
go test ./internal/syncspike/...
go test -race ./internal/v2bootstrap/... ./internal/v2shell/...
go test ./...
go vet ./...
git diff --check
```

## Next tasks

1. Build TASK-012's retained, atomic production IndexedDB snapshot activation.
2. Add offline library/search/status behavior over the activated local snapshot.
3. Continue autonomously through the Phase 1 software checkpoint.
4. Require owner/physical-iPad participation before stage-readiness, writable work, or cutover.
