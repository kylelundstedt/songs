# KGL Songs v2 proposal

## Executive recommendation

Treat v1 as a successful prototype and preserve it as a stable fallback at Git tag `v1`.

For v2, **rewrite the browser application around an offline-first local data model, while retaining the Markdown corpus, migration history, live-layout knowledge, and a refactored Go service**. Do not perform a big-bang rewrite of every layer, and do not change languages merely for novelty.

The recommended end state is:

- an installable TypeScript PWA whose normal read and write paths use a local IndexedDB database;
- a deliberate service worker that caches the application shell, not arbitrary network responses;
- a typed domain model with stable document and set-entry IDs;
- immediate local autosave and an explicit outbox for offline changes;
- a small versioned Go sync API with authentication, authorization, validation, conflict handling, and an audit trail;
- Git-backed Markdown as the portable published archive and human-readable export, rather than the browser's live transaction mechanism;
- a performance-only Live mode with no authoring controls;
- full offline support for the core product: browse, search, view, create, edit, arrange, review, and perform.

Remote lyrics providers, Git push, and Shelley/LLM assistance inherently require connectivity. V2 should make those optional online enrichments rather than dependencies of any core workflow.

## What v1 proved

V1 is much better than a disposable mockup. It proved several difficult product assumptions against real content:

- 291 lead sheets and 60 Set Lists can be represented in portable Markdown.
- The application can preserve imperfect historical material without blocking use.
- Full-set stage navigation is practical on an iPad.
- The two-column lead-sheet fitter can produce highly readable portrait layouts.
- A very small Go service can index, render, edit, validate, commit, and deploy the corpus.
- Git history is useful for reviewing automated imports and content changes.
- Musicians benefit from set-specific singer and note overrides.

These are v2 assets, not sunk costs.

## V1 review

### Architecture

The deployed system is intentionally compact:

```text
Markdown files in Git
        ↓
Go server (`srv/server.go`)
        ↓
Apex rendering + rebuildable SQLite index
        ↓
HTML templates + one vanilla-JS application file
        ↓
Service worker response cache
```

This was the right architecture for validating the corpus and stage display. It is not the right center of gravity for a fully offline editor.

### Strong parts to preserve

1. **Portable, inspectable content**
   - `songs/` and `sets/` are understandable without the application.
   - Git gives content changes a useful audit history.
   - SQLite is rebuildable rather than silently becoming a second content source.

2. **Careful migration discipline**
   - Legacy bodies were preserved and verified by hash.
   - Notion material remains review-only.
   - Imported Set Lists retain unresolved entries and source evidence.

3. **Proven performance rendering**
   - The fitter in `srv/static/app.js` contains valuable knowledge about iPad portrait, landscape, phone behavior, column balancing, and readability floors.
   - The current iPad portrait Live view is clear and high contrast in browser-profile testing. Physical-iPad rehearsal, bright-sun, and real-gig validation are still required, and the fit regression suite must expand from the original 284-sheet baseline to the current 291-sheet corpus.

4. **Reasonable prototype write safety**
   - Writes are serialized.
   - Clients send expected hashes.
   - Files are replaced atomically.
   - Markdown is validated before commit.
   - Successful writes commit, push, and reindex.

5. **Focused product scope**
   - V1 avoids becoming a notation editor, general CMS, or social platform.
   - The direct connection between a set entry and a lead sheet is understandable.

### Architectural limits

1. **The server is a monolith**

   `srv/server.go` is roughly 2,500 lines and combines domain parsing, indexing, HTTP, templates, auth assumptions, Git operations, provider integrations, rendering, sync-like behavior, and Shelley jobs. The code is still navigable, but nearly every feature crosses multiple concerns.

2. **Offline support is a response cache, not an offline application**

   `srv/static/sw.js` caches the shell and then opportunistically caches successful GET responses. Set preparation downloads selected routes, but there is no local document database, revision history, search index, operation queue, or conflict model.

   The current fallback returns `/` for an arbitrary failed GET. An uncached route or API request can therefore receive the library page rather than a typed offline error.

   Markdown endpoints are network-only. Add, remove, reorder, Markdown edit, import, and Shelley edit all call the server directly.

