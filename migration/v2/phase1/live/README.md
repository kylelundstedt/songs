# TASK-014 offline Set List and locked-Live evidence

This directory records software evidence for complete read-only performance
sequences over the matching active IndexedDB snapshot.

- `browser-observations/fitter-*.json` runs the production TypeScript fitter over
  all 339 authoritative Apex documents at the frozen measurement surfaces. All
  1,017 profile results match the frozen status, body-size, line-height, and
  column-count contract: 339 portrait fits, 334 landscape fits plus five named
  warnings, and 339 one-column scrolling phone results. Exact FitBox dimensions
  are surface geometry, not a cross-surface parity requirement.
- `browser-observations/live-latest-*.json` traverses all 58 immutable
  occurrences of the latest Set List in the actual production Live route.
- `live-offline-network.json` records a direct Live reload with the API process
  inactive and zero API or post-ready navigation requests.
- `live-accessibility-landscape.json` and `live-phone.json` record Stage Dark,
  Bright, warning, axe, keyboard-scroll, contrast, responsive-overflow, and 48px
  touch-target results.
- `live-pointer-invalidation.json` records a changed active pointer stopping the
  mounted Live sequence and requiring verified reload.
- `screenshots/` captures the explicit landscape warning and long phone sheet.
- `live-summary.json` binds all evidence to shell release
  `shell-8e20346e9b3ac2579dee901a` and bootstrap generation
  `phase1-f9634173e25ef4ca4b8330a3`.

The corpus harness is served from the repository root with Vite and imports the
same production fitter and stylesheet:

```sh
./v2/node_modules/.bin/vite --host 127.0.0.1 --port 8318 --strictPort .
# Open /scripts/live-fit-harness.html at each approved profile, then evaluate:
# await window.captureLiveFit("ipad-portrait")
# await window.captureLiveFit("ipad-landscape")
# await window.captureLiveFit("phone")
python3 scripts/build_v2_phase1_live_evidence.py --check
```

`build_v2_phase1_live_evidence.py --check` validates the committed captures and
source/test contracts; it does not automate Chromium or DevTools. To reproduce
the actual-route observations, bootstrap a fresh isolated origin, enter the
latest Set’s exact Live hash, stop `songs-v2-api`, reload, clear DevTools
Network, traverse all 58 occurrences with Previous/Next, and export the fields
used by `live-latest-*.json`. Repeat at 1366×1024, 1024×1366, and 390×844;
run axe on occurrence 39 in Stage Dark and Bright, and mutate the
`active-generation` meta row to reproduce the fail-closed pointer capture.

Chromium evidence is software proof only. Physical Safari/iPad fitting,
keyboard/touch behavior, background suspension, and performance acceptance
remain pending and mandatory.
