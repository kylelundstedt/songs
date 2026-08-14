# V2 Architecture

This is the agreed target shape; `docs/V2-PROPOSAL.md` remains the detailed rationale and delivery plan.

## Direction

V2 is a **controlled rewrite**: build a TypeScript local-first PWA beside the proven Go service, preserve v1 routes and Git/Markdown portability during migration, and retain v1 as the rollback baseline. Do not rewrite every layer at once.

## Runtime boundaries

```text
TypeScript PWA
  UI + domain services + local parser/renderer/fitter
  IndexedDB: documents, revisions, search projection, outbox, conflicts
  service worker: versioned app shell and deliberate immutable assets
             │ versioned pull/push sync
Go service
  auth/ACL + sync + validation/rendering + providers
  durable SQLite operation/audit ledger
  Git materializer/exporter
             │
Published Markdown in Git
```

- Local IndexedDB is the operational source for browser reads and writes.
- Every mutation validates and commits locally before entering the durable outbox.
- Sync is explicit, idempotent, observable, and conflict-preserving; it is never required for core rehearsal or performance workflows.
- Git is authoritative for **published archive content**. After cutover, the application is the sole automated writer; external Git changes require deliberate reconciliation.
- Apex remains the initial authoritative publication validator and regression oracle while a constrained local parser/renderer is proven.
- Live mode is a locked performance surface, separate from authoring.

## Initial domain

Use stable immutable IDs for `LeadSheet`, `LeadSheetRevision`, `SetList`, `SetSection`, and `SetEntry`. Filenames are slugs, not identity. Preserve legacy Markdown byte-for-byte through sidecar identity manifests and lossless parsing.

Start with validated strings for band and location. Add broader entities only when a concrete workflow requires them.

## Readiness states

Keep `local stage-ready`, `server-validated`, and `published` distinct. Never collapse them into an unqualified `Ready` state.

Local stage-ready content is not admitted to Live by default. A future owner-level opt-in may permit it only with explicit acknowledgement and visible state labeling.

## Measured Phase 0 conclusions and derived requirements

The August 9, 2026 exit review established the following measured conclusions and production requirements. Requirements such as lease fencing and future-upgrade preservation are derived hardening gates, not behaviors proven by the Phase 0 spikes:

- `v1` remains the permanent rollback/regression baseline, but current user-visible V2 data must come from a separately frozen current-content baseline.
- A separate V2 origin is preferred while v1 remains deployed. A `/v2/` deployment is acceptable only after the root v1 service worker bypasses V2 routes and controller-handoff tests cover existing controlled clients, first load, update, and offline restart. V2 still requires independent manifest, cache, and IndexedDB names.
- Phase 1 uses authoritative Apex HTML plus the proven fitter. A local Markdown renderer is deferred until it has corpus-wide semantic parity evidence.
- Browser data activates through one transactional active-generation pointer change; the previous complete generation remains retained for rollback.
- Browser storage persistence is never assumed. Persistence/retention status and emergency export/recovery are product requirements.
- Pull is read-only; device cursors advance only after local persistence and explicit acknowledgement.
- TASK-005 proved operations keyed by `(device ID, operation ID)` plus canonical payload hash. Production authentication must bind each device to an authorized actor; stale writes preserve candidate revisions as explicit conflicts.
- Publication intents persist expected document revision, expected prior published revision, and expected Git base before materialization.
- Remote push, SQLite finalization, and acknowledgement are separate recoverable states.
- Production publication requires a fenced multi-process lease and isolated Git worktree.
- External reconciliation compares repository bytes with the database's last imported published revision; sidecar hash claims are not authoritative.
- Durable V2 ledger recovery and unsynced browser recovery must exist before real writes are accepted.

## Current delivery decision

TASK-018 is complete. Publication now runs as a separate, disabled-by-default
one-shot process with an owner-bound SQLite intent/reconciliation ledger, an OS
flock plus durable fencing generations, isolated deterministic Git workspaces,
expected-base CAS pushes, schema/identity/link/Apex validation, crash recovery,
and coordinated ledger/Git backup evidence. External edits, deletions, and
renames are compared against durable published bytes and enter the ordinary sync
operation/conflict path without trusting editable sidecar claims. The canonical
checkout, V1 service, and read-only V2 shell remain untouched.

TASK-017 is complete. The server now has an owner-scoped SQLite WAL ledger,
strict trusted-proxy and device authorization, deterministic registration,
idempotent canonical mutation envelopes, conflict-preserving CAS, content-bearing
pull plus explicit acknowledgement, revocation, resnapshot, restart, integrity,
and online backup/restore coverage. The HTTP adapter and `cmd/v2api` integration
remain disabled by default; the tracked service unit still starts the read-only
shell without sync flags. Deterministic evidence is under
`migration/v2/production-sync/`. No browser mutation controls were added.

