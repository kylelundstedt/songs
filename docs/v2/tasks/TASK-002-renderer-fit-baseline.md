# TASK-002: Renderer and Fit Baseline

- **Priority:** P0
- **Phase:** 0
- **Status:** Done (browser emulation recorded; physical-iPad validation remains pending)

## Objective

Freeze the exact v1 publication-rendering and browser-fit behavior that v2 must preserve or intentionally change. Produce reproducible machine-readable evidence from tag `v1`, while clearly separating browser emulation from physical-iPad validation.

## Scope

Record:

- Apex executable version and SHA-256;
- the exact renderer invocation, safety flags, CSS, fonts, templates, and relevant application assets at `v1`;
- supported browser viewport profiles and fit/readability rules;
- corpus-wide render success for all 291 tagged songs;
- representative semantic HTML fixtures covering headings, no headings, hard breaks, column breaks, annotations, metadata, and known fit boundaries;
- browser-profile fit outcomes for iPad portrait, iPad landscape, and phone;
- deterministic hashes for generated fixtures where practical;
- explicit physical-device tests that remain pending.

Do not rewrite the fitter or introduce the v2 renderer in this task.

## Procedure

1. Export `v1` to an isolated temporary tree.
2. Verify the pinned Apex executable and record its version/hash.
3. Build and run the tagged v1 application without changing the deployed v1 service.
4. Render every tagged song and fail on any renderer error.
5. Select representative fixtures by measurable corpus properties rather than convenience alone.
6. Run browser automation at the approved v1 viewport profiles and capture structured fit results plus a small screenshot set.
7. Document the exact comparison contract for future local-renderer work.
8. Re-run generation and verify deterministic machine-readable output.

## Acceptance criteria

- All 291 tagged songs have a recorded render result.
- The baseline names exact Git, Apex, CSS, JavaScript, template, and viewport inputs.
- Representative HTML and screenshot fixtures are traceable to tagged source hashes.
- Fit results distinguish `fit`, `needs-editing`, and unsupported/unverified cases.
- Browser emulation is never described as physical-device proof.
- A deterministic check command fails when baseline artifacts drift.
- Current v1 deployment and canonical corpus remain untouched.

## Completed evidence

- `migration/v2/renderer/renderer-baseline.json`: 291/291 tagged songs rendered successfully with Apex 1.1.14.
- Four deterministic song-only semantic fixtures cover available features; H2 and no-section-heading sheets are absent from v1 and recorded as explicit coverage gaps.
- `migration/v2/renderer/browser-fit/`: three raw Chromium-emulation captures with all 291 songs.
- `migration/v2/renderer/browser-fit-summary.json`: deterministic validation and distributions.
- `migration/v2/renderer/screenshots/`: portrait, landscape failure, and phone fixtures.
- Portrait: 291 fit; landscape: 289 fit and 2 need editing (`can-t-stop`, `paradise-city`); phone: 291 scrollable.
- Physical Safari/iPad validation is explicitly pending and is not implied by Chromium emulation.

## Verification commands

The implementation should provide focused commands shaped like:

```sh
python3 scripts/build_v2_renderer_baseline.py
python3 scripts/build_v2_renderer_baseline.py --check
python3 scripts/build_v2_browser_fit_baseline.py
python3 scripts/build_v2_browser_fit_baseline.py --check
python3 -m unittest tests/test_build_v2_renderer_baseline.py tests/test_build_v2_browser_fit_baseline.py
```
