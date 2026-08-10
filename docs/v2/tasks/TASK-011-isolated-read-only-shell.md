# TASK-011: Isolated React/Vite Read-Only Shell

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Done on August 10, 2026
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

## Completed evidence

- `@songs-v2/web` builds a deterministic React/Vite shell bound to TASK-010 manifest SHA `a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f`;
- release `shell-72d3106d38dfec5cc2eaf403` is embedded and validated through reviewed asset-manifest SHA `50642922b9a7e021cb7357b2254bb52abd1083c70fc77807e33d7671e1affb2a`;
- the browser exposes no documents until the manifest and all 12 chunk bytes/hashes, 373 sources, 339 Apex outputs, fit bindings, routes, entries, and counts verify;
- library, song, Set List, status, loading, authentication, corruption, offline, update, and explicit V2 not-found surfaces are read-only and contain no mutation controls or Markdown renderer;
- reviewed internal Apex links remain inside hash-routed V2, the one frozen inline list style is mapped to a CSP-compatible class, and external links must use HTTPS;
- the service worker caches only six shell assets under `songs-v2-shell-72d3106d38dfec5cc2eaf403`, bypasses `/api/v2/`, deletes only the V2 prefix, and opens no IndexedDB database;
- the origin process binds only `127.0.0.1:8001`; the public exe.dev proxy negotiates TLS 1.3, requires private login, rejects forged unauthenticated identity headers, and the application requires forwarded HTTPS identity;
- ten Vitest tests cover full bootstrap verification, terminal corruption races, redirect/auth errors, offline limitations, internal links, malformed routes, read-only UI, and axe checks on library/lead-sheet/Set-List surfaces;
- Chromium desktop, phone, and touch-tablet captures have no horizontal overflow, no authoring controls, exact snapshot counts, isolated cache names, and no database; light-theme small-text token contrast is at least 5.321:1;
- deterministic browser evidence is recorded under `migration/v2/phase1/shell/`; physical Safari/iPad acceptance remains pending;
- final adversarial architecture and code reviews found no remaining material issues.
