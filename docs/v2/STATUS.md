# V2 Status

- **Rollback baseline:** Git tag `v1` at commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6` (`546f59b`).
- **Phase 1 content source:** annotated tag `v2-phase1-content-2026-08-10` at `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5` (`17c326c`).
- **Phase 1 evidence package:** annotated tag `v2-phase1-evidence-2026-08-10` at the TASK-008 completion commit.
- **Branch/worktree:** branch `v2`, worktree `/home/exedev/songs-v2`.
- **Phase:** Phase 1 read-only checkpoint is complete; post-Phase-1 writable foundation is now active.
- **Completed:** V2 proposal/control plane and TASK-001 through TASK-020.
- **Current task:** TASK-021 physical iPad writable acceptance and owner signoff; software implementation is complete.
- **Product sequence:** writable functionality (TASK-017–021), then owner-led web design overhaul (TASK-022), then deferred print/export (TASK-023/024).
- **Checkpoint status:** Software PASS; G1–G3 pass on the approved iPad, G4 has deferred blocking checks, and G5 operational checks pass with optional VoiceOver not required. G6/G7 are optional and not planned. Not writable or cutover-approved.

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

TASK-012 completed production atomic browser snapshots:

- `songs-v2` schema v2 preserves TASK-006's seven V2 stores and additive pending-state upgrade contract;
- manifest, chunks, document artifacts, Apex/fit/routes, and logical snapshot hashes are reverified from durable bytes before activation or reopen;
- one active physical instance and transition epoch form the CAS authority; prior verified content is retained, accepted predecessors recover offline, stale-shell/ABA downgrades fail, and cleanup removes only unreachable current-epoch content;
- interrupted, corrupt, transport, quota, and persistence failures cannot expose partial content and retain the active snapshot when one exists;
- the worker advertises snapshot compatibility, bypasses the API, opens no database, uses cache-specific offline navigation, and permits reload only with a compatible offline-ready active snapshot;
- 39 web tests cover integrity, schema, storage, runtime, update, UI, and accessibility behavior;
- reproducible native Chromium evidence bootstraps, corrupts/repairs, retains, and cold-restarts with the proxy unavailable and zero API requests;
- release `shell-48b974860e16510f36131506` and evidence are recorded under `migration/v2/phase1/storage/`; Chromium did not grant persistence and physical Safari/iPad acceptance remains pending.

TASK-013 completed active-generation offline library/search/status behavior:

- immutable deterministic indexes cover all 339 songs and 34 Set Lists only when the verified snapshot matches the active IndexedDB pointer generation;
- song search covers title, artist, slug, reviewed keys/BPM/provenance/provider fields, while Set List search covers title, slug, date, location, band, and status without changing source identities;
- recent and latest-date active Set List read models expose no pin or mutation controls;
- diagnostics bind the frozen date/freshness, 373 routes, 1,076 resolved references, zero unresolved references, 26 deleted-baseline exclusions, five landscape warnings, exact fit distributions, persistence, quota/headroom, and retained recovery state;
- memory/network and pending-recovery snapshots keep catalog selectors closed; failed updates remain browseable when the matching active pointer is retained;
- 55 web tests pass, including active-pointer isolation, reviewed-predecessor compatibility, failed-update retention, deterministic search, keyboard focus restoration, and axe checks;
- Chromium reloaded with the API process inactive, made zero `/api/v2/` requests, searched songs and Set Lists locally, and passed five axe surfaces, touch targets, contrast, reduced-motion, focus, and responsive overflow checks;
- release `shell-89785e5935f3ee0eea606eca` and evidence are recorded under `migration/v2/phase1/library/`; physical Safari/iPad acceptance remains pending and mandatory.

TASK-014 completed offline Set List detail and locked Live mode:

- immutable performance models resolve all 34 Set Lists and 1,076 occurrence identities, preserving duplicates, sections, singer/note context, target paths, and frozen fit records;
- exact active-pointer-only `#/sets/:slug/live` routes expose a performance-only surface with bounded occurrence navigation, progress announcements, memory-only Bright/Stage Dark themes, and no provider or authoring controls;
- mounted Live mode revalidates the active physical pointer, stops on cross-tab drift, and requires verified reload rather than reopening stale selectors;
- authoritative Apex HTML remains hidden source; the v1 automatic fitter is ported with exact sectionization, column breaks, balancing, tablet font/line search, phone scrolling, rendered-overflow checks, and readable fallback;
- the Chromium corpus harness matches all 1,017 frozen status/body-size/line-height/column-count results: 339 portrait fits, 334 landscape fits plus five warnings, and 339 one-column phone results, with zero false fits;
- actual latest-set Live traverses all 58 occurrences offline: 58 portrait fits and 57 landscape fits plus the expected Can’t Stop warning at occurrence 39; long phone sheets scroll with fixed 48px navigation controls;
- direct Live reload and full navigation with the API process inactive make zero API/post-ready requests and do not write local presentation preferences;
- 85 web tests plus Chromium axe, 48px touch-target, pointer-invalidation, and responsive-overflow evidence pass; keyboard/focus, strict Apex sanitization, reduced-motion CSS, and memory-only themes are covered by source contracts and unit tests;
- release `shell-8e20346e9b3ac2579dee901a` and evidence are recorded under `migration/v2/phase1/live/`; physical Safari/iPad acceptance remains pending and mandatory.

