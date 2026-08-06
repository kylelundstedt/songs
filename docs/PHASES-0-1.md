# Phases 0–1 implementation report

Completed August 6, 2026.

## Display decision

The implementation uses an arm’s-length readability contract:

- **iPad/tablet:** exactly two columns, 21px preferred body text, 16px hard floor, and no scrolling or clipping when the sheet is marked `fit`.
- **iPhone:** exactly one 20px column. Vertical scrolling is allowed; horizontal overflow is not.
- **Stage dark** and **bright outdoor** are explicit manual themes.

Apex output is split into ordered flow blocks. Headings remain attached to their first content block, while long hard-break paragraphs may be divided into smaller visual blocks solely for column balancing. Text is neither removed nor rewritten.

## Phase 0: migration proof

### Legacy GitHub source

- Frozen source commit: `6cfbda8e4d8a99e8fbe2762d7e4a5add89b5f659`.
- 284 lead sheets copied from `lead-sheet/` to `songs/` without changing a byte or filename.
- SHA-256 equality verified for 284/284 files.
- Master manifest coverage verified for 284/284 files.
- 167 sheets have no H3 structure and remain review items.
- Five title/filename anomalies are recorded without automatic renaming.
- `2021-02-20-Murphys.txt` converted into one 32-song Markdown set list.
- All 32 generated relative song links resolve.

Artifacts:

- `tools/migrate_legacy.py`
- `tests/test_migrate_legacy.py`
- `migration/legacy-migration-manifest.json`
- `migration/legacy-migration-review.md`
- `sets/2021-02-20-murphys.md`

### Notion source

- 293 Lead Sheets records exported through the read-only `notion-songs` integration.
- 293 review-only Markdown candidates generated.
- No Members records or contact properties were queried or imported.
- Supported paragraphs, hard breaks, headings, columns, lists, and dividers are converted in API reading order.
- Candidate filenames include the source page UUID so variants cannot overwrite each other.
- All 293 candidates render successfully through Apex.
- One empty converted body remains a review item.

Artifacts:

- `scripts/export_notion_lead_sheet_candidates.py`
- `migration/notion-candidates/manifest.json`
- `migration/notion-candidates/REVIEW.md`

Notion candidates are not canonical files and are not served in the main song library.

## Phase 1: read-only PWA

Implemented:

- Small Go HTTP service.
- Rebuildable SQLite catalog and Apex render cache.
- Apex 1.1.14 rendering with plugins and unsafe HTML disabled.
- Searchable 284-song library with Songs/Set Lists tabs.
- No-result searches offer a prefilled Add Song draft form.
- Draft creation validates with Apex, commits the new Markdown file to Git, pushes it, and reindexes the catalog.
- Individual lead-sheet views.
- Set-list summary and one-route live set containing all 32 full-screen song panels.
- Previous/next buttons, keyboard navigation, swipe/scroll snapping, and progress display.
- Responsive two-column tablet fitter and one-column phone view.
- Stage and bright themes.
- Service worker and set snapshot caching.
- Offline preparation validates every song against the current viewport before caching.
- Security headers, same-origin resources, and no browser-side Git credentials.

## Browser and corpus validation

Tests used the entire 284-song canonical corpus.

| Profile | Theme | Result |
|---|---|---|
| iPad Pro portrait, 1024×1366 | Stage dark | 284/284 fit in exactly two columns; 282 at 21px and 2 at 20px before final spacing refinement |
| iPad Pro portrait, 1024×1366 | Bright outdoor | 284/284 fit in exactly two columns; 283 at 21px and 1 at 20px |
| iPad Pro landscape, 1366×1024 | Stage dark | 281/284 fit; `Love Shack`, `Paradise City`, and `TroubleMaker` are explicit `needs-editing` results at the 16px floor |
| iPhone, 393×852 | Stage dark | 284/284 render in exactly one 20px column with no horizontal overflow; vertical scrolling allowed |

Portrait is the fully approved iPad live profile. Landscape remains supported, but the three named sheets must be compacted before a landscape snapshot containing them can be marked ready.

Offline verification was performed by preparing the 32-song Murphys set, stopping the HTTP server, and reopening its cached live route. All 32 panels remained available without the server.

## Validation commands

```sh
go test ./...
python3 -m unittest tests/test_migrate_legacy.py
python3 tools/migrate_legacy.py --verify-only
python3 scripts/export_notion_lead_sheet_candidates.py --validate-apex
```

## Remaining work before Phase 2

- Compact or review the three landscape-only fit failures.
- Review the 42 Notion-only and 33 legacy-only title candidates from the audit.
- Resolve duplicate/version candidates before promoting Notion files.
- Rotate and purge the exposed credentials found in the legacy repository.
- Pilot portrait live mode on a physical iPad at rehearsal and in bright sunlight.
