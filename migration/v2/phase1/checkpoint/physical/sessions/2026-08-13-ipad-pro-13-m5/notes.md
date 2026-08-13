# Physical session notes

- Tester: owner
- Absolute UTC start/end: 2026-08-13T17:19:57Z / in progress
- Checkpoint summary SHA-256: `137b5a3f3841d516e15a082c18e6b630abceacb13ecd8efc2cdddf2f8fe265a2`
- Shell release: `shell-39849548e3b7192a1c76aa6e` (to verify on Status)
- Device model: iPad Pro 13-inch (M5)
- iPadOS/Safari build: iPadOS 26.6 / Safari build not yet recorded
- Launch mode: installed Home Screen web app
- Network conditions: online; exact network not recorded
- Free storage before/after: pending
- External keyboard: pending/not yet specified
- V1 fallback: pending confirmation

## Findings

- Owner reports the V2 link opens successfully as an installed iPad web app.
- Recorded PASS for PHY-001, PHY-006, and PHY-008. PHY-002 remains pending until a minimum supported iPadOS/Safari floor is approved.
- Screenshot `screenshots/status-library-diagnostics.png` confirms PHY-010: 373 documents, 339 songs, 34 Set Lists, 1,076 resolved / 0 unresolved references, and 373/373 indexed routes.
- The screenshot shows standalone web-app presentation and online state, but does not prove a fresh launch began at Library.
- Owner confirms closing/reopening starts at Library (PHY-009).
- Screenshot `screenshots/status-snapshot-storage-worker.png` confirms 12/12 chunks, active verified generation/storage, current service worker, offline restart availability (PHY-011/PHY-012), and advisory storage diagnostics (PHY-036).
- Screenshot `screenshots/library-reopen-readonly.png` visually labels the UI as having no mutation controls; direct owner confirmation remains requested before PHY-013 is marked PASS.
- No offline, lifecycle, readability, performance, rehearsal, or gig result is inferred.

## Signoff

Session is in progress. No physical acceptance or stage-readiness signoff yet.
