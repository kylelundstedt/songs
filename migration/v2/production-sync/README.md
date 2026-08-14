# TASK-017 production authorization and durable sync evidence

This package is the deterministic acceptance runner for the production V2
owner/device authorization and durable SQLite sync foundation. It uses temporary
databases and in-process HTTP requests only. It does not start a listener, touch
canonical song/set content, publish Git state, or enable browser mutation UI.

Regenerate or verify the checked-in canonical evidence:

```sh
go run ./cmd/v2sync-evidence
python3 scripts/build_v2_production_sync_evidence.py
python3 scripts/build_v2_production_sync_evidence.py --check
```

The Python builder requires the runner's stdout to be exactly two-space-indented
UTF-8 JSON with one final LF. It also rejects dates/timestamps, absolute paths,
hostnames or network addresses, email addresses, and fields that could expose
credentials, secrets, token digests, or operation fingerprints.

## What the runner proves

- Trusted owner identity requires the configured secure proxy assertions and a
  loopback peer. Forwarded-address, body/query owner, request-host, and device
  body spoofing do not change the authenticated principal.
- Device registration is deterministic and retry-idempotent, while a changed
  registration is rejected. The checked-in evidence records only the public
  registration metadata, never the generated credential.
- Missing, wrong, unknown-device, and query-supplied credentials receive the
  same public denial. Authenticated diagnostics are `private, no-store` and
  contain counts only, with no content or credential material.
- An injected post-commit response loss leaves one durable operation, revision,
  and event. Retrying returns the exact durable outcome; changing canonical
  bytes under the same operation ID fails explicitly.
- A stale write becomes a content-preserving conflict. A resolution whose
  document base has advanced fails CAS and leaves its conflict open; a fresh
  stale candidate can then be resolved by an atomic document/conflict CAS.
- Pull returns event-linked revision content but does not advance the device
  acknowledgement. A separate acknowledgement advances it durably, and an old
  cursor below the compaction floor requires resnapshot.
- Revocation denies the revoked device while the other registered device stays
  authorized.
- Closing and reopening the SQLite store preserves the exact semantic snapshot,
  operation replay, acknowledgement, active authorization, and revocation.
- SQLite online backup opened as a restored store has the exact semantic
  snapshot and authorization state; source and restored integrity plus foreign
  keys pass.
- A bounded source inspection of `cmd/v2api/main.go` asserts that sync is
  disabled by default, mounted only in the explicit enable branch, rejects sync
  configuration while disabled, requires all enable-time configuration, and
  rejects group/world-readable key files.

## Evidence boundaries

`production-sync-evidence.json` is a stable semantic transcript, not a database
file or request log. Deliberately excluded values include generated device
credentials, their stored digests, operation fingerprints, temporary paths,
request authorities, proxy owner addresses, dates, and machine-specific data.
Revision and conflict IDs are deterministic protocol identifiers derived from
fixed scenario inputs and are safe to compare byte-for-byte.

TASK-017 remains server infrastructure only. Passing this package does not
expose browser mutation controls, cut over the default route, or prove the Git
publication and reconciliation work assigned to later tasks.
