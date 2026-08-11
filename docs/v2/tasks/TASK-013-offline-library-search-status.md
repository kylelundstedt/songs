# TASK-013: Offline Library, Search, and Snapshot Diagnostics

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Complete (August 11, 2026)
- **Estimate:** 2–3 focused engineering days

## Objective

Build production local indexes and offline browse/search/status behavior over
TASK-012's one active verified snapshot without introducing browser writes.

## Scope

- derive deterministic title, artist, slug, metadata, and Set List indexes from
  the active generation;
- serve library, song filtering/search, Set List browse, and diagnostics without
  network requests after bootstrap;
- expose snapshot freshness, persistence, origin-wide quota/headroom, retained
  recovery, fit warnings, and resolved/unresolved reference counts;
- add recent/pinned active Set List read models without mutation controls;
- preserve exact source/Apex authority and route identities.

Do not add editing, pin mutations, outbox writes, sync submission, Git
publication, local Markdown rendering authority, v1 changes, or route cutover.

## Acceptance criteria

- all library/search/status selectors read only the active pointer generation;
- browse and search make zero network requests with the API unavailable;
- search results are deterministic and cover title, artist, slug, and reviewed
  metadata without inventing normalized content identities;
- current counts, deleted-baseline exclusions, route coverage, fit warnings, and
  resolved/unresolved references match TASK-008/TASK-010 artifacts;
- failed updates keep active search/browse available and report the retained
  outcome accurately;
- keyboard, touch, reduced-motion, contrast, and axe checks pass in Chromium;
- physical Safari/iPad acceptance remains pending and mandatory.

## Completion evidence

- immutable title/artist/slug/reviewed-metadata and Set List indexes are built
  only when the verified snapshot matches the active IndexedDB pointer;
- deterministic local search covers the reviewed fields without changing source
  identity, and latest-date active Set List fallback adds no mutation controls;
- diagnostics bind current counts, routes, references, deleted-baseline
  exclusions, fit distributions, freshness, persistence, quota/headroom, and
  retained recovery state to the reviewed snapshot;
- failed updates retain browse/search when the active pointer still matches,
  while memory/network and pending-recovery snapshots keep selectors closed;
- 55 web tests pass, including axe, keyboard focus, active-pointer isolation,
  failed-update retention, exact current contracts, and zero-fetch offline
  runtime coverage;
- Chromium reloaded from the active IndexedDB snapshot with the API process
  inactive, made zero `/api/v2/` requests, and passed local song/Set List search,
  five axe surfaces, touch-target, focus-return, contrast, reduced-motion, and
  responsive-overflow checks;
- release `shell-89785e5935f3ee0eea606eca` and reproducible evidence are recorded
  under `migration/v2/phase1/library/`;
- physical Safari/iPad acceptance remains pending and mandatory.
