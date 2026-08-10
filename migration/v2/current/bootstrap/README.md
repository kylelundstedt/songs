# Current atomic bootstrap evidence

The deterministic payload contains 12 chunks, 373 documents, and 748,034 source
bytes from the frozen Phase 1 tag. The TASK-006 harness is copied byte-for-byte
from pinned commit `10711bed6373b3d58f0ae2cfe1169e547fdf638a`; it is not read
from mutable working-tree files. Every raw observation records the exact
bootstrap-baseline hash, payload-manifest hash, harness asset hashes, and harness
source commit, so stale observations fail validation.

All 13 logical proofs pass in three Chromium profiles. Successful activation
measured 94.3–128.4 ms; all profiles retained the previous snapshot and pending
state through interruption/corruption/upgrade/retry scenarios. Persistence was
not granted. Quota observations are origin-wide and are not physical Safari or
eviction proof.

```sh
python3 scripts/build_v2_current_bootstrap_baseline.py --check
python3 scripts/serve_v2_bootstrap_harness.py \
  --root-dir migration/v2/current/bootstrap \
  --output-dir migration/v2/current/bootstrap/browser-observations
# At each requested browser profile, evaluate bootstrap/capture-browser.js and:
# await captureCurrentBootstrap('ipad-portrait')  # then landscape and phone
python3 scripts/build_v2_current_bootstrap_browser_summary.py --check
```
