# TASK-021 Writable Acceptance and Pilot Signoff Template

**Prepared:** August 14, 2026
**Initial status:** `PENDING_OWNER_EXECUTION`

Use this form only with a completed
`TASK-021-writable-two-device-checklist.md` session record. Software evidence or
an unsigned checklist cannot create a physical-device pass or pilot approval.

## Exact scope and identities

- Owner:
- Tester(s):
- Absolute decision time (UTC):
- Git commit:
- Shell release:
- V2 origin:
- Device A model / iPadOS / Safari / launch mode / non-secret device ID:
- Device B model / iPadOS / Safari / launch mode / non-secret device ID:
- Server/release operator:
- Checklist record path(s):
- Deterministic evidence path and SHA-256:
- Initial/final client export SHA-256 values (A then B):
- Coordinated backup manifest path/SHA-256, if a server drill ran:
- V1 fallback location and final verification time:

## Evidence boundary acknowledgement

- [ ] I understand that the deterministic TASK-021 JSON inventories checked-in
      source/test evidence only and does not claim physical iPad success.
- [ ] I understand the checklist's initial physical status is `PENDING` as of
      August 14, 2026.
- [ ] I understand a local draft, queued operation, acknowledged revision,
      server-validated lead sheet, published revision, and conflict are distinct
      states and were not conflated in the decision.
- [ ] I confirm V1 remained available throughout the session and remains the
      immediate fallback after this decision.

## Blocking prerequisite decisions

| Requirement | Decision | Owner initials/date | Notes/evidence |
|---|---|---|---|
| WRT-001 through WRT-006 preflight/labels | PASS / FAIL / PENDING | | |
| WRT-010 through WRT-015 offline durability/export/recovery | PASS / FAIL / PENDING | | |
| WRT-020 through WRT-028 two-device conflict/revocation | PASS / FAIL / PENDING | | |
| WRT-030 through WRT-035 server/publication recovery | PASS / FAIL / PENDING | | |
| PHY-028 — 5-minute background/resume | PASS / FAIL / PENDING | | |
| PHY-029 — 30-minute background/resume | PASS / FAIL / PENDING | | |
| PHY-032 — reboot and offline reopen | PASS / FAIL / PENDING | | |
| PHY-037 — eviction surrogate/rebootstrap | PASS / FAIL / PENDING | | |
| PHY-038 — low-free-storage result | PASS / FAIL / PENDING | | |
| Final authored exports and V1 verification (WRT-040–042) | PASS / FAIL / PENDING | | |

## Conflict and recovery confirmation

- Set List conflict IDs/revisions reviewed:
- Lead-sheet conflict IDs/revisions reviewed:
- Keep-server outcome and recovery/export proof:
- Keep-local outcome and recovery/export proof:
- Manual-resolution outcome and convergence proof:
- Revoked-device result and retained-local-work proof:
- Server restart/validation/publication recovery result:
- Backup verification / isolated restore / Git-ledger convergence result:
- Open conflicts, failed operations, or unresolved recovery conditions:

## Owner decision

Select **exactly one**:

- [ ] **No-go / incomplete.** One or more blocking rows are `PENDING` or
      `FAIL`; writable pilot remains unapproved and V1 remains the required
      fallback.
- [ ] **No-go / failed.** A data-loss, candidate-retention, unsafe recovery,
      or other blocking defect was observed; writable gates are disabled pending
      remediation and retest.
- [ ] **Controlled writable pilot approved for this exact scope only.** Every
      blocking row above passed, no unresolved authored work exists outside
      recorded exports, and V1 fallback is available. This does not approve a
      default-route change, V1 retirement, other devices/OS versions, broader
      collaboration roles, or a real-gig workflow.

## Conditions and signatures

- Approved writable gates and expiry/rollback time:
- Required monitoring and export cadence:
- Required fallback:
- Open conditions/findings:
- Retest date/time, if incomplete:
- Owner name:
- Owner signature/initials:
- Absolute signature time (UTC):
- Engineering/release acknowledgement:
