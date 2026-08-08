# TASK-004: Backup and Restore Baseline

- **Priority:** P1
- **Phase:** 0
- **Status:** Done

## Objective

Prove that the published Markdown corpus and operational SQLite state can be backed up and restored into a clean environment without relying on the running VM or browser state.

## Scope

Cover:

- exact Git/tag identity and canonical corpus restoration;
- operational SQLite backup using a transactionally safe mechanism;
- schema version, integrity, row counts, and selected semantic invariants;
- restoration into a fresh checkout and database path;
- manifest, renderer, and read-route verification after restore;
- incomplete, corrupted, mismatched, and wrong-baseline backup detection;
- explicit handling of local drafts/outbox data that v1 does not yet possess.

Do not alter or stop the deployed v1 service, push restored content, or treat a copied live SQLite file as a valid backup procedure.

## Procedure

1. Export the exact baseline Git tree and initialize isolated operational state.
2. Create a SQLite online backup plus a manifest describing Git commit, schema, files, hashes, sizes, and verification commands.
3. Restore into a second clean directory with no shared database or generated state.
4. Verify the restored corpus against TASK-001, run SQLite integrity/foreign-key checks, and compare semantic database projections.
5. Start the restored tagged server and execute focused TASK-003 route checks.
6. Exercise corruption, missing-file, and baseline-mismatch detection without damaging canonical artifacts.
7. Record deterministic commands, evidence, limitations, and recovery ordering.

## Acceptance criteria

- A clean restore reproduces all 351 canonical Markdown files byte-for-byte.
- SQLite backup uses an online/transactionally safe backup operation and passes integrity checks after restore.
- Restored indexed song/Set List counts and source hashes agree with the tagged corpus.
- Focused catalog, song, Set List, Live, and offline-manifest routes work from restored state.
- Corrupted, incomplete, and wrong-baseline backups fail closed with useful errors.
- Backup artifacts contain no secrets, machine-specific paths, timestamps, or mutable production files.
- A deterministic `--check` command detects evidence drift.

## Completed evidence

- A Git bundle containing `refs/tags/v1` restores two clean detached checkouts at the exact commit.
- Python's SQLite online backup API captures the isolated WAL database while the tagged source server remains running.
- All 351 canonical Markdown files restore byte-for-byte.
- Restored SQLite passes quick, integrity, and foreign-key checks with one migration, 291 song rows, and 60 Set List rows.
- Source, rendered HTML, schema, and timestamp-excluding semantic projection hashes match TASK-001/002 evidence.
- Five focused restored-server routes match TASK-003 exactly.
- Missing corpus content, corrupt SQLite, corrupt Git bundle, wrong baseline, and missing components all fail closed.
- V1 SQLite is confirmed as rebuildable cache state; V2's durable ledger and unsynced IndexedDB recovery remain explicit requirements.

## Verification commands

The implementation should provide focused commands shaped like:

```sh
python3 scripts/build_v2_backup_restore_baseline.py
python3 scripts/build_v2_backup_restore_baseline.py --check
python3 -m unittest tests/test_build_v2_backup_restore_baseline.py
```