3. **The production working tree is also the write transaction system**

   The service mutates a checkout, validates, commits, and pushes. Hash checks protect one file, but there is no durable operation ledger, remote-head compare-and-swap, retry queue for failed pushes, or user-attributed audit record.

4. **Identity is too dependent on filenames and positions**

   Most song identity comes from filenames rather than immutable document IDs. Set item operations address positional indexes. Renaming a file or concurrently reordering a set is therefore more consequential than it should be.

5. **Front matter and Set List parsing are prototype-grade**

   `metadataValue` is a hand-written scalar extractor rather than a real YAML parser and schema validator. Set editing uses readable Markdown regexes, but presentation concepts such as column breaks also participate in editing semantics.

6. **The domain model is too flat**

   V1 effectively has `Song`, `SetList`, and `SetItem`. It cannot cleanly represent:

   - a composition versus a specific band arrangement;
   - multiple arrangements or keys of one song;
   - a gig independently from its Set List;
   - bands and venues as reusable entities;
   - stable set sections and entries;
   - local drafts, published revisions, provenance, and conflicts.

7. **Authorization is mostly an infrastructure boundary**

   The exe.dev proxy supplies authenticated identity, but the application has no explicit roles, ownership rules, device identity, or actor audit trail. This is acceptable for a private prototype, but mutation authorization should become an application concern in v2.

### UI and workflow limits

1. **The navigation is content-oriented rather than task-oriented**

   The opening page is an alphabetical song catalog. For a musician, the natural first questions are more likely:

   - What am I playing tonight?
   - Is the active set ready and stored offline?
   - What changed since rehearsal?
   - Which songs or imported entries still need review?

2. **Set Lists lack a lifecycle**

   There is no first-class New Set workflow, upcoming/draft/archive distinction, duplication, templates, rehearsal status, publication state, or readiness checklist.

3. **Set cards are difficult to distinguish**

   Many historical sets now correctly share titles such as `LC Acoustic` or `Funk Fatale`. Date alone is not always sufficient. Cards should include venue, band, status, readiness, and recent-use context.

4. **Set editing is capable but mode-heavy**

   Add, Remove, Arrange, raw Markdown, and Shelley are separate controls without a cohesive planning workflow. Unknown singers render repeatedly as `(—)`, and unresolved-match notes look like ordinary prose rather than actionable validation states.

5. **Live mode is not isolated enough**

   The current Live header includes `Edit Markdown` and `Edit with Shelley`. Performance mode should be locked down and distraction-free. Global navigation keys also need to ignore focused controls and open dialogs.

6. **Offline state is too vague**

   `Available offline on this device` does not identify the snapshot revision, saved time, completeness, staleness, storage risk, or unsynced changes.

7. **Accessibility and responsive behavior need a dedicated pass**

   V2 should provide visible focus styles, larger stage controls, explicit fit-failure text, live regions for status, active-song-only reading semantics, and one shared responsive model instead of slightly different JS and CSS breakpoints.

## V2 product principles

1. **Local first, server synchronized**
   - Every user action commits to local durable storage first.
   - Network state never blocks rehearsal or performance.
   - Sync is observable and retryable.

2. **Performance is safer than authoring**
   - Live mode is a separate locked mode, not an editor with fewer buttons.
   - A set cannot be marked Ready without passing configurable checks.

3. **Typed internally, portable externally**
   - Runtime state uses a typed schema and stable IDs.
   - Markdown remains a deterministic import/export and published archive format.

4. **No silent data loss**
   - Conflicts are merged only when rules are unambiguous.
   - Whole-document last-write-wins is forbidden.
   - Failed sync and failed Git push remain durable states.

5. **Offline is a testable contract**
   - It is not a badge derived from whether a few routes happen to be cached.
   - Every core workflow has an airplane-mode acceptance test.

