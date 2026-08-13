# P1-009 Checkpoint Evidence

This directory is the deterministic software checkpoint and the starting package
for physical iPad/Safari acceptance.

- `checkpoint-summary.json` binds the frozen source/evidence/rollback refs,
  reviewed bootstrap and shell identities, reproducible V2 binary, installed
  service unit, software evidence, public proxy boundary, and test matrices.
- `checkpoint-summary.json` is the content-addressed manifest. The final package
  commit is published by annotated tag
  `v2-p1-009-software-checkpoint-2026-08-12`; that tag is a publication root,
  not an input to its own evidence generation.
- `physical/device-matrix.json` records every physical checklist item as
  `PENDING`; software evidence cannot change those values.
- `update-drill/` contains the deterministic compatible successor required for
  the physical replacement-worker test PHY-039.
- `physical/sessions/TEMPLATE/` is copied for each real owner/device session.
- Installation and rollback procedures are in
  `docs/v2/runbooks/P1-009-install-upgrade-rollback.md`.
- The authoritative physical checklist and signoff template are in
  `docs/v2/acceptance/`.

## Status

- Software: **PASS**
- Read-only physical evaluation: **IN PROGRESS** (session evidence is separate)
- VoiceOver: **optional/nonblocking unless explicitly included in a device contract**
- Rehearsal/real-gig trials: **optional; not implied next steps**
- Writable features: **not implemented or tested**
- Overall checkpoint package: **SOFTWARE_PASS_PHYSICAL_PENDING**
- Stage-ready: **false**
- Writable allowed: **false**
- Default-route/cutover allowed: **false**

Validate software evidence:

```sh
python3 scripts/build_v2_phase1_checkpoint.py --check
make p1-009-check
```

`p1-009-check` performs the expensive native Chromium recapture. The deterministic
builder alone validates the checked-in package without executing physical tests.

## Physical session procedure

Copy `physical/sessions/TEMPLATE/` to a new directory named with the absolute test
date and device identity. Complete blocking items with `PASS`, `FAIL`, or
`PENDING`; optional/nonblocking items may be `NOT_REQUIRED`, and optional G6/G7
trials may be `NOT_PLANNED`. Record notes/evidence and use the signoff template.
Never overwrite the template and never mark a physical item from Chromium
results.

The current read-only V2 product has no user-facing export/import and no authored
V2 data to export. Browser export/recovery remains mandatory before writable use.
