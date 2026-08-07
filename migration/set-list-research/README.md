# Historical Set List research

Review-only source inventory, matching, reconciliation, and `SetListDraft` candidates collected from:

- the public `loosely-covered` GitHub organization;
- the read-only Notion Gigs integration;
- the private `Band.zip` archive supplied for this migration.

Nothing in this directory is canonical application data. Canonical songs remain under `songs/`, and published Set Lists remain under `sets/`.

## Current snapshot

- 59 editable draft candidates admitted;
- 8 publication-ready candidates;
- 51 candidates requiring review;
- 6 empty or unsupported sources excluded;
- 1 existing canonical Set List excluded to avoid duplication.

Historical dates support either day precision (`YYYY-MM-DD`) or month precision (`YYYY-MM`).

See:

- `MEMORY.md` for the unified creation/cloning/import draft design;
- `reports/draft-readiness.md` for admission and publication blockers;
- `reports/reconciliation.md` for duplicate and supporting-page decisions;
- `reports/missing-song-evidence.md` for non-canonical Song candidates.

## Reproduction

The private source archive is intentionally not committed. To rerun iCloud extraction, place it at:

```text
raw/Band.zip
```

Then run the scripts from this directory. The local `raw/` and `work/` directories are ignored.

```sh
python3 scripts/match_setlist_catalog.py --songs ../../songs --research .
python3 scripts/reconcile_setlists.py
python3 scripts/build_setlist_drafts.py
python3 scripts/build_missing_song_evidence.py
```

`extract_icloud_setlists.py` additionally requires the local parser environment described in `reports/icloud-setlist-extraction.md`.
