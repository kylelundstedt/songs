# TASK-017: Production Authorization and Durable Sync Foundation

- **Priority:** P0
- **Phase:** Post-Phase-1 writable foundation
- **Program:** First writable V2 slice
- **Status:** Complete (August 13, 2026)
- **Dependencies:** TASK-005 sync feasibility; TASK-009 identities; TASK-012 storage
- **Estimate:** 7–11 focused engineering days

## Objective

Establish the production server/device boundary and durable operation protocol
required before any V2 browser mutation can be accepted. This task delivers
infrastructure and test harnesses, not a polished editing interface.

## Scope

- bind authenticated owner identity to registered devices;
- enforce owner ACLs independently of forwarded-header spoofing;
- define versioned mutation envelopes with device ID, operation ID, canonical
  payload hash, expected document revision, and client cursor;
- persist operations and acknowledgements durably in SQLite before responding;
- provide idempotent retry, compare-and-swap validation, acknowledged pull/push
  cursors, and explicit stale-write conflict results;
- define compaction/resnapshot and device-revocation behavior;
- expose authenticated health/diagnostic endpoints without leaking content;
- add deterministic multi-device, retry, duplicate, stale-cursor, authorization,
  and crash-boundary tests.

## Excluded

- browser editing UI;
- Git publication or provider integrations;
- visual redesign;
- printing/export;
- default-route cutover or V1 retirement.

## Acceptance criteria

- unauthorized actors/devices cannot read mutation state or submit operations;
- the same operation can be retried indefinitely without duplicate effects;
- operation ID reuse with different canonical bytes fails explicitly;
- stale writes preserve candidate content as conflicts rather than overwriting;
- cursors advance only after durable receipt and explicit acknowledgement;
- restart/crash tests preserve operation, conflict, and acknowledgement state;
- backup/restore reproduces the exact ledger and device authorization state;
- no browser mutation control ships merely because the server foundation passes.

## Rollback

Disable mutation endpoints and device registration; leave the read-only V2 pilot
and V1 default path unchanged.
