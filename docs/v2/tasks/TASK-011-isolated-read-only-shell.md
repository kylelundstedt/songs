# TASK-011: Isolated React/Vite Read-Only Shell

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Ready
- **Estimate:** 2–3 focused engineering days

## Objective

Build the isolated TypeScript/React PWA shell on the V2 origin and consume
TASK-010's reviewed bootstrap manifest/chunks without changing v1 routing,
service-worker control, storage, or renderer authority.

## Scope

- serve a React/Vite shell from the port-8001 V2 command alongside `/api/v2/`;
- implement independent V2 manifest, service worker, cache names, IndexedDB
  names, update state, and accessibility/theme foundation;
- fetch and verify the complete TASK-010 manifest/chunk hash chain before
  exposing an in-memory snapshot to the UI;
- provide read-only library, lead-sheet, Set List, loading, update, offline, and
  typed failure surfaces using authoritative Apex HTML;
- keep the physical Safari/iPad gate explicitly pending.

Do not add browser writes, local Markdown rendering authority, sync submission,
Git publication, default-route cutover, or v1 worker/controller changes.

## Acceptance criteria

- the V2 shell is reachable only on the isolated origin and disabling its
  service leaves v1 unchanged;
- all API/schema/auth/corruption failures render explicit V2 states and never a
  v1 or generic HTML fallback;
- the shell does not display a snapshot until all expected chunks verify; full
  IndexedDB staging/activation remains P1-005 scope;
- V2 service-worker/cache/storage identifiers cannot collide with v1;
- keyboard, focus, landmarks, contrast, reduced-motion, and loading/error status
  behavior pass automated checks;
- Chromium profiles pass as software evidence while physical Safari/iPad
  acceptance remains pending.