6. **Preserve the proven stage experience**
   - Do not casually replace the current fitter, readability floors, themes, or corpus validation.

## Readiness states

V2 should distinguish three states that v1 currently blends together:

- **Local stage-ready:** the device has a complete local snapshot; links resolve locally; the selected viewport fit policy passes; no blocking unresolved entry exists. This may be achieved offline.
- **Server-validated:** the latest revision has passed authoritative schema and Apex validation on the server.
- **Published:** the accepted revision has been materialized to Git and its push is confirmed.

Live mode may use a locally stage-ready draft when the performer explicitly acknowledges that it is not server-validated or published. The UI must never label those states simply `Ready` without qualification.

## Proposed v2 experience

### Dashboard

The default screen should answer the current musical task:

- **Tonight / Next gig** with primary `Open Live` action;
- offline readiness, last synced revision, and unsynced changes;
- rehearsal queue and recently opened songs;
- draft and unresolved-review counts;
- quick actions: New Set, New Lead Sheet, Sync.

### Library

The library remains important, but becomes metadata-rich:

- full offline search;
- title, alias, artist, arrangement, singer, key, BPM, tags, band, and recent-use matching;
- favorites and recently used;
- filters for draft, reviewed, fit status, missing metadata, and provenance;
- composition pages that group multiple arrangements.

### Sets

Use **Upcoming**, **Drafts**, and **Archive** views. A Set List initially owns its gig metadata—date, venue/location, band, sections, and notes. A separate reusable `Gig` entity can be introduced later if the product develops multi-set events or shared event workflows that justify it.

Each card should show:

- gig/set title;
- date and venue;
- band;
- song count and estimated duration when available;
- readiness and unresolved count;
- offline/sync status.

### Set workspace

A Set List should have four explicit modes:

1. **Plan**
   - gig metadata;
   - set sections and breaks;
   - add songs or unresolved placeholders;
   - inline singer, key, capo, BPM, and transition notes.

2. **Arrange**
   - large drag handles;
   - keyboard-accessible move controls;
   - stable item IDs;
   - immediate local autosave;
   - undo/redo.

3. **Review**
   - unresolved links;
   - missing lead sheets;
   - missing singer/key/transition information;
   - fit failures by target device and orientation;
   - offline snapshot freshness;
   - visible `Ready for gig` gate.

4. **Live**
   - performance-only shell;
   - set name, song position, now/next, offline state, and stage lock;
   - always-visible previous, drawer, and next controls;
   - set drawer for direct jumps;
   - wake-lock support with visible state and graceful fallback;
   - no Markdown, AI, import, add, delete, or arrangement controls.

### Lead-sheet editor

The editor should provide:

- structured metadata and source Markdown;
- local autosave;
- live preview;
- iPad portrait, iPad landscape, and phone fit previews;
- clear parser and fit errors;
- diff against the last published revision;
- revision history and conflict resolution;
- explicit Publish/Sync separate from local Save.

External lyrics search and Shelley assistance should create a local draft, never publish directly.

## Proposed v2 domain model

Start with the entities proven by the current product rather than normalizing every noun immediately:

```text
LeadSheet
  id, legacy_slug, title, aliases, artist, metadata,
  current_revision_id, publication/readiness state

LeadSheetRevision
  id, lead_sheet_id, revision, source Markdown, parsed form,
  rendered representation, base revision, validation state

SetList
  id, legacy_slug, title, date/precision, band, location,
  status, metadata, current_revision_id

SetSection
  id, set_list_id, title, order

SetEntry
  id, section_id, lead_sheet_id or unresolved reference,
  order, singer/key/capo/BPM overrides, transition note

Operation
  id, device_id, entity_id, base_revision,
  operation type, payload, state, timestamps
```

`band` and `location` should initially remain validated strings with alias normalization. Separate `Band`, `Venue`, `Gig`, `Song`, and `Arrangement` entities should be added only when a concrete workflow needs them—for example, when multiple arrangements of one composition or reusable venue details become common. This keeps the first offline rewrite aligned with the actual corpus.

