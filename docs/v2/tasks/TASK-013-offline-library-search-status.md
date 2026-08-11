# TASK-013: Offline Library, Search, and Snapshot Diagnostics

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Ready
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
