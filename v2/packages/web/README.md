# KGL Songs V2 read-only shell

React/Vite shell for TASK-011 through TASK-014. The production build is generated
deterministically into `internal/v2shell/data/` and embedded by `cmd/v2api` on
the isolated port-8001 origin.

## Boundaries

- bootstrap data is not exposed to React until the reviewed manifest and all 12
  chunk byte/hash descriptors verify;
- exact canonical source and Apex HTML hashes are checked in the browser;
- Apex HTML is displayed as renderer authority; no browser Markdown renderer is
  included;
- verified raw manifest/chunks and decoded source artifacts stage under physical
  instances in `songs-v2`; one generation-plus-transition CAS pointer activates
  content only after durable readback verification;
- the immediate predecessor is retained, accepted predecessors recover offline,
  and corrupt active bytes repair into a distinct physical instance;
- deterministic song/Set List indexes and search are constructed only for the
  verified snapshot matching the active IndexedDB pointer; inactive verified
  sessions expose runtime status but no catalog selectors;
- active-generation diagnostics expose exact current routes, references,
  deleted-baseline exclusions, fit warnings, freshness, persistence, and
  origin-wide quota/headroom;
- the service worker caches shell assets only under `songs-v2-shell-*`,
  explicitly bypasses `/api/v2/`, opens no database, serves its named cache
  offline, and publishes a bootstrap-compatibility contract for updates;
- there are no edit, reorder, provider, sync, publication, or Git controls;
- physical Safari/iPad acceptance remains pending.

## Commands

```sh
npm --prefix v2 run check --workspace @songs-v2/web
npm --prefix v2 run test --workspace @songs-v2/web
npm --prefix v2 run build --workspace @songs-v2/web
npm --prefix v2 run fixtures --workspace @songs-v2/web
python3 scripts/build_v2_phase1_storage_evidence.py --check
```

For local Vite development, `/api/v2/` is proxied to the production-shaped Go
service on port 8001 with a development-only identity header. Deployment never
runs the Vite development server.