TASK-015 completed P1-008 browser, accessibility, route, update, and failure hardening:

- all active catalog routes now require the exact physical IndexedDB generation and monotonic pointer-transition epoch, with cross-tab broadcast plus polling, page-show, and foreground revalidation;
- offline-restart status now requires both durable verified content and a compatible controlling worker; direct first-load locked Live installs the initial worker while deferring its one-time reload until Live exits;
- waiting replacement workers expose no immediate activation path and activate only after all existing V2 clients close, while normal hash navigation no longer polls the worker or network;
- the PWA starts at `/#/`; malformed hashes and unknown document paths fail explicitly, and the worker no longer serves the shell for arbitrary navigation paths;
- verified internal Apex links are canonical V2 hash URLs for click, keyboard, auxiliary, context-menu, and new-tab use;
- native Chrome 151 automation covers desktop, tablet portrait, tablet landscape, and phone: 28 canonical online route checks, 20 invalid-hash checks, 28 cold offline route reloads, and 24 axe surface checks;
- every cold offline route reload makes zero API and post-ready fetch/XHR requests while preserving the same active pointer, transition epoch, 12 chunks, and 373 stored documents;
- 95 web tests pass, including active-pointer epoch closure and post-read races, typed IndexedDB failures, safely deferred replacement-worker decisions, routes, accessibility, storage recovery, and fitting;
- release `shell-39849548e3b7192a1c76aa6e` and evidence are recorded under `migration/v2/phase1/hardening/`; physical Safari/iPad acceptance remains pending and mandatory.

TASK-016 completed the P1-009 software checkpoint package; read-only physical evaluation remains in progress because deferred blocking G4 checks are open:

- deterministic checkpoint status is `SOFTWARE_PASS_PHYSICAL_PENDING`; stage readiness, writable work, default-route change, cutover, and v1 retirement remain false/no-go;
- frozen rollback/source/evidence refs, bootstrap generation, shell release, supporting evidence summaries, release binary, service unit, and package documents are hash-bound in `migration/v2/phase1/checkpoint/checkpoint-summary.json`;
- the V2 binary builds from two independent clean exports at SHA-256
  `4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc`
  using `-trimpath -buildvcs=false` and matches the deployed checkpoint binary;
  installed and tracked V2 unit bytes also match;
- V1 and V2 services remain enabled and active, with V1 default on port 8000 and V2 opt-in/loopback-only on port 8001;
- public port-8001 TLS/private-login behavior is recorded, while authorized owner-side reachability remains a physical-session confirmation;
- the install/upgrade/recovery/rollback runbook preserves V1 as immediate fallback and documents replacement-worker, diagnostics, storage, and controlled V2-origin cleanup behavior;
- 18 software matrix items pass; the baseline 57-item physical matrix remains
  available for sessions, with G1–G5 blocking read-only checks, optional
  nonblocking PHY-044, and optional/not-planned G6/G7 operational trials;
