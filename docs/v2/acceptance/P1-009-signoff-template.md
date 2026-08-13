# P1-009 Physical Acceptance Signoff

This template records owner decisions for one exact software checkpoint and one
exact device/test matrix. A signature must never be inferred from software or
Chromium evidence.

## Checkpoint

- Checkpoint summary path:
- Checkpoint summary SHA-256:
- Git commit:
- Shell release:
- Bootstrap generation:
- Physical checklist session path(s):

## Gate decisions

| Gate | Decision | Owner initials/date | Notes |
|---|---|---|---|
| G0 — Software checkpoint | PASS / FAIL | | |
| G1 — Device contract | PASS / FAIL / PENDING | | |
| G2 — Install/bootstrap | PASS / FAIL / PENDING | | |
| G3 — Offline workflows | PASS / FAIL / PENDING | | |
| G4 — Lifecycle/storage/update | PASS / FAIL / PENDING | | |
| G5 — Touch/keyboard/readability/performance | PASS / FAIL / PENDING (PHY-044 optional) | | |
| G6 — Optional rehearsal trial | NOT PLANNED / PASS / FAIL / PENDING | | |
| G7 — Optional real-gig trial | NOT PLANNED / PASS / FAIL / PENDING | | |

## Result

Select exactly one for the current **read-only** slice:

- [ ] Read-only physical evaluation remains incomplete because blocking G1–G5
      items are pending or failed.
- [ ] Read-only physical evaluation complete for the listed device contract;
      optional PHY-044 was not required and no VoiceOver support is claimed.
- [ ] Read-only physical evaluation failed; V1 remains the required operational
      path.

Optional operational decisions, made only if the owner later considers the
design mature enough:

- [ ] Optional rehearsal trial approved/completed.
- [ ] Optional real-gig trial approved/completed.

No selection on this form validates writable behavior. Editing, sync, conflicts,
import/export, publication, and recovery for authored work are unimplemented and
untested unless a separate future package says otherwise.

The following remain separate decisions and are **not** granted by this form:

- writable V2 work;
- default-route change;
- v1 retirement;
- support for any unlisted iPad/iPadOS/Safari combination.

## Owner signoff

- Owner name:
- Signature/initials:
- Absolute date/time:
- Accepted device and OS contract:
- Required fallback:
- Open conditions/findings:
