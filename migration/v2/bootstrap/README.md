# TASK-006 atomic bootstrap storage spike

This is a disposable plain-HTML/JavaScript IndexedDB harness, not production UI.
`payload/` is generated only from a fresh `git archive v1` at
`546f59b41d9e9bcf0e81b543c27900a31e26c9e6`; it contains 351 tagged documents
(743,078 source bytes), canonical UTF-8/LF JSON chunks, and no worktree corpus
input. `bootstrap-baseline.json` records the deterministic generation, snapshot,
payload, and shell asset identities.

```sh
python3 scripts/build_v2_bootstrap_baseline.py
python3 scripts/build_v2_bootstrap_baseline.py --check
python3 scripts/serve_v2_bootstrap_harness.py --output-dir migration/v2/bootstrap/browser-observations
```

Open the printed loopback URL with `?profile=ipad-portrait` (then landscape and
phone). The stable browser-eval API is `window.BootstrapSpike`: `reset`,
`seedV1State`, `inspect`, `stage`, `activate`, `retry`, `cleanup`, `reopen`, and
`fullScenario` (plus `storage` and `serviceWorker`). It uses Web Crypto SHA-256;
fetching/hashing occurs before chunk write transactions, and activation updates
the previous retained snapshot, new active snapshot, and active pointer in one
transaction.

## `fullScenario()` result shape

`fullScenario()` returns JSON with these top-level fields:

```text
{
  baseline, generation, profile,
  scenario_proof: {
    schema_upgrade, interruption_failure, checksum_failure,
    previous_active_survived_failures, active_pointer_survived_failures,
    pending_writes_preserved, conflict_preserved,
    activation_pointer_transition_exactly_one,
    single_active_snapshot_and_pointer_authority, idempotent_retry,
    all_documents_readable, orphan_cleanup, service_worker
  },
  scenario: {
    schema: {seeded, upgraded, reopened_after_interrupt},
    stages: {interrupted, after_interrupted, orphan_cleanup, after_orphan_cleanup,
      corrupt, after_corrupt, success, after_success, idempotent_retry,
      after_idempotent_retry, final_cleanup},
    document_verification
  },
  documents, source_bytes, durations_ms, storage, service_worker
}
```

The v1 seed records the exact v1 store set. Reopen observes v2 and the added
`conflicts` store. Inspections include active generation/pointer state, snapshot
states, per-generation document counts, pending-write counts, and the old active
document's stored/content SHA-256 values.

## Recording Chromium observations

For each profile, start the server above, set **1x DPR** viewport/touch emulation,
and use a fresh profile-specific query string/database. Evaluate the following;
`observed` is collected from the browser rather than assumed:

```js
const profile = 'ipad-portrait'; // then ipad-landscape and phone
const requested = profile === 'ipad-portrait'
  ? {width: 1024, height: 1366, device_scale_factor: 1, mobile: false, touch: true}
  : profile === 'ipad-landscape'
  ? {width: 1366, height: 1024, device_scale_factor: 1, mobile: false, touch: true}
  : {width: 390, height: 844, device_scale_factor: 1, mobile: true, touch: true};
const result = await BootstrapSpike.fullScenario();
const capture = {
  schema_version: '1', ...result,
  profile: {
    name: profile, requested,
    observed: {
      inner_width: innerWidth, inner_height: innerHeight,
      device_pixel_ratio: devicePixelRatio,
      form_factor: profile === 'phone' ? 'phone' : 'tablet',
      max_touch_points: navigator.maxTouchPoints
    }
  },
  browser_engine: {
    name: 'Chromium', user_agent: navigator.userAgent, platform: navigator.platform
  }
};
await fetch(`/__observations/${profile}.json`, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(capture)
});
```

The validator requires all scenario proofs, exactly one active snapshot/pointer
authority, an idempotent post-activation retry with no extra pointer transition,
the actual non-null versioned service-worker cache, and at least 10× source-byte
quota headroom after usage. Then write/check the deterministic summary:

```sh
python3 scripts/build_v2_bootstrap_browser_summary.py
python3 scripts/build_v2_bootstrap_browser_summary.py --check
```

Quota and usage are **origin-wide browser estimates**: a profile's raw values and
before/after delta can include prior same-origin data and do not isolate this DB.
The summary reports those raw observations/deltas explicitly rather than claiming
otherwise. Physical Safari/iPad quota, eviction, persistence, and
background-suspension validation remain explicitly **pending**; Chromium
emulation is not Safari proof.