The controlled rewrite remains approved. The strict Phase 0 exit is conditional because the frozen `v1` evidence no longer matches current `main`, and physical Safari/iPad validation remains open.

TASK-008 is complete. Source tag `v2-phase1-content-2026-08-10` freezes canonical content/server behavior, while evidence tag `v2-phase1-evidence-2026-08-10` freezes the parity artifacts under `migration/v2/current/`. Together they are the only authorized inputs for Phase 1.

TASK-009 is complete. `@songs-v2/read-model` projects those pinned Git objects into lossless typed documents, frozen-snapshot Set section keys, and immutable Set Entry identities. It retains exact canonical bytes and does not establish a local renderer or writable identity source. TASK-010 may now generate the versioned read-only bootstrap API from this package.

TASK-010 is complete. `@songs-v2/bootstrap-api` generates a reviewed manifest and 12 immutable chunks with complete typed projections, source bytes, source-bound Apex HTML, fit evidence, and slug routes. `cmd/v2api` validates the exact embedded manifest trust anchor once and serves authenticated JSON-only bytes on isolated port 8001 without changing the frozen v1 server.

TASK-011 is complete. React/Vite shell release `shell-72d3106d38dfec5cc2eaf403` verifies the full TASK-010 snapshot before rendering read-only library, lead-sheet, Set List, and status surfaces. The V2 worker caches only isolated shell assets, bypasses the API, and reserves but does not open `songs-v2` IndexedDB. Chromium/software evidence passes; physical Safari/iPad acceptance remains pending.

TASK-012 is complete. Shell release `shell-48b974860e16510f36131506` stores reviewed raw manifest/chunk bytes and decoded document sources in `songs-v2`, reverifies durable rows, atomically activates one physical instance with generation-plus-transition CAS fencing, retains accepted predecessors, repairs corruption without overwriting active bytes, and reopens with zero API requests. The worker advertises snapshot compatibility and never handles API data or IndexedDB. Chromium/software evidence passes; persistence was not granted and physical Safari/iPad acceptance remains pending.

TASK-013 is complete. Shell release `shell-89785e5935f3ee0eea606eca` constructs immutable indexes only for a verified snapshot matching the active IndexedDB pointer, searches reviewed song and Set List fields locally, exposes exact freshness/storage/reference/fit/exclusion diagnostics, and retains browse/search after a failed update when the active pointer remains valid. Chromium reloaded and searched with the API process inactive and made zero API requests; physical Safari/iPad acceptance remains pending.

TASK-014 is complete. Shell release `shell-8e20346e9b3ac2579dee901a` resolves every Set Entry occurrence into an immutable local performance sequence, exposes exact active-pointer-only locked Live routes, ports the proven Apex fitter, and provides bounded keyboard/touch navigation with memory-only Bright/Stage Dark themes. Chromium corpus, actual-route, offline, accessibility, and pointer-invalidation evidence pass; physical Safari/iPad acceptance remains pending.

TASK-015 is complete. Shell release `shell-39849548e3b7192a1c76aa6e` hardens the complete read-only slice with physical-pointer-plus-transition route gating, cross-tab invalidation, compatible-worker offline readiness, replacement-worker deferral until every V2 client closes, canonical PWA/hash/Apex routes, strict unknown-path behavior, typed storage failure reporting, and current-release native Chrome automation across desktop, tablet, and phone profiles. V2 remains opt-in and separately namespaced; physical Safari/iPad acceptance remains pending.

TASK-016 software packaging is complete. The P1-009 checkpoint binds the frozen refs, trust anchors, release archive, service unit, supporting evidence, runbook, and software/physical matrices. Its exact software status is `SOFTWARE_PASS_PHYSICAL_PENDING`: V1 remains default, V2 remains read-only and opt-in, and writable/cutover claims remain prohibited. The August 13, 2026 owner session passes G1–G3 and operational G5 checks on the approved iPad, with deferred blocking G4 reliability checks. VoiceOver is optional/nonblocking for this device contract and no VoiceOver support is claimed. G6/G7 are optional operational trials, not implied next steps.

The current read-only design is an evidence vehicle, not the accepted target web
design. Editing, sync, conflicts, publication, and authored-data recovery are not
yet implemented or physically tested. The owner-directed sequence is:

1. TASK-017–021: make Set List and lead-sheet authoring work end to end,
   including authorization, durable sync, fenced publication, offline editing,
   provider/Shelley draft workflows, conflicts, recovery, and writable physical
   acceptance;
2. TASK-022: replace the current evidence-oriented UI with an owner-approved,
   product-wide web design grounded in those real workflows;
3. TASK-023/024: consider printing and spreadsheet export later.

Deferred read-only G4 checks remain scheduled for a later session. Do not infer
writable, rehearsal, gig, default-route, or V1-retirement readiness.
