# Current backup and restore evidence

The drill bundles annotated tag `v2-phase1-content-2026-08-10`, restores two
clean detached checkouts, captures the running WAL-mode SQLite index with the
online backup API, and verifies source/render/schema/projection hashes before
starting the restored server.

The drill covers recovery of the canonical source tag and its rebuildable current
v1-style SQLite index: 373 files, 339 song-index rows, 34 Set List rows, five
focused routes, and five fail-closed corrupt/missing/wrong-baseline cases. The
identity/evidence package is versioned separately by
`v2-phase1-evidence-2026-08-10`; future durable V2 ledger recovery remains a
pre-write gate.

```sh
python3 scripts/build_v2_current_backup_restore_baseline.py --check
```
