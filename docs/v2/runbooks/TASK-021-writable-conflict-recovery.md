# TASK-021 Writable Conflict and Recovery Runbook

**Prepared:** August 14, 2026
**Operational state:** writable acceptance is `PENDING_OWNER_EXECUTION`.

This runbook protects locally committed and server-accepted authored work during
the TASK-021 controlled writable evaluation. It does not authorize a writable
pilot, a default-route change, V1 retirement, destructive browser cleanup, or
physical-device success. Keep V1 available throughout.

## Non-negotiable rules

- **V1 is immediate fallback:** `https://kgl-songs.exe.xyz/`. Do not stop or
  alter `songs.service` to investigate a V2 writable issue.
- **Disable before repair:** turn off the relevant V2 writable gates before a
  server/Git repair. The gates remain disabled by default: `-sync-enabled`,
  `-writable-enabled`, and `-lead-sheet-writable-enabled` are distinct.
- **Export before client intervention:** obtain a verified authored-state export
  from every reachable device before reload, revoke, restore, upgrade, or site
  data action. Record its SHA-256, timestamp, device ID, draft/outbox/conflict
  counts, and unresolved conflict IDs. Never export or record device tokens.
- **Do not clear browser data as recovery:** Safari website-data removal can
  delete the only local draft/outbox. It is prohibited until exports are
  verified and an owner explicitly approves a device-specific destructive drill.
- **Never improvise server/Git state:** do not edit sync/publication SQLite,
  force-push, reset a remote, or manually release a reservation to make a UI
  appear healthy. Preserve evidence and use the fenced recovery path.
- **Labels are not interchangeable:** local, queued, acknowledged/server,
  server-validated, published, and conflicted have different recovery actions.

## First response: preserve, classify, fall back

1. Record UTC time, release/commit, client device ID, route, online state,
   writable gates, visible state label, revision/operation/conflict IDs, error,
   and screenshot.
2. Export authored state from the affected device. If it cannot open, do not
   clear data; record that it is unavailable and preserve the device for
   engineering inspection.
3. For an operational need, use V1 immediately. V1 does not consume or repair
   V2 authored work.
4. Stop new writable sessions. If the incident involves server, validation,
   publication, Git, or multiple devices, disable the relevant writable gates
   before diagnosis.
5. Choose the narrowest row in the decision table. A retry is safe only when
   the durable operation identity and original envelope remain intact.

## Recovery decision table

| Condition | Safe immediate action | Do not do | Exit criterion |
|---|---|---|---|
| Offline or transport failure while local work is queued/failed | Export, retain local state, restore connectivity, then use the explicit foreground retry/pull flow. | Recreate the edit manually or delete the failed outbox row. | Same operation resolves idempotently or remains visibly queued/conflicted with its candidate retained. |
| Response uncertainty after apply | Export, pull/ack, inspect the operation/revision outcome, then retry the **same** immutable operation only if still unacknowledged. | Generate a replacement operation solely because the response was lost. | Exactly one server outcome is visible; no duplicate revision. |
| Explicit stale-write conflict | Export both devices, capture current and candidate revisions, then use keep-server, keep-local, or manual resolution. | Hide/close the conflict without selecting a recorded resolution; overwrite via API/DB. | Both candidates remain recoverable through recorded resolution/export; clients converge after pull/ack. |
| Client closes, crashes, backgrounds, or restarts | Reopen, inspect draft/outbox/conflict counts, export if unexpected, then retry foreground sync deliberately. | Treat an absent network request as proof work was never committed. | Local draft/revision/outbox state is present or a documented blocking failure is recorded. |
| Device is revoked/lost | Revoke the affected device, preserve any reachable export, and continue only from another authorized device. | Reuse its credential/device identity on a replacement device. | Revoked credential is rejected; retained local work is exportable/recoverable under owner control. |
| Quota/eviction/storage warning | Stop edits, export, record storage/quota/headroom, switch to V1 if needed, and schedule engineering review. | Clear Safari data or claim durability/persistence. | No partial commit; exports verify; approved recovery plan exists. |
| Failed lead-sheet validation | Preserve exact source/workspace and durable validation receipt/issues; correct and resubmit only after review. | Treat local preview as authoritative or publish an unvalidated candidate. | Original exact source remains available; next validation is tied to a new/current source hash. |
| Publication reserved, push/finalization failure, or external Git drift | Disable writable activity, preserve exports, collect server/publication diagnostics, and use fenced publisher recovery/reconciliation. | Force a Git push, edit ledger rows, or call a hidden publication shortcut. | Accepted revision, publication mapping, and Git bytes converge; no false `published` label. |
| Sync/publication ledger or remote needs restoration | Freeze writes, take/verify a coordinated package if possible, restore only to a new isolated destination, verify, then schedule controlled cutover. | Restore over a live directory, mix files from different backups, or enable writable gates before verification. | Verified sync DB, publication DB, Git bundle/head, and integrity checks agree before cutover. |
| Any unresolved or suspected data loss | Preserve evidence/exports, disable writable gates, use V1, and declare no-go pending remediation. | Continue the session hoping later sync fixes it. | Owner explicitly accepts a documented recovery or retest proves no loss. |

