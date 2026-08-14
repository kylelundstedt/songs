# TASK-021 writable conflict and recovery evidence scaffold

**Prepared:** August 14, 2026
**Physical status:** `PENDING_OWNER_EXECUTION`

`writable-conflict-recovery-evidence.json` is deterministic, checked-in
inventory evidence. The generator hashes selected production source and test
files and requires markers for browser durability/export/restore, retry/device
continuity/gates, server conflict/revocation/restart, and fenced
publication/Git/backup recovery.

It deliberately does **not** run tests itself and does **not** claim a physical
iPad G4 or writable-workflow pass. The Make target runs the listed web and Go
race suites before checking the static inventory:

```sh
make v2-writable-conflict-recovery-check
```

The current deterministic artifact SHA-256 is
`9ed40bbebd7f51d122847daf2c1df92e20011f75a0e68d4385d0dd05b71fb85e`.

Owner execution remains required using:

- `docs/v2/acceptance/TASK-021-writable-two-device-checklist.md`;
- `docs/v2/acceptance/TASK-021-writable-signoff-template.md`; and
- `docs/v2/runbooks/TASK-021-writable-conflict-recovery.md`.

The inherited blocking read-only G4 items remain `PENDING` as of August 14,
2026: **PHY-028, PHY-029, PHY-032, PHY-037, and PHY-038**. A pass of the Make
target does not alter that status, approve a writable pilot, change the default
route, or retire V1.
