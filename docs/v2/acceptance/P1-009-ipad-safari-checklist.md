# P1-009 Physical iPad/Safari Acceptance Checklist

**Checkpoint software status:** PASS
**Physical acceptance status:** PENDING
**Stage-ready:** NO
**Writable/default-route/cutover allowed:** NO

Complete this checklist on an owner-approved physical iPad. Chromium emulation
cannot satisfy any `PHY-*` item.

For every item record `PASS`, `FAIL`, or `PENDING`, tester, absolute timestamp,
device/OS identity, checkpoint shell release, notes, and supporting evidence.
Mandatory items cannot be marked N/A.

## Session identity

- Tester:
- Date/time (UTC):
- Checkpoint summary SHA-256:
- Shell release:
- iPad model and screen size:
- iPadOS version/build:
- Safari version/build:
- Free storage before test:
- Battery level/health notes:
- External keyboard model, if supported:
- Launch mode: Safari / Home Screen
- Auto-Lock setting:
- Display Zoom/text-size settings:
- V1 fallback device/artifact available:

## Gate G1 — Supported-device contract

| ID | Check | Status | Evidence/notes |
|---|---|---|---|
| PHY-001 | Owner approves exact iPad model and screen size | PENDING | |
| PHY-002 | Owner approves exact iPadOS/Safari version and minimum supported floor | PENDING | |
| PHY-003 | Auto-Lock operating procedure is approved; use `Never` during performance unless a later wake-lock feature is separately accepted | PENDING | |
| PHY-004 | Independent V1 or printed/PDF fallback is immediately available | PENDING | |

## Gate G2 — Authentication, install, and bootstrap

Use `https://kgl-songs.exe.xyz:8001/#/`.

| ID | Check | Status | Evidence/notes |
|---|---|---|---|
| PHY-005 | V1 default origin works before V2 testing | PENDING | |
| PHY-006 | V2 public origin opens after private authentication | PENDING | |
| PHY-007 | Unauthenticated access exposes no bootstrap content | PENDING | |
| PHY-008 | Add to Home Screen succeeds with approved name/icon | PENDING | |
| PHY-009 | Home Screen launch is standalone and starts at the library root | PENDING | |
| PHY-010 | Status reports 373 documents, 339 songs, 34 Set Lists, and 1,076 resolved / 0 unresolved entries | PENDING | |
| PHY-011 | Status reports 12/12 chunks, active physical generation, and compatible controlling worker | PENDING | |
| PHY-012 | Status reports offline restart available | PENDING | |
| PHY-013 | No edit, save, add, delete, publish, sync, provider, or pin controls are exposed | PENDING | |

## Gate G3 — Offline workflows

After successful online bootstrap, enable Airplane Mode and explicitly disable
Wi-Fi and cellular.

| ID | Check | Status | Evidence/notes |
|---|---|---|---|
| PHY-014 | Home Screen cold launch succeeds three consecutive times offline | PENDING | |
| PHY-015 | Library, Songs, Set Lists, and Status open offline | PENDING | |
| PHY-016 | Song `1979` opens offline | PENDING | |
| PHY-017 | Set List `9Tease Stripped` opens offline | PENDING | |
| PHY-018 | Direct locked Live opens offline | PENDING | |
| PHY-019 | Song search works by title, key, provider, and BPM | PENDING | |
| PHY-020 | Set List search works by date and location | PENDING | |
| PHY-021 | All 58 `9Tease Stripped` occurrences traverse offline | PENDING | |
| PHY-022 | Previous/Next remain bounded and occurrence-based | PENDING | |
| PHY-023 | Bright and Stage Dark themes work without persistence or mutation | PENDING | |
| PHY-024 | Occurrence 39 shows the expected Can’t Stop landscape warning | PENDING | |
| PHY-025 | Warning content remains readable by scrolling with no clipping | PENDING | |
| PHY-026 | All five warning songs are inspected: Can’t Stop, Father of Mine, Love Shack, Paradise City, Troublemaker | PENDING | |

Airplane Mode proves practical offline operation. Do not record literal
zero-request proof unless independent network instrumentation is used.

## Gate G4 — Lifecycle, rotation, storage, and update