## Client conflict resolution order

1. On **each** device, make a verified export before changing a conflict.
2. Record conflict ID, document ID, server/current revision, local/candidate
   revision, operation ID, and cursor.
3. Inspect both candidate contents. For Set Lists, inspect duplicate occurrence
   IDs, order, and notes. For lead sheets, inspect exact source and validation
   state; do not assume a preview proves byte preservation.
4. Choose exactly one explicit product flow:
   - **Keep server:** record a resolution that adopts the current server
     candidate while preserving the local candidate in recovery evidence.
   - **Keep local:** record a resolution based on the current server head; do
     not reuse the stale base as a blind apply.
   - **Manual:** produce an intentional merged candidate, validate it as
     required, and record the resolution.
5. Pull and acknowledge on both devices. Compare current/published revision IDs
   and confirm no open conflict remains unintentionally.
6. Export final state from both devices. If any control, candidate, or audit
   record is missing, mark the checklist row `FAIL` and leave writable gates
   disabled.

## Coordinated server backup order

A coordinated package is the only supported server/Git recovery unit. The
implementation captures the sync ledger, publication ledger, and Git bundle
under the publication fence, rejects remote movement during capture, writes a
manifest, and verifies the package. Use an engineering-owned operation invoking
`Publisher.CoordinatedBackup` and `VerifyCoordinatedBackup`; this repository
does not document an ad-hoc shell copy as an equivalent.

1. Announce maintenance and stop new writable work; verify V1 is healthy.
2. Export every active client and record hashes/counts/conflicts.
3. Disable V2 writable gates and ensure no unreviewed publisher/recovery job is
   running. Preserve service and publisher logs.
4. Create the coordinated package into a **new empty destination**.
5. Verify the package before trusting it. Record manifest SHA-256, ledger base,
   remote head, schema versions, and verification result.
6. Keep the package immutable. Do not add live SQLite journal files or a second
   Git clone to it.
7. Re-enable writable gates only after the incident is resolved and the owner
   authorizes the next controlled session.

## Restore order — never restore in place

`RestoreCoordinatedBackup` is designed to verify the full package and restore
into one new destination. The order is deliberate: sync state, publication
state, and Git history must come from one verified package.

1. **Freeze:** keep writable gates off; keep V1 running and verify it works.
2. **Preserve clients:** export each reachable client; record unrecoverable
   devices without clearing them.
3. **Preserve current server evidence:** retain logs and take a verified
   coordinated backup of the current state when the incident permits. If this
   is impossible, document why before proceeding.
4. **Verify selected package:** run the supported verification and compare the
   manifest's ledger base and remote head to the incident record. Stop on any
   mismatch.
5. **Restore isolated:** restore the selected package into a new, empty,
   non-live destination; never overwrite the live sync DB, publication DB,
   remote, or lock path.
6. **Verify isolated state:** run sync/publication integrity checks, inspect the
   restored Git head/bundle, and reconcile only through the fenced publisher
   path. Confirm current revision/publication mappings are coherent.
7. **Controlled cutover:** with writable gates still off, configure a planned
   maintenance cutover to the verified restored paths. Keep the prior live
   state untouched for rollback.
8. **Read-only smoke test:** authenticate, pull/snapshot, and confirm V1 and
   read-only V2 behavior. Do not submit authorship yet.
9. **Client reconciliation:** on each device, export first, pull/ack, inspect
   drafts/outbox/conflicts, and resolve explicit conflicts. Never overwrite a
   restored head with a client draft.
10. **Reauthorize writing:** only after owner review, successful two-device
    reconciliation, and documented decision may the independent writable gates
    be enabled for a new controlled session.

## V1 fallback and rollback

At any point, the user-facing recovery is to open V1 at the default origin.
Stopping V2 writable access or rolling back V2 must not change V1 routes,
service, worker, storage, or content. A V2 rollback does not repair client
IndexedDB; preserve client exports first and reconcile them only after the
replacement server state is verified.

For a V2 service/release rollback, follow the existing P1-009 install/rollback
runbook's exact release/backup procedure. Do not build into a live executable
or construct a partial backup. After rollback, verify V1 first, then V2
read-only access; writable gates remain off until TASK-021 acceptance is
completed.

## Required incident record

- absolute UTC time and operator;
- release/commit, V2 origin, and enabled gate values;
- device model/OS/Safari/launch mode and non-secret device ID;
- document/revision/operation/conflict IDs and cursor values;
- local/queued/server/validated/published/conflicted label observed;
- authored export hashes and counts before/after;
- validation/publisher/service logs and coordinated-backup manifest/hash, if
  applicable;
- V1 fallback verification;
- decision-table row used, exact recovery action, final convergence result;
- unresolved risks and owner disposition.

## Physical prerequisites still pending

The following read-only G4 checks remain `PENDING` on August 14, 2026 and block
writable physical acceptance until owner execution: **PHY-028, PHY-029,
PHY-032, PHY-037, and PHY-038**. The deterministic TASK-021 evidence inventory
cannot change those states or claim an iPad pass.
