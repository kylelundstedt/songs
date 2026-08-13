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
- Owner directly confirms no Edit, Save, Add, Delete, Publish, Sync, Provider, or Pin controls anywhere; PHY-013 passes.
- Owner reports three consecutive successful Airplane-Mode cold launches, each subjectively instant; numeric seconds were not measured (PHY-014).
- Owner reports Library, Songs, Set Lists, and Status all work offline (PHY-015). Screenshot `screenshots/offline-library-after-three-launches.png` visibly shows Airplane Mode and the active verified IndexedDB snapshot.
- Owner confirms offline song `1979`, Set List `9Tease Stripped`, and direct locked Live all open successfully (PHY-016–PHY-018). No screenshot was required while the device remained intentionally disconnected.
- Owner confirms all requested offline song-field and Set List date/location searches returned the expected reviewed items (PHY-019/PHY-020). Results were not always unique; this is recorded and does not violate the search criterion.
- Owner confirms complete 58-occurrence offline traversal, bounded Previous/Next, both themes, occurrence-39 Can’t Stop warning, and readable scrolling without clipping or stale/skipped navigation (PHY-021–PHY-025). Screenshot: `screenshots/offline-live-occurrence-39-cant-stop.png`.
- Owner confirms all five landscape-warning songs displayed expected warnings and remained usable (PHY-026).
- G3 offline workflows (PHY-014–PHY-026) pass on this exact device/session.
- Owner confirms 1-minute background/resume, lock/unlock, force-quit offline reopen, repeated rotation, and warning-song rotation all remained safe, readable, and free of stale/silently clipped content (PHY-027, PHY-030, PHY-031, PHY-033, PHY-034, PHY-050).
- Owner explicitly deferred the 5-minute background, 30-minute background, and reboot/offline-reopen checks because continued Airplane Mode was not practical during this session. PHY-028, PHY-029, and PHY-032 remain PENDING, not failed.
- Owner confirms the Auto-Lock → Never operating procedure, V1 default-origin health, and consistent verified content between Safari-tab and Home Screen launches (PHY-003, PHY-005, PHY-035).
- Owner agrees to keep an independent V1 or printed/PDF fallback immediately available during rehearsal/performance (PHY-004).
- Owner proposed printable Set List/lead-sheet packages and CSV/XLSX/Google Sheets interchange; proposals are tracked as TASK-017 and TASK-018 without changing current read-only/cutover gates.
- Owner confirms touch/safe-area controls, rapid-tap safety, Bright-mode daylight readability, on-screen keyboard visibility, and rotation/refit within about two seconds (PHY-040, PHY-041, PHY-045, PHY-047, PHY-049).
- Owner confirms external-keyboard Left/Right navigates Previous/Next and Space or Fn+Up/Down scrolls the focused lead-sheet column without changing songs (PHY-042/PHY-043).
- Owner removed VoiceOver/focus-announcement testing from the owner acceptance scope. PHY-044 remains non-PASS and no VoiceOver compatibility claim is made.
- Owner confirms Stage Dark readability in a dim room and all three offline cold launches under five seconds (PHY-046/PHY-048); exact launch seconds were not measured.
- Owner approves the initial support floor as iPad Pro 13-inch (M5), iPadOS 26.6 or newer (PHY-002), without claiming other-device support.
- Owner confirms Private Safari unauthenticated access stops at the exe.dev login boundary with no song content exposed (PHY-007).
- G1 supported-device contract, G2 authentication/install/bootstrap, and G3 offline workflows now pass for this exact session.
- PHY-039 replacement-worker drill passes: active locked Live was not interrupted; after all clients closed, the successor reopened with current worker, unchanged verified bootstrap, and offline restart; owner confirmed successor offline cold launch. Engineering then restored and verified the checkpoint server release.
- The Status UI displays only the generic shell cache prefix, so it cannot independently display the exact active shell release; this testability limitation is recorded rather than overstated.
- After checkpoint rollback and another all-clients-close cycle, owner confirmed the reopened client reports service worker current and offline restart available.
- No rehearsal or gig result is inferred.

## Signoff

Session is in progress. No physical acceptance or stage-readiness signoff yet.
