# KGL Songs V2 read-only shell

React/Vite shell for TASK-011. The production build is generated
deterministically into `internal/v2shell/data/` and embedded by `cmd/v2api` on
the isolated port-8001 origin.

## Boundaries

- bootstrap data is not exposed to React until the reviewed manifest and all 12
  chunk byte/hash descriptors verify;
- exact canonical source and Apex HTML hashes are checked in the browser;
- Apex HTML is displayed as renderer authority; no browser Markdown renderer is
  included;
- bootstrap data remains in memory only; IndexedDB name `songs-v2` is reserved
  but not opened before P1-005;
- the service worker caches shell assets only under `songs-v2-shell-*` and
  explicitly bypasses `/api/v2/`;
- there are no edit, reorder, provider, sync, publication, or Git controls;
- physical Safari/iPad acceptance remains pending.

## Commands

```sh
npm --prefix v2 run check --workspace @songs-v2/web
npm --prefix v2 run test --workspace @songs-v2/web
npm --prefix v2 run build --workspace @songs-v2/web
npm --prefix v2 run fixtures --workspace @songs-v2/web
```

For local Vite development, `/api/v2/` is proxied to the production-shaped Go
service on port 8001 with a development-only identity header. Deployment never
runs the Vite development server.