Stable IDs should be UUIDs or similarly immutable generated identifiers. Filenames become human-friendly slugs, not identity.

### Lossless identity migration

V2 must not destroy the byte-preservation evidence for the 284 legacy lead sheets merely to add IDs.

The initial migration should:

1. reuse all trustworthy existing front-matter IDs, including current Set List IDs;
2. create a versioned sidecar identity manifest for legacy files without IDs, mapping path and source hash to an immutable v2 ID;
3. create a sidecar Set Entry manifest mapping each imported entry fingerprint and order to a stable entry ID;
4. preserve every existing Markdown file byte-for-byte during the first identity assignment;
5. keep legacy filename routes through a slug-to-ID map;
6. add front-matter and entry-ID comments only in later, explicitly reviewed schema migrations or when v2 becomes the sole writer of a changed document.

A v2 Markdown serializer must preserve unknown fields, ordering, comments, quoting, nested legacy data, unresolved references, column-break comments, and untouched body bytes. Reading a historical file must never rewrite it as a side effect of using a generic YAML serializer.

## Proposed technical architecture

```text
┌────────────────────────────────────────────────────────────┐
│ TypeScript PWA                                             │
│                                                            │
│ React UI ─ Domain services ─ Local parser/renderer/fitter  │
│      │               │                    │                │
│      └──── IndexedDB documents/revisions/outbox/search ────┤
│                      │                                     │
│              Service worker app shell                     │
└──────────────────────┬─────────────────────────────────────┘
                       │ versioned pull/push sync
┌──────────────────────▼─────────────────────────────────────┐
│ Refactored Go service                                      │
│                                                            │
│ Auth/ACL ─ Sync engine ─ Validation/rendering ─ Providers  │
│      │          │                 │                        │
│      └──── durable SQLite operation/audit ledger ──────────┤
│                         │                                  │
│                  Git materializer/exporter                 │
└─────────────────────────┬──────────────────────────────────┘
                          │
                 Published Markdown Git history
```

### Published-content authority

For v2, Git remains the authoritative **published archive**, but after cutover the application is the sole automated writer. Direct human edits to the repository are not merged silently into live state.

A deliberate reconciliation command should import an external Git commit by:

1. matching stable IDs through front matter or the identity sidecar;
2. validating lossless parsing and schema compatibility;
3. comparing the external revision with the last imported published revision;
4. creating ordinary sync conflicts when both app state and Git changed;
5. recording the import actor and source commit.

This decision must be implemented before writable v2 clients ship. It prevents the Git materializer and human edits from becoming competing writers.

### Client

Recommended implementation:

- TypeScript;
- Vite build;
- React for stateful workspaces, dialogs, conflict handling, and accessibility;
- a small typed IndexedDB layer;
- a hand-controlled service worker or narrowly configured PWA tooling;
- no large global state framework until the domain services prove one is necessary.

The critical decision is local-first state, not React itself. A framework spike may substitute Preact or another small component system if it materially simplifies the bundle without weakening testing or accessibility.

### Local storage

IndexedDB should contain:

- complete local copies of all synced songs, arrangements, gigs, sets, and entries;
- source Markdown and parsed representations;
- revisions and content hashes;
- a lightweight search index;
- device preferences and recent items;
- offline fit results;
- an append-only operation outbox;
- conflict records and sync cursors.

The current canonical Markdown corpus is only about 0.71 MiB, so the v2 baseline should download the full library automatically after bootstrap. Selectable offline collections can be deferred until media or future corpus growth makes them necessary. Set-specific readiness still matters because fit validation and unresolved references are gig-specific.

The service worker should cache only versioned application assets, navigation shell responses, and deliberate immutable resources. Domain records belong in IndexedDB. It should provide typed offline responses rather than returning the home page for every cache miss.

### Atomic bootstrap, upgrade, and recovery

Offline reliability requires more than filling IndexedDB opportunistically:

