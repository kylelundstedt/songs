# Separate-origin V1/V2 coexistence evidence

`coexistence-policy.json` selects the safest parallel topology:

- v1 default: `https://kgl-songs.exe.xyz/`;
- V2 opt-in pilot: `https://kgl-songs.exe.xyz:8001/`.

Because scheme/host/port define an origin, the explicit V2 port prevents the v1
root service worker from controlling V2. V2 reserves cache prefix
`songs-v2-shell-` and IndexedDB name `songs-v2`; v1 retains `songs-shell-` and
`songs`.

`browser-observations/` records two Chromium loopback origins. The v1 origin
proxies the exact frozen app and observes its real `songs-shell-v28` worker
cache and absence of IndexedDB. The second origin is explicitly a synthetic V2
namespace reservation using `songs-v2-shell-*` and `songs-v2`.
`browser-summary.json` validates those observations against the policy.

This proves the selected origin-partitioning mechanism, not the future V2 shell,
public port 8001 proxy, or physical Safari/iPad behavior. Those remain P1-004
and physical-acceptance gates.

```sh
python3 scripts/build_v2_current_contracts.py --check
python3 scripts/serve_v2_current_coexistence_harness.py
# Evaluate coexistence/capture-browser.js on each origin, then:
# await captureCurrentCoexistence('v1')  # and 'v2' on the V2 probe origin
python3 scripts/build_v2_current_coexistence_summary.py --check
```

If the separate origin cannot be retained, `/v2/` deployment is blocked until
the v1 root worker gains an explicit V2 bypass and controller-handoff tests pass.
