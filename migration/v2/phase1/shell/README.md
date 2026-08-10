# TASK-011 isolated-shell evidence

This directory records software evidence for the production V2 shell served on
the isolated port-8001 origin.

- `browser-observations/` records Chromium desktop, phone, and touch-tablet
  surfaces plus a public-DNS probe of the exe.dev TLS/private-login boundary.
- `screenshots/` captures the verified library, lead-sheet, and Set List UI.
- `browser-summary.json` binds those captures to shell release
  `shell-72d3106d38dfec5cc2eaf403` and bootstrap generation
  `phase1-f9634173e25ef4ca4b8330a3`.

The browser capture used the production embedded shell/API through a localhost
reverse proxy that injected the trusted headers exactly as recommended by the
exe.dev development documentation. A separate public-DNS probe bypassed the
VM-internal hostname mapping and confirmed TLS 1.3, private login redirects,
rejection of a forged identity header before the application, and application
rejection of direct forged headers.

The service worker controls only the isolated V2 origin, caches only
`songs-v2-shell-*` assets, bypasses `/api/v2/`, and opens no IndexedDB database.
The evidence is Chromium software proof, not physical Safari/iPad acceptance.

```sh
python3 scripts/build_v2_phase1_shell_evidence.py --check
npm --prefix v2 run check --workspace @songs-v2/web
npm --prefix v2 run test --workspace @songs-v2/web
npm --prefix v2 run fixtures --workspace @songs-v2/web
go test ./internal/v2shell ./internal/v2bootstrap
```