1. preflight estimated storage and request persistent storage where supported;
2. download bootstrap data in resumable chunks with content hashes;
3. write into a new snapshot namespace while the previous snapshot remains active;
4. mark the new snapshot current only after every required record, index, schema migration, and application asset is complete;
5. preserve and migrate the pending operation outbox before activating a new client schema;
6. roll back to the previous complete snapshot after interruption or validation failure;
7. show storage persistence, snapshot revision, byte size, and last successful sync;
8. provide a downloadable recovery bundle containing local drafts and queued operations;
9. define sign-out and lost/shared-device behavior, including an explicit local-data wipe.

A partially downloaded or partially migrated snapshot must never replace the last known-good offline state.

### Offline write contract

Every mutation follows this order:

1. validate locally;
2. write the new entity revision and operation to one IndexedDB transaction;
3. update the UI immediately;
4. mark the operation `queued`;
5. sync on explicit request, app start, reconnect, or foreground resume;
6. retain the operation until the server acknowledges its idempotency key;
7. show `conflict` or `failed` without discarding the local revision.

Do not depend on Background Sync for correctness. It may be used as an enhancement where available, but explicit foreground sync must be complete and reliable.

### Sync protocol

Use versioned endpoints such as:

```text
GET  /api/v2/bootstrap
GET  /api/v2/changes?cursor=...
POST /api/v2/operations
GET  /api/v2/operations/:id
POST /api/v2/snapshots/:setID/validate
```

Each operation includes:

- operation UUID;
- registered device ID;
- entity and stable item IDs;
- base entity revision and base published Git commit;
- typed payload;
- client timestamp for display only;
- local content hash.

Actor identity must come from the authenticated server session, never from a client-supplied `actor_id`. Device registration is bound to that actor server-side, and every operation is authorized again when accepted.

The server must be idempotent. Accepted operations update the durable ledger before Git export. A failed Git push remains a retryable server state rather than becoming only a warning.

### Conflict rules

Avoid CRDTs initially. The app is small, edits are relatively infrequent, and readable human conflict resolution is more valuable than sophisticated eventual merging.

- **Metadata fields:** merge independent field changes; conflict if both sides changed the same field differently.
- **Set entry add/delete/note changes:** rebase by stable entry ID.
- **Set reorder:** accept when only one side reordered; otherwise show both orders and require selection/merge.
- **Lead-sheet Markdown:** use base/current/local three-way comparison. Auto-merge only non-overlapping changes.
- **Delete/delete:** idempotent.
- **Delete/edit:** explicit conflict.

Never silently overwrite an entire Markdown document with the last arriving copy.

### Rendering and validation

The hardest rewrite decision is the renderer. Apex is server-side, while offline editing needs local preview and validation.

Recommended staged approach:

1. preserve Apex as the publication validator and regression oracle;
2. define a documented constrained lead-sheet grammar and typed AST;
3. implement a local browser parser/renderer for that grammar;
4. maintain a corpus-wide conformance suite comparing local output semantics and fit behavior with approved v1/Apex fixtures;
5. save offline edits as drafts even if authoritative publication validation must wait for sync;
6. consider a shared WebAssembly content engine only if maintaining two conforming implementations becomes a demonstrated problem.

Do not begin v2 by attempting to port or replace every renderer. Protect the existing corpus first.

### Server

Keep Go, but split the monolith into packages with explicit interfaces:

```text
internal/domain       typed entities and validation
internal/documents    Markdown import/export and schema parsing
internal/catalog      indexing and search projection
internal/render       Apex adapter and render cache
internal/sync         operations, cursors, merge rules
internal/gitstore     worktree, commit, fetch/push, recovery
internal/auth         identity, roles, authorization
internal/providers    lyrics and enrichment adapters
internal/httpapi      versioned handlers
```

SQLite should remain appropriate for a private single-instance deployment, but v2 SQLite is not entirely disposable. Search/render projections may be rebuilt; the operation ledger, audit trail, sync cursor, and failed-export queue are durable and backed up.

