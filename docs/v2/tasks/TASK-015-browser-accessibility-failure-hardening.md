# TASK-015: Browser, Accessibility, Route, Update, and Failure Hardening

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Complete (August 11, 2026)
- **Phase packet:** P1-008
- **Estimate:** 3–5 focused engineering days

## Objective

Harden the complete isolated read-only V2 slice across production-shaped browser
profiles, offline restart, routing, active-pointer authority, service-worker
updates, accessibility, and retained-snapshot failures before packaging the
software checkpoint.

## Scope

- automate current-release Chromium desktop, tablet portrait, tablet landscape,
  and phone profiles;
- cold-reload every canonical read-only route with the upstream unavailable and
  assert zero API and post-ready fetch/XHR activity;
- reject malformed hashes and unknown document paths without v1 or shell
  fallback;
- require the exact physical IndexedDB pointer and monotonic transition epoch
  before exposing any active catalog route;
- broadcast pointer changes across tabs with polling and foreground checks as a
  fail-closed fallback;
- require a compatible controlling worker before claiming offline restart;
- report waiting-worker compatibility but disable immediate `skipWaiting` activation;
  replacement workers activate only after all existing V2 clients close, so an
  open locked-Live client cannot be claimed by a replacement worker;
- preserve typed IndexedDB open failures and canonical V2 Apex links;
- verify landmarks, headings, `aria-current`, keyboard behavior, reduced motion,
  axe, touch targets, and responsive overflow;
- preserve separate-origin, cache, database, and v1-default boundaries.

Do not add editing, sync, publication, provider controls, root-route cutover, or
physical Safari/iPad claims.

## Acceptance criteria

- all Phase 0/current-baseline and TASK-011 through TASK-014 deterministic checks
  pass;
- seven canonical routes and five invalid hashes pass in four Chromium profiles;
- every canonical route cold-reloads offline in every profile with zero API or
  post-ready application requests;
- unknown document paths return 404 online and never receive cached shell
  fallback offline;
- direct first-load locked Live installs and controls the worker and then reloads
  offline;
- active route exposure requires exact physical generation plus transition epoch;
- waiting updates remain deferred until every existing V2 client closes; the
  production worker exposes no immediate `skipWaiting` activation path;
- corrupt/interrupted preferred updates retain or recover the reviewed active
  snapshot;
- normal controls are at least 44 CSS pixels and Live controls at least 48 CSS
  pixels, with zero Chromium axe violations on the captured surfaces;
- V2 remains opt-in on its isolated origin with only `songs-v2-shell-*` cache and
  `songs-v2` IndexedDB namespaces;
- physical Safari/iPad acceptance remains pending and mandatory.

## Completion evidence

- shell release `shell-39849548e3b7192a1c76aa6e` binds asset manifest SHA-256
  `d3dfa5f989efa38ce237034a6f5df4834d9101195794cd124a5427c66c3dc6c7`
  to the reviewed bootstrap generation;
- native Chrome 151 automation covers four profiles, 28 canonical online route
  checks, 20 invalid-hash checks, 28 cold offline route reloads, and 24 axe
  surface checks;
- all offline route reloads make zero `/api/v2/` requests and zero post-ready
  fetch/XHR calls while retaining the same active physical pointer, transition
  epoch, 12 chunks, and 373 document artifacts;
- direct first-load Live establishes the worker/cache before the upstream is
  disabled; the same Live route then cold-reloads from the verified local
  snapshot;
- the PWA starts at `/#/`; unknown pathnames return 404 online and do not receive
  worker fallback offline;
- current Apex internal links are canonical `#/songs/:slug` URLs for ordinary,
  keyboard, auxiliary, and new-tab activation;
- 95 web tests cover storage/runtime, active-pointer epoch gating and post-read
  authority races, route closure, offline-ready worker requirements, safely
  deferred waiting-worker activation, accessibility, search, and fitting;
- reproducible evidence and screenshots are under
  `migration/v2/phase1/hardening/`, with deterministic validation through
  `scripts/build_v2_phase1_hardening_evidence.py --check` and native recapture
  through `node scripts/capture_v2_phase1_hardening_evidence.mjs --check`;
- physical Safari/iPad Home Screen, persistence/eviction, suspension, rotation,
  keyboard/touch ergonomics, and performance acceptance remain pending.
