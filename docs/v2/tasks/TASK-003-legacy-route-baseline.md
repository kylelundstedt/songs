# TASK-003: Legacy Route Baseline

- **Priority:** P1
- **Phase:** 0
- **Status:** Done

## Objective

Freeze the v1 HTTP and offline-routing contract that v2 must preserve, redirect deliberately, or retire explicitly. Generate fixtures from the exact `v1` tag without changing the deployed service.

## Scope

Record representative and generated cases for:

- canonical library, song, Set List, and Live routes;
- JSON/catalog and offline-manifest routes used by the v1 client;
- static application-shell assets and service-worker scope;
- historical aliases, filename/case behavior, trailing slashes, encoded IDs, and missing resources;
- authentication-sensitive or mutating routes as metadata-only cases that are not executed destructively;
- response status, content type, cache/security headers, redirect target, and stable semantic markers rather than volatile timestamps.

## Procedure

1. Export and build tag `v1` in an isolated temporary tree and database.
2. Enumerate registered routes from the tagged server and classify read-only, mutating, provider-backed, and excluded cases.
3. Generate canonical cases from the tagged 291-song and 60-Set-List corpus.
4. Exercise read-only cases against the isolated server with a fixed host/header profile.
5. Normalize volatile response details while retaining status, headers, redirect location, and stable body evidence.
6. Record explicit exclusions for remote providers, LLM assistance, and destructive mutations.
7. Verify deterministic output and confirm the live deployment and canonical corpus are untouched.

## Acceptance criteria

- Every registered v1 route is represented by one or more fixtures or an explicit documented exclusion.
- All canonical song, Set List, Live, catalog, offline-manifest, and static routes are covered.
- Fixture generation uses only tag `v1` plus isolated operational state.
- Redirect, missing-resource, case, trailing-slash, and encoded-ID behavior is visible.
- Assertions avoid volatile build times, database timestamps, and machine-specific ports.
- A deterministic `--check` command detects route-contract drift.

## Completed evidence

- `migration/v2/routes/route-baseline.json` inventories all 27 v1 registrations.
- 1,158 isolated requests include 1,113 canonical corpus routes.
- All 291 song pages/JSON/Markdown and all 60 Set List/page/Live/Markdown/offline families return 200.
- Ten authenticated mutation or valid provider/LLM executions are explicitly excluded; nine safe unauthenticated mutation probes return 401.
- Edge fixtures preserve case sensitivity, encoded IDs, trailing slashes, aliases, method behavior, path cleaning, authentication boundaries, and static-directory behavior.
- The generator builds and runs only a fresh `git archive v1` tree with isolated SQLite state and no redirect following.

## Verification commands

The implementation should provide focused commands shaped like:

```sh
python3 scripts/build_v2_route_baseline.py
python3 scripts/build_v2_route_baseline.py --check
python3 -m unittest tests/test_build_v2_route_baseline.py
```
