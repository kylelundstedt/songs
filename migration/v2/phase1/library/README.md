# TASK-013 offline library/search/status evidence

This directory records software evidence for deterministic catalog selectors over
the active verified IndexedDB pointer generation.

- `browser-observations/chromium-offline-library.json` records a full reload
  while the API process was inactive, zero `/api/v2/` requests, local song and
  Set List searches, exact reviewed diagnostics, Chromium axe results, keyboard
  focus restoration, touch target measurements, and responsive overflow checks.
- `screenshots/desktop-status.png` captures active-generation diagnostics.
- `screenshots/phone-song-search.png` captures the touch/phone song library.
- `library-summary.json` binds those artifacts to shell release
  `shell-89785e5935f3ee0eea606eca` and bootstrap generation
  `phase1-f9634173e25ef4ca4b8330a3`.

Catalog indexes are constructed only when the verified snapshot matches the
active IndexedDB pointer. Network, memory-only, and retained recovery snapshots
expose runtime/storage status but keep catalog selectors closed. An update
failure with a still-matching active pointer remains browseable and searchable.

The evidence is Chromium software proof only. Physical Safari/iPad keyboard,
touch, persistence, eviction, background, Home Screen, and low-storage
acceptance remain pending and mandatory.

```sh
python3 scripts/build_v2_phase1_library_evidence.py --check
npm --prefix v2 run check --workspace @songs-v2/web
npm --prefix v2 run test --workspace @songs-v2/web
npm --prefix v2 run fixtures --workspace @songs-v2/web
go test ./internal/v2shell ./internal/v2bootstrap
```
