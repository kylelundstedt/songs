# V1 renderer baseline

This directory freezes the deterministic source, Apex, asset, rendered-HTML, and
recorded browser-fit inputs for TASK-002. The renderer generator exports a fresh
archive of tag `v1` at `546f59b41d9e9bcf0e81b543c27900a31e26c9e6`; it never reads
mutable `songs/`, `sets/`, `srv/`, or other working-tree inputs.

```sh
python3 scripts/build_v2_renderer_baseline.py
python3 scripts/build_v2_renderer_baseline.py --check
python3 scripts/build_v2_browser_fit_baseline.py
python3 scripts/build_v2_browser_fit_baseline.py --check
python3 -m unittest tests/test_build_v2_renderer_baseline.py tests/test_build_v2_browser_fit_baseline.py
```

`renderer-baseline.json` records the exact v1 renderer inputs, hashes and byte
counts for all 291 tagged songs and successful Apex output, relevant assets,
fitter constants, and viewport profiles. Representative HTML fixtures are
**songs only**: feature analysis examines the lead-sheet body after front matter,
so metadata arrays are not lyric annotations. The corpus has no H2 or
no-section-headings song; those are recorded in `representative_coverage_gaps`
instead of being represented by README or set-list Markdown. Regeneration safely
removes stale direct HTML fixtures under `migration/v2/renderer/html/`.

The three files under `browser-fit/` are raw recorded browser-emulation captures;
they are not regenerated browser output. `build_v2_browser_fit_baseline.py`
validates their exact v1 baseline, requested profiles, 291-song path and source
hash sets, measurement surface, allowed measurements, and consistent captured
Chromium identity, then writes canonical `browser-fit-summary.json`. The
checked-in PNGs are independently hashed and dimension-checked and mapped to
portrait Paradise City (fit), landscape Paradise City (needs-editing), and
phone 1979 (scrollable). Their records also preserve the body size, line height,
and column count observed on the actual v1 `/song/{id}` route after `fitAll`.
Observed outcomes are 291/291 portrait fits,
289/291 landscape fits with `can-t-stop` and `paradise-city` needing editing,
and 291/291 phone results scrollable.

The captures identify Chromium emulation (their user agent contains a Safari
compatibility token); they do not claim Safari behavior. Physical-iPad
validation remains pending.
