# TASK-015 / P1-008 hardening evidence

This directory records current-release native Chromium evidence for the complete
isolated read-only V2 slice.

- `browser-observations/` contains desktop, tablet portrait, tablet landscape,
  and phone captures from Chrome 151 using production shell
  `shell-39849548e3b7192a1c76aa6e`.
- `route-summary.json` records seven canonical routes and five invalid hashes in
  every profile.
- `offline-summary.json` records cold reloads of every canonical route after the
  reverse-proxy upstream was disabled, with zero API and post-ready fetch/XHR
  requests.
- `isolation-summary.json` records strict unknown-path behavior, the unchanged
  active pointer, and V2-only cache/database namespaces.
- `screenshots/` captures locked Live in all four profiles.
- `hardening-summary.json` validates and binds all evidence to the current shell
  and reviewed bootstrap trust anchors.

The native capture starts every fresh profile directly in locked Live, proving
that direct Live entry installs and controls the worker before an offline cold
reload. It also runs axe on representative surfaces, verifies 44px/48px control
targets, reduced motion, `aria-current`, keyboard Live navigation, focused-column
paging, canonical Apex links, responsive overflow, PWA launch, malformed hashes,
and unknown online/offline document paths.

Reproduce or validate:

```sh
node scripts/capture_v2_phase1_hardening_evidence.mjs --check
python3 scripts/build_v2_phase1_hardening_evidence.py --check
make v2-check
```

The capture uses `/headless-shell/headless-shell`, Node's built-in CDP WebSocket,
and a temporary loopback reverse proxy that adds the trusted development headers
to the already-running `songs-v2-api` service. `--check` writes only to a temporary
directory.

This is Chromium software evidence, not physical Safari/iPad acceptance. Home
Screen installation, persistence and eviction, background suspension, process
restart, rotation, real touch/external-keyboard ergonomics, and rehearsal/gig
acceptance remain pending and mandatory.
