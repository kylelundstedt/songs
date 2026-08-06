# Songs

A proposed Git-backed, Apex-rendered web app for cover-band vocalists.

The primary experience is a single-screen lead sheet and an offline, touch-friendly set-list mode for a 12–13 inch iPad Pro used on a music stand.

## Current status

Planning and source-system audit. The application has not been implemented yet.

- [Implementation proposal](docs/PROPOSAL.md)
- [Loosely Covered Notion audit](docs/research/notion-audit.md)
- [Legacy `loosely-covered/set-lists` audit](docs/research/legacy-audit.md)

## Environment

- VM: `kgl-songs`
- Local checkout: `/home/exedev/songs`
- Markdown renderer: Apex 1.1.14 at `/usr/local/bin/apex`
- Git remote: `kylelundstedt/songs`

## Proposed direction

- Markdown files in Git are canonical.
- A small Go service invokes Apex and provides editing, indexing, snapshots, and conflict-safe Git commits.
- SQLite is disposable and used only for indexes, caches, and operation queues.
- A vanilla-JavaScript PWA supports offline gigs, high-contrast stage/outdoor themes, and touch reordering.
- Web-assisted song import creates a reviewable draft and records provenance; it never commits fetched or inferred content without human verification.

See [the full proposal](docs/PROPOSAL.md) for architecture, formats, migration, phases, and acceptance criteria.