Use a dedicated Git worktree or bare repository adapter instead of treating the deployed source checkout as the transaction workspace.

### Security and operations

V2 should add:

- explicit authenticated actor and device records;
- owner/editor/viewer authorization;
- centralized mutation middleware;
- actor and operation IDs in audit history and Git commit trailers;
- same-origin and CSRF protections for browser mutations;
- request size and provider rate limits;
- server read/write/idle timeouts and graceful shutdown;
- uniform security headers for HTML, static content, and APIs;
- health/readiness endpoints;
- durable backup of Git plus operational SQLite;
- CI for Go, TypeScript, schema migration, corpus validation, and browser tests.

## Rewrite options

### Option A: harden v1 in place

Keep Go templates and vanilla JavaScript, expand the service worker, and add IndexedDB around existing pages.

**Advantages**

- smallest initial change;
- fastest path to a few offline edits;
- preserves all current behavior directly.

**Disadvantages**

- imperative DOM state becomes increasingly difficult once drafts, outbox operations, conflicts, revisions, and undo are added;
- server-rendered pages remain the conceptual source even when offline state disagrees;
- the monolithic server remains expensive to change;
- likely to create a transitional architecture that must later be replaced.

**Verdict:** useful for urgent v1 fixes, not recommended as the v2 foundation.

### Option B: controlled frontend rewrite plus backend refactor

Build a TypeScript local-first PWA alongside v1. Reuse the Go service after extracting versioned sync and content services. Preserve all canonical files and old routes during migration.

**Advantages**

- directly addresses offline requirements;
- preserves the strongest existing assets;
- permits incremental parity and rollback;
- avoids a risky simultaneous rewrite of content, client, server, and deployment;
- creates clear domain and sync boundaries.

**Disadvantages**

- temporary duplication of v1 and v2 routes;
- requires careful renderer parity and migration fixtures;
- more initial architecture work than patching v1.

**Verdict:** recommended.

### Option C: total rewrite, including backend and content store

Replace Go, Git-backed Markdown, rendering, frontend, and deployment at once—possibly with a native iPad application or a new all-JavaScript backend.

**Advantages**

- maximum freedom;
- native iPad could provide excellent device integration;
- no compatibility constraints if the existing corpus is fully converted.

**Disadvantages**

- discards proven migration, Git, rendering, and stage-layout work;
- multiplies migration and regression risks;
- splits support across web and native clients if phones/desktops remain important;
- offers little backend benefit for this scale;
- delays usable offline improvements until the entire replacement is complete.

**Verdict:** not justified unless the product direction changes to a multi-user commercial platform or a dedicated native iPad product.

## Phase 0 exit addendum — August 9, 2026

The original delivery sequence below is superseded where it conflicts with `docs/v2/PHASE-0-EXIT-REVIEW.md` and `docs/v2/PHASE-1-PLAN.md`.

Measured Phase 0 evidence supports a controlled rewrite, but current `main` has materially diverged from the frozen `v1` corpus and physical Safari/iPad validation remains open. The revised sequence is:

1. refresh and freeze current-content parity evidence while preserving `v1` separately as rollback;
2. deliver an isolated read-only React/TypeScript PWA using authoritative Apex HTML;
3. productionize the durable sync/publication/recovery kernel before exposing writes;
4. pilot physical Safari/iPad behavior before any writable or default-route decision.

TASK-008 completed step 1 on August 10, 2026: source tag `v2-phase1-content-2026-08-10` freezes canonical/server bytes and evidence tag `v2-phase1-evidence-2026-08-10` freezes sidecars and parity artifacts. The parallel Phase 1 topology selects a separate V2 origin on explicit port 8001, so the v1 root worker remains unchanged.

A separate V2 origin is preferred while v1 remains deployed. If `/v2/` is used, the root v1 worker must explicitly bypass V2 routes and pass controller-handoff tests for existing clients; V2 still needs independent manifest, cache, and IndexedDB names. Durable ledger recovery is a prerequisite for writes rather than a late hardening task.