| ID | Check | Status | Evidence/notes |
|---|---|---|---|
| PHY-027 | Background/resume after 1 minute preserves safe state | PENDING | |
| PHY-028 | Background/resume after 5 minutes preserves safe state | PENDING | |
| PHY-029 | Background/resume after 30 minutes preserves safe state | PENDING | |
| PHY-030 | Lock/unlock preserves or safely re-verifies state | PENDING | |
| PHY-031 | Force-quit and offline reopen succeeds | PENDING | |
| PHY-032 | Reboot and offline reopen succeeds | PENDING | |
| PHY-033 | Repeated portrait/landscape rotation produces no stale or clipped Live content | PENDING | |
| PHY-034 | Rotation while viewing a warning song remains readable | PENDING | |
| PHY-035 | Safari-tab and Home Screen launches behave consistently | PENDING | |
| PHY-036 | Persistence, usage, quota, and headroom are recorded without durability claims | PENDING | |
| PHY-037 | Engineering-assisted V2-origin eviction surrogate and online rebootstrap restores exact counts; skip if Safari cannot isolate the port-8001 entry | PENDING | |
| PHY-038 | Owner-approved low-free-storage test passes or is recorded as a blocking failure | PENDING | |
| PHY-039 | Replacement-worker drill: current Live is not forcibly replaced; close all V2 clients, reopen online, then verify successor and offline restart | PENDING | |

The compatible successor package is generated at
`migration/v2/phase1/checkpoint/update-drill/`. Engineering deploys and rolls it
back using that package's README and the main install/rollback runbook. Do not
force `skipWaiting` from DevTools.

## Gate G5 — Touch, keyboard, visibility, and performance

| ID | Check | Status | Evidence/notes |
|---|---|---|---|
| PHY-040 | All controls work by touch near screen edges and safe areas | PENDING | |
| PHY-041 | Rapid taps/double taps cannot skip unpredictably or expose stale content | PENDING | |
| PHY-042 | Left/Right navigation works on the approved external keyboard | PENDING | |
| PHY-043 | Page Up/Page Down/Space scroll a focused sheet column instead of changing songs | PENDING | |
| PHY-044 | Focus/progress announcements are understandable | PENDING | |
| PHY-045 | Bright mode is readable in representative daylight | PENDING | |
| PHY-046 | Stage Dark is readable in a dark rehearsal environment | PENDING | |
| PHY-047 | Browser chrome, safe areas, and on-screen keyboard obscure no required controls | PENDING | |
| PHY-048 | Three offline cold launches complete within the owner-approved threshold (proposed: 5 seconds) | PENDING | |
| PHY-049 | Rotation/resume refit completes within the owner-approved threshold (proposed: 2 seconds) | PENDING | |
| PHY-050 | No false fit: overflow is warned/scrollable, never silently clipped | PENDING | |

## Gate G6 — Rehearsal

| ID | Check | Status | Evidence/notes |
|---|---|---|---|
| PHY-051 | Complete rehearsal runs in Airplane Mode with fallback immediately available | PENDING | |
| PHY-052 | Duration, battery use, suspension, navigation errors, readability issues, mistakes, and fallback use are recorded | PENDING | |
| PHY-053 | All blocking findings are resolved and the rehearsal is repeated if needed | PENDING | |
| PHY-054 | Owner signs local stage-readiness decision | PENDING | |

## Gate G7 — Real-gig pilot

| ID | Check | Status | Evidence/notes |
|---|---|---|---|
| PHY-055 | Separate real-gig pilot completes with fallback immediately available | PENDING | |
| PHY-056 | Fallback drill is performed without modifying default routes | PENDING | |
| PHY-057 | Owner signs real-gig acceptance | PENDING | |

## Decision rules

- **Software checkpoint complete:** software matrix passes; physical remains pending.
- **Physical iPad offline accepted:** G1–G5 pass.
- **Local stage-ready:** G1–G6 pass.
- **Real-gig accepted:** G1–G7 pass.
- **Default-route change or v1 retirement:** requires G7 plus a separate owner
  cutover decision.
- **Writable work:** remains separately blocked by authorization, durable sync,
  publication fencing, server recovery, and browser export/recovery gates.

Any mandatory failure keeps the associated gate closed. Record failures rather
than weakening the criterion.