- the read-only release has no user-facing export/import or authored V2 user data; browser export/recovery remains mandatory before writable operation;
- an August 13 physical session on iPad Pro 13-inch (M5), iPadOS 26.6 records G1–G3 PASS, the replacement-worker drill PASS, operational G5 checks PASS, and deferred blocking G4 checks for later;
- VoiceOver is optional/nonblocking for that device contract and no VoiceOver support is claimed;
- G6 rehearsal and G7 real-gig trials are optional, not planned, and not the next step while product/design work remains;
- editing, sync, conflicts, import/export, publication, and all other writable behavior are unimplemented and untested in this slice.

TASK-017 completed the production authorization and durable sync foundation:

- exact trusted-proxy owner assertions and loopback ingress bind every request to
  the configured owner; dedicated device credentials are persisted only as
  SHA-256 digests and revoked devices fail closed;
- SQLite WAL tables scope every durable device, document, revision, conflict,
  operation, event, acknowledgement, and sequence row by owner;
- canonical payload hashing, operation replay, stale-write conflict retention,
  atomic conflict CAS resolution, content-bearing pull, explicit monotonic ack,
  compaction/resnapshot, restart, integrity, and online backup/restore contracts
  pass deterministic race-enabled tests;
- strict JSON HTTP adapters expose registration, apply, conflict resolution,
  pull, snapshot, acknowledgement, diagnostics, health, and self-revocation
  without browser mutation controls or metadata/content leaks;
- `cmd/v2api` mounts sync only when `-sync-enabled` and all required settings are
  supplied; defaults and the tracked service unit remain read-only;
- deterministic evidence is recorded under `migration/v2/production-sync/`.

TASK-018 completed the fenced publication, Git reconciliation, and recovery foundation:

- a separate owner-bound publication ledger persists immutable intents with the
  expected current revision, prior published revision, and Git base before any
  materialization or validation work;
- a permanent OS flock plus durable epoch/generation/holder tokens fence
  independent processes across Git side effects, and expected-base Git CAS
  prevents stale workers from overwriting external changes;
- isolated workspaces, strict typed Markdown projections, identity sidecars,
  corpus/link checks, and Apex validation gate deterministic commits before
  push; unowned canonical paths fail closed;
- commit-created, remote-accepted, and finalization-loss retries converge to one
  remote commit, while reconciliation first repairs known application commits;
- external edits, deletions, and renames enter the ordinary TASK-017 operation,
  event, and conflict path; editable sidecar hash/revision claims are ignored;
- online sync/publication ledger backups plus a verified Git bundle recover the
  tested skew states without touching the canonical checkout;
- `cmd/v2publisher` is a one-shot process with empty, disabled defaults; no
  publisher service or browser mutation controls are enabled;
- deterministic evidence is recorded under
  `migration/v2/production-publication/`.

TASK-019 completed the offline writable Set List editor and outbox:

- IndexedDB v3 stores immutable local/server revisions, durable drafts, exact
  retry envelopes, conflicts, and authoritative current/published mappings
  without coupling authored state to replaceable bootstrap generations;
- stable Set List, section, and duplicate Set Entry identities survive edits,
  reorder, synchronization, publication Markdown, close/reopen, and recovery;
- create, duplicate, metadata, reviewed-song add/remove/reorder, notes, autosave,
  and deterministic forward-revision undo are available only behind the explicit
  writable capability;
- foreground sync persists pulls before acknowledgement, retries exact attempted
  envelopes, and labels local, server, conflict, and published/locked-Live state
  independently;
- hashed export/restore preserves unsynced authored state without exporting
  device credentials;
- complete reviewed baseline bootstrap now seeds all 373 current documents and
  publication mappings before writable deployment;
- deterministic evidence is recorded under
  `migration/v2/writable-set-lists/` at SHA-256
  `39d6b8443391a6933330d20880ec006b5948cb35e229c093ff12e96eb6e64a33`;
  embedded release `shell-3ec4dfcfddc7fd8b5d1c1904` is the gated TASK-019 shell;
  the tracked service remains read-only.

TASK-020 completed offline writable lead-sheet authoring and enrichment:

- all 339 reviewed lead sheets open through a byte-first domain without source
  drift; managed metadata changes splice exact scalar/H1 ranges rather than
  reserializing unknown YAML or untouched body bytes;
- invalid intermediate source autosaves into CAS-protected workspaces while only
  locally valid, reviewed revisions enter immutable outbox envelopes;
- local checks, sync acceptance, exact-source server/Apex receipts, conflicts,
  and publication mappings remain separately labeled and durable;
- authenticated same-origin Apex validation, LRCLIB/Lyrics.ovh candidates,
  deterministic provider fallback, and Shelley suggestions return review-only
  local candidates and have no direct Git/publication write path;
- local authored lead sheets remain discoverable, recoverable, and eligible for
  explicitly labeled Set List references even when mutation gates are rolled
  back;
- Set List and lead-sheet browser/server write gates plus provider and Shelley
  gates are independent, disabled by default, and preserve queued work when off;
- deterministic evidence is recorded under
  `migration/v2/writable-lead-sheets/` at SHA-256
  `1743d4bebde58de9165525259b47dc2399b651a2a6e742768e8bbccb2a51ece6`;
  embedded release `shell-ffe70456e479eb1529d157f0` is the gated TASK-020 shell;
  the tracked service remains read-only.

TASK-021 software conflict/recovery hardening is complete; physical acceptance
remains pending:

- open conflicts retain and display immutable current-server and local-candidate
  revisions side by side;
- keep-local, keep-server, and manual selections enter a durable typed resolution
  outbox before network I/O, survive export/restore, and resolve through the
  conflict-specific CAS endpoint;
- mismatched outcomes, lost responses, conflict CAS failures, and stale compacted
  cursors preserve queued work and both candidates; resnapshot never changes a
  local apply base, so unseen remote movement remains conflict-producing;
- status language separately identifies local, queued, acknowledged,
  server/Apex-validated, published, and conflicted states;
- the writable recovery runbook, two-device checklist, signoff template, and
  deterministic evidence are under the TASK-021 docs and
  `migration/v2/writable-conflict-recovery/`; evidence SHA-256 is
  `9ed40bbebd7f51d122847daf2c1df92e20011f75a0e68d4385d0dd05b71fb85e`;
- embedded release `shell-96ab0f5519cd6a1bff86220f` contains the gated
  TASK-021 conflict/recovery UI;
- physical iPad rows WRT-001–042 and inherited PHY-028, PHY-029, PHY-032,
  PHY-037, and PHY-038 remain `PENDING`; writable pilot approval remains `NO`.

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
python3 scripts/build_v2_phase1_storage_evidence.py --check
python3 scripts/build_v2_phase1_library_evidence.py --check
python3 scripts/build_v2_phase1_live_evidence.py --check
python3 scripts/build_v2_phase1_hardening_evidence.py --check
node scripts/capture_v2_phase1_hardening_evidence.mjs --check
python3 scripts/build_v2_phase1_update_drill.py --check
python3 scripts/capture_v2_phase1_checkpoint_observation.py --check
python3 scripts/build_v2_phase1_checkpoint.py --check
make v2-api-build
go test ./internal/syncspike/...
go test -race ./internal/v2bootstrap/... ./internal/v2shell/...
make v2-sync-check
make v2-publication-check
make v2-writable-set-list-check
make v2-writable-lead-sheet-check
make v2-writable-conflict-recovery-check
go test ./...
go vet ./...
git diff --check
```

## Next tasks

1. Execute and sign off **TASK-021** physical iPad writable acceptance, including inherited PHY-028/029/032/037/038; keep writable pilot approval at `NO` until every blocking row passes.
2. After TASK-021 physical acceptance, execute **TASK-022**, an owner-led product-wide web design overhaul. The current evidence-oriented UI is not accepted as the target design.
3. Keep **TASK-023/024** printing and spreadsheet export deferred until writable workflows and the design overhaul are complete. Do not schedule G6/G7 unless separately requested.