## Recommended delivery plan

### Phase 0 — Protect the v1 baseline and resolve discovery gates

Already started by tagging `v1`.

Add:

- corpus manifest with document paths, IDs, hashes, links, and rendered fixtures;
- browser screenshots and fit baselines for the current 291-sheet corpus;
- legacy route fixture list;
- backup and restore drill;
- a renderer spike that freezes Apex 1.1.14, CSS, fonts, viewport profiles, and measurable semantic/fit parity rules;
- a sync-protocol spike covering idempotency, external Git reconciliation, failed-push recovery, and two-device conflicts;
- a full-library bootstrap size and storage-quota test on the target iPad.

**Exit:** v1 can be rebuilt and restored exactly; every canonical document has a recorded baseline; renderer and sync feasibility are demonstrated well enough to estimate the remaining phases.

### Phase 1 — Schema, identity, and durable sync foundation

- Define the minimal v2 domain schema and operation format.
- Create lossless sidecar identity manifests; reuse existing IDs and preserve legacy files byte-for-byte.
- Add stable Set Entry IDs through the sidecar migration strategy.
- Replace scalar front-matter reads with a lossless compatibility layer plus versioned schema validation.
- Extract domain, documents, rendering, Git, sync, and auth packages from `srv/server.go`.
- Add `/api/v2` bootstrap and change-feed endpoints.
- Add the minimal durable operation ledger, idempotent operations endpoint, actor/device binding, authorization, Git materializer, failed-push queue, and external-Git reconciliation path required before any writable client ships.

**Exit:** v1 UI behaves unchanged; every v1 entity is available through typed v2 APIs; a test client can submit an idempotent operation and recover safely from Git push failure.

### Phase 2 — Read-only offline-first PWA

- Build the TypeScript application shell.
- Bootstrap the complete corpus into IndexedDB using the atomic snapshot contract.
- Implement local library search, dashboard, Set List views, and Live mode.
- Port and regression-test the fitter against the frozen renderer fixtures.
- Add explicit revision, validation, publication, sync, persistence, and storage status.
- Add offline-not-available and update-required states.

**Exit:** after one sync, the entire library and all sets open with the network disabled; live navigation makes no network requests; interrupted bootstrap or upgrade retains the previous complete snapshot.

### Phase 3 — Offline Set List workflow

- Create, duplicate, edit, section, add/remove, and reorder sets locally.
- Add stable item operations, undo, outbox, foreground sync, and conflict UI.
- Build Plan, Arrange, Review, and locked Live modes.
- Add local-stage-ready, server-validated, and published states.

**Exit:** a user can build and modify a Set List in airplane mode, close the app, reopen it, retain every change, and sync later through the already-durable operation/Git pipeline without silent loss.

### Phase 4 — Offline lead-sheet editing

- Add local source/metadata editor and parser.
- Add fit preview and local draft validation.
- Add revision history, three-way merge, and authoritative publication validation.
- Connect unresolved Set Entries directly to draft lead-sheet creation.

**Exit:** a user can create or edit a lead sheet offline, mark it locally stage-ready when appropriate, use it in a set immediately, and obtain server-validated and published states after reconnecting.

### Phase 5 — Hardening and online enrichments

- Harden operation compaction, reconciliation, audit queries, and Git recovery tooling.
- Complete owner/editor/viewer authorization and device-management UX.
- Add provider and Shelley adapters as explicitly online features.
- Complete backup/restore, observability, security, schema-upgrade, and local-recovery paths.

**Exit:** server, Git, interrupted upgrade, or device-storage failures cannot silently lose accepted changes; every published change is attributable and recoverable.

### Phase 6 — Pilot and cutover

- Run v1 and v2 in parallel behind a feature flag.
- Rehearse with v2 on the physical target iPad.
- Test a real gig in offline mode with a v1 fallback snapshot.
- Resolve all critical fit, sync, and stage-safety issues.
- Redirect default routes to v2 while preserving v1 for rollback.

