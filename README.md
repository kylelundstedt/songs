# Songs

A private, Git-backed lead-sheet and set-list PWA for cover-band vocalists.

**Live app:** https://kgl-songs.exe.xyz/

## Phase status

Phases 0 and 1 are implemented as of August 6, 2026:

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

See [Phase 0–1 results](docs/PHASES-0-1.md), the [v1 implementation proposal](docs/PROPOSAL.md), and the [v2 architecture and product proposal](docs/V2-PROPOSAL.md).

## Run locally

```sh
make test
make build
./srv/songs -listen :8000 -repo .
```

The service expects Apex on `PATH` and stores its rebuildable SQLite index under `var/`. Markdown in Git remains canonical.

## Repository layout

```text
songs/                         canonical migrated lead sheets
sets/                          canonical Markdown set lists
migration/notion-candidates/   review-only Notion exports
migration/                     migration manifests and reports
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

- [Phase 0–1 implementation report](docs/PHASES-0-1.md)
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
