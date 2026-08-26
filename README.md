# Songs

A private, Git-backed lead-sheet and set-list PWA for cover-band vocalists.

**Live V1 default/fallback:** https://kgl-songs.exe.xyz/

**V2 status:** disabled after owner no-go on August 26, 2026. V1 remains the only operational app.

## Project status

The v1 application remains deployed and `main` continues to receive canonical content updates. Tag `v1` at `546f59b` is the permanent rollback/regression point.

V2 Phase 0 completed its architecture evidence review on August 9, 2026 with a **conditional go** for an isolated read-only PWA. TASK-008 froze the current baseline, TASK-009 projected all 373 documents and 1,076 Set Entries losslessly, TASK-010 produced the reviewed bootstrap API, TASK-011 delivered the isolated verified React/Vite shell, TASK-012 atomically activates and cold-restarts the snapshot from IndexedDB, TASK-013 provides deterministic active-generation offline library/search/status behavior, TASK-014 runs complete locked Set List performances offline, TASK-015 hardens the integrated slice across current-release Chromium routes, accessibility, worker updates, pointer races, and failure recovery, and TASK-016 packages the software checkpoint plus physical-device runbook/checklist. TASK-017 through TASK-021 added writable foundations and a pilot implementation. On August 26, 2026, the owner declared the V2 product unusable relative to V1 after repeated shell, synchronization, editor, and interface failures. The V2 service is disabled, its server state is preserved, and V1 remains the only operational application. Any future V2 effort requires a fresh owner-approved plan grounded in V1's working product behavior rather than continued patching of the current shell.

The following bullets describe the historical August 6, 2026 v1 Phases 0–1 implementation:

- 284 legacy Markdown lead sheets migrated byte-for-byte into `songs/`.
- The 32-song Murphys set migrated into `sets/2021-02-20-murphys.md`.
- 59 historical Set List drafts imported from GitHub, Notion, and the private Band archive, for 60 visible Set Lists total.
- Draft Set Lists preserve unresolved songs in place, support month-precision dates, can be reordered, and show lead-sheet placeholders in live mode.
- 293 API-visible Notion lead sheets exported as review-only Markdown candidates under `migration/notion-candidates/`.
- Apex 1.1.14 renders every canonical song and every Notion candidate.
- Searchable read-only song library and set-list views.
- Offline PWA snapshots for complete sets.
- Stage-dark and bright-outdoor themes.
- iPad/tablet live sheets use exactly two columns and fit to one viewport at a 16px readability floor.
- iPhone uses exactly one 20px column with vertical scrolling when required.
- A standalone `<!-- column-break -->` comment starts the next tablet column in lead sheets and set lists; it is ignored in one-column phone layouts.
- Set-list entries support gig-specific `— singer: Name — note: Details` fields, so the same song can have different singers on different dates.
- A Set-column heading uses `## Set 1 — Slow` immediately before its first song; later headings follow a standalone `<!-- column-break -->`.
- Individual Set Lists can be edited as canonical Markdown or maintained with Add song, Remove songs, and drag-to-reorder controls; every save validates, commits, pushes, and reindexes.

See the [historical v1 Phase 0–1 results](docs/PHASES-0-1.md), [V2 Phase 0 exit review](docs/v2/PHASE-0-EXIT-REVIEW.md), [Phase 1 plan](docs/v2/PHASE-1-PLAN.md), [v1 implementation proposal](docs/PROPOSAL.md), and [v2 architecture and product proposal](docs/V2-PROPOSAL.md).

## Run locally

```sh
make test
make build
./srv/songs -listen :8000 -repo .

# Verify the Phase 1 TypeScript read model and bootstrap payload
npm --prefix v2 ci
make v2-check

# Verify the disabled-by-default writable foundations
make v2-sync-check
make v2-publication-check

# Run the isolated read-only V2 shell and API on port 8001
make v2-api-run
```

The service expects Apex on `PATH` and stores its rebuildable SQLite index under `var/`. Markdown in Git remains canonical.

## Repository layout

```text
songs/                         canonical migrated lead sheets
sets/                          canonical Markdown set lists
migration/notion-candidates/   review-only Notion exports
migration/                     migration manifests and reports
v2/packages/read-model/        frozen typed read model and deterministic fixtures
v2/packages/bootstrap-api/     deterministic reviewed manifest/chunk generator
v2/packages/web/               isolated verified React/Vite read-only shell
internal/v2bootstrap/           embedded validator and authenticated JSON API
internal/v2shell/               embedded shell assets and strict static handler
scripts/                       Notion export tooling
tools/                         legacy migration tooling
srv/                           Go server, templates, PWA assets
```

## Migration commands

```sh
# Reproduce or verify the byte-preserving legacy migration
python3 tools/migrate_legacy.py
python3 tools/migrate_legacy.py --verify-only

# Refresh review-only Notion candidates and validate with Apex
python3 scripts/export_notion_lead_sheet_candidates.py --validate-apex
```

## Documentation

- [V2 Phase 1 software checkpoint](migration/v2/phase1/checkpoint/README.md)
- [V2 install/upgrade/rollback runbook](docs/v2/runbooks/P1-009-install-upgrade-rollback.md)
- [VM rebuild and restore runbook](docs/v2/runbooks/vm-rebuild-restore.md)
- [Physical iPad/Safari acceptance checklist](docs/v2/acceptance/P1-009-ipad-safari-checklist.md)
- [Physical acceptance signoff template](docs/v2/acceptance/P1-009-signoff-template.md)
- [Historical v1 Phase 0–1 implementation report](docs/PHASES-0-1.md)
- [V2 Phase 0 exit review](docs/v2/PHASE-0-EXIT-REVIEW.md)
- [V2 Phase 1 plan](docs/v2/PHASE-1-PLAN.md)
- [V2 Phase 1 frozen current baseline](migration/v2/current/README.md)
- [V2 architecture and product proposal](docs/V2-PROPOSAL.md)
- [V1 implementation proposal](docs/PROPOSAL.md)
- [Lyrics provider policy](docs/LYRICS-PROVIDERS.md)
- [Focused Shelley edits](docs/SHELLEY-EDITS.md)
- [Legacy migration instructions](docs/legacy-migration.md)
- [Notion audit](docs/research/notion-audit.md)
- [Legacy repository audit](docs/research/legacy-audit.md)
- [Environment record](docs/ENVIRONMENT.md)

## Security note

The old `loosely-covered/set-lists` repository contains a tracked plaintext Snowflake credential and a workflow step that can expose a secret in logs. Rotate/revoke affected credentials and remove them from current content and Git history. No secret values are copied into this repository.