**Exit:** performer approval after real rehearsal and gig use; no critical data-loss, offline, accessibility, or fit defects.

## Test strategy

V2 needs tests at four levels:

1. **Corpus and parser tests**
   - every document parses;
   - import/export round trips;
   - body hashes and links remain stable;
   - renderer and fit golden fixtures.

2. **Domain and sync tests**
   - operation replay and idempotency;
   - non-overlapping merges;
   - reorder and delete conflicts;
   - failed Git push recovery;
   - schema migrations.

3. **Browser tests**
   - Playwright desktop, iPad portrait/landscape, and phone profiles;
   - network-disabled browse/search/edit/reorder/live flows;
   - app upgrade with pending operations;
   - storage failure and stale snapshot states;
   - accessibility and keyboard behavior.

4. **Physical-device tests**
   - iPad Home Screen installation;
   - airplane mode and process restart;
   - bright sun and dark stage;
   - touch targets, accidental navigation, and wake lock;
   - full rehearsal and gig pilot.

## Offline acceptance contract

After installation and one successful bootstrap, with the server unreachable, a user must be able to:

- open the application from the Home Screen;
- browse and search the full synced library;
- view every synced lead sheet and Set List;
- create and edit Set Lists and their gig metadata;
- add, remove, reorder, and annotate Set Entries;
- create and edit local lead-sheet drafts;
- close and reopen the application without losing changes;
- enter locked Live mode and navigate the entire active set;
- see the exact local revision, sync state, and unresolved/fit warnings;
- export or copy local draft content for emergency recovery.

After reconnecting:

- queued operations sync idempotently;
- conflicts are visible and never silently overwrite either side;
- accepted changes eventually produce attributable Git commits;
- failed Git export remains retryable and observable.

Explicitly online-only actions may include remote lyrics search, Shelley/LLM assistance, remote Git synchronization, and downloading content not present in the last bootstrap. Their absence must not block any core workflow.

## Estimation approach

Do not commit to a complete v2 date before the renderer and sync spikes in Phase 0. They contain the largest unknowns: browser/Apex parity, lossless identity export, atomic iPad storage, external Git reconciliation, and conflict UX.

A reasonable first commitment is **1–2 focused engineering weeks for Phase 0**, ending with:

- measured bootstrap size and timing on the target iPad;
- a passing local-renderer proof on representative hard sheets;
- a two-device sync/conflict prototype;
- failed-push recovery;
- revised estimates and explicit scope for Phases 1–6.

A total rewrite should still be assumed to take longer than the controlled approach while increasing the chance of losing the best v1 behavior.

## Immediate next decisions

The owner delegated conservative defaults for autonomous work; Decision 0006 records them. Single-owner/multi-device, React, full-library bootstrap, and published-by-default Live behavior are provisional implementation decisions. Exact physical iPad/Safari support and any local-stage-ready Live opt-in still require owner validation before pilot.

Before implementation, make four explicit product decisions:

1. Is v2 safe multi-device use by one owner, or must owner/editor/viewer collaboration ship in the first cutover?
2. Which exact physical iPad model, orientations, and minimum Safari version define the supported stage contract?
3. May an explicitly acknowledged `local stage-ready` draft be used in Live mode before server validation, or must Live require the last server-validated revision?
4. Should the first v2 client commit to React, or should Phase 0 compare React and Preact against the same offline editor and accessibility spike?

## Final recommendation

**Build v2 as a controlled rewrite of the client and sync model, not as a total rewrite of KGL Songs.**

Keep:

- the v1 Git tag and rollback path;
- canonical content and migration evidence;
- Go on the server;
- Git/Markdown portability;
- Apex as the initial publication validator;
- the current layout fitter's behavior and stage design lessons.

Replace:

- server-rendered pages as the browser's operational state;
- opportunistic response caching;
- positional and filename-derived identity;
- direct network-only mutations;
- the monolithic server boundary;
- authoring controls inside Live mode.

The result should feel less like a website that can cache a gig and more like a dependable musical instrument that happens to synchronize through the web.
