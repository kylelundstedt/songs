# Phase 0 legacy migration

`tools/migrate_legacy.py` is a standard-library-only, deterministic migration tool for the frozen legacy checkout at `/home/exedev/set-lists-reference`.

It performs only the Phase 0 legacy baseline migration:

- copies all legacy lead sheets into `songs/` without changing a byte or a filename;
- converts `2021-02-20-Murphys.txt` into `sets/2021-02-20-murphys.md`, retaining source order and using relative Markdown links;
- writes `migration/legacy-migration-manifest.json` and `migration/legacy-migration-review.md`;
- validates source Git cleanliness, expected counts, UTF-8/LF input, H1/title mappings, hash equality, master-manifest coverage, duplicate event entries, and every generated relative link.

It does **not** alter lead-sheet bodies, add front matter to lead sheets, infer keys, infer sections, rename songs to canonical IDs, fetch content, or touch application/server code.

Run the migration from the repository root:

```sh
python3 tools/migrate_legacy.py
```

Repeat the full validation without writing:

```sh
python3 tools/migrate_legacy.py --verify-only
```

The source checkout must be a clean Git worktree. The script fails closed if the expected 284 lead sheets or 32 ordered event entries are not present, if source names do not resolve, if hashes differ, or if `songs/` contains unrelated Markdown files that could be overwritten.
