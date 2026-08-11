# TASK-012 production IndexedDB evidence

This directory records software evidence for atomic production snapshot
activation in the TASK-011 shell.

- `browser-observations/chromium-production.json` records the native Chromium
  database schema, initial activation, deliberate active-chunk corruption,
  online repair into a distinct physical instance, retained prior instance,
  storage estimate, and cold restart while the origin process was stopped.
- `browser-observations/corruption-repair-network.json` records the exact
  manifest plus 12 chunk requests used by the repair.
- `screenshots/snapshot-status-after-repair.png` shows the read-only storage
  diagnostics after repair.
- `storage-summary.json` binds those observations to shell release
  `shell-48b974860e16510f36131506` and the reviewed bootstrap manifest.

The browser cold restart made zero `/api/v2/` requests. The service worker
served its own named shell cache while the window reverified the active
IndexedDB manifest, chunks, and 373 document artifacts before exposing routes.
The old corrupt physical instance remained retained; pending stores are outside
snapshot cleanup transactions.

Unit/integration tests additionally cover schema upgrade, blocked/newer/malformed
schemas, interruption, verified-stage reopen, CAS, idempotency, quota aborts,
stale-shell downgrade prevention, cross-manifest predecessor recovery, cleanup,
and zero-fetch offline startup.

Chromium evidence is software proof only. Physical Safari/iPad persistence,
eviction, Home Screen restart, background suspension, and low-storage acceptance
remain pending and mandatory.

```sh
node scripts/capture_v2_phase1_storage_evidence.mjs
node scripts/capture_v2_phase1_storage_evidence.mjs --check
python3 scripts/build_v2_phase1_storage_evidence.py --check
```
