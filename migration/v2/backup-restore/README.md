# V1 backup and restore baseline (TASK-004)

`backup-restore-baseline.json` records a deterministic, ephemeral drill for the
pinned v1 release (`v1` at `546f59b41d9e9bcf0e81b543c27900a31e26c9e6`). The
builder is stdlib-only and uses no external network or provider calls:

```sh
python3 scripts/build_v2_backup_restore_baseline.py
python3 scripts/build_v2_backup_restore_baseline.py --check
python3 -m unittest tests/test_build_v2_backup_restore_baseline.py
```

The drill creates a Git bundle containing `refs/tags/v1`, restores two clean
checkouts, preserves Git-archive file mtimes, starts the tagged server twice,
and waits for `/api/catalog`. While the first isolated database is running in
WAL mode it uses Python `sqlite3.Connection.backup()` into a separate database.
The ephemeral component manifest includes SHA-256 and byte counts; it is
validated before restore and those machine-specific values are intentionally
not checked in.

Restore order is: verify bundle and baseline; restore a clean tagged checkout;
verify the online-backup component manifest; copy only the completed online
backup; run SQLite `quick_check`, `integrity_check`, and
`foreign_key_check`; compare schema and semantic projections; start the tagged
server; and verify focused catalog, song, Set List, Live, and offline routes
using the TASK-003 normalization contract.

The evidence covers all 351 Markdown files (291 songs and 60 Set Lists), source
hashes, renderer hashes, schema/migration/index counts, and deterministic
semantic projections. It also exercises fail-closed detection for a missing
canonical file, corrupt SQLite backup, corrupt Git bundle, wrong baseline
commit, and missing backup component. No raw copied live database is treated as
a backup.

The ephemeral SQLite backup correctly preserves the database's operational
`executed_at`/`indexed_at` values. Those values and the nondeterministic binary
component hashes are verified during the drill but omitted from the checked-in
evidence; deterministic semantic projections intentionally exclude only those
timestamp columns.

## Operational limitation and V2 requirement

V1 SQLite is a rebuildable index/cache. It has no draft, outbox, or conflict
ledger; Git's canonical Markdown and exact tag are therefore the critical v1
backup. V2 must provide durable server-side ledger backups for drafts, outbox,
conflicts, and revisions. Unsynced IndexedDB drafts require client export and
recovery until they are synchronized.
