# Current renderer and browser-fit evidence

`renderer-baseline.json` and `html/` are generated from the frozen Phase 1 tag.
Apex 1.1.14 renders 339/339 songs.

`browser-fit/` contains recorded Chromium inputs validated into
`browser-fit-summary.json`. Status is checked against captured viewport/column
geometry, and screenshot typography is bound to the associated capture.
Portrait fits 339/339; landscape fits 334/339 and
marks `can-t-stop`, `father-of-mine`, `love-shack`, `paradise-city`, and
`troublemaker` `needs-editing`; phone records 339/339 scrollable results.
Screenshots bind representative source hashes and observed fit state.

```sh
python3 scripts/build_v2_current_renderer_baseline.py --check
python3 scripts/serve_v2_current_fit_harness.py
# At each requested browser profile, evaluate renderer/capture-browser.js and:
# await captureCurrentFit('ipad-portrait')  # then landscape and phone
python3 scripts/build_v2_current_browser_fit_baseline.py --check
```

Chromium emulation is not physical Safari/iPad acceptance.
