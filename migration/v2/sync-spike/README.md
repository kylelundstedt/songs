# TASK-005 sync feasibility spike

This is a **disposable, non-production** Go/SQLite/Git proof of the V2 durable
operation-ledger and Git-materialization design. It exposes no HTTP API, creates
only temporary SQLite databases and isolated local bare Git remotes, and never
reads or modifies the canonical `songs/` or `sets/` worktree paths.

Run the focused proof and regenerate its deterministic evidence:

```sh
go test ./internal/syncspike/...
python3 scripts/build_v2_sync_spike_evidence.py
python3 scripts/build_v2_sync_spike_evidence.py --check
```

## Deliberately proven invariants

- Operations are keyed by `(device_id, operation_id)`. Their canonical payload
  digest includes operation kind and, for a resolution, its conflict target.
  Revisions also derive from the device identity. Strict IDs prevent path
  traversal; unknown and cross-document bases are rejected before candidates
  are written.
- `Pull(after, limit)` is read-only. `AckCursor(device, cursor)` is a separate,
  monotonic durable acknowledgement and rejects future cursors. `PushBatch` is
  explicitly a **non-atomic list** of independently idempotent operations, not
  a batch transaction envelope.
- Conflict resolution performs the document-current CAS and conflict close in
  one SQLite transaction. A document that has advanced leaves the conflict open
  and creates neither resolution revision nor event.
- Publication and reconciliation share an in-process materializer mutex. Only
  current revisions without open document conflicts are eligible. Every
  commit-created intent persists both its expected Git base and expected prior
  published revision. Commit, push, remote-drift, finalization-loss repair, and
  validation transitions each have durable publication-attempt and audit
  records. If the remote accepted a commit but SQLite finalization was lost, a
  retry recognizes the existing remote commit and atomically repairs only the
  predecessor pointer and baseline that the intent is still entitled to move;
  it never rewinds a newer publication.
- The materializer uses only a private worktree/bare remote and fixed author
  data. It disables global/system configuration, templates/hooks, signing,
  autocrlf, and external attributes as practical for this spike; it explicitly
  initializes SHA-1 repositories. Writes preflight every directory component
  and target as non-symlink regular filesystem objects.
- Reconciliation validates sidecar filename/document/path correspondence and
  regular Git tree modes. It compares remote Markdown bytes to the database
  published revision hash, not the sidecar content-hash claim. Imports are
  uniquely ledgered by `(source_commit, document_id)`. If local content is
  unpublished, the external revision becomes the published pointer while local
  remains current and a normal conflict is opened.

`sync-spike-evidence.json` contains schema/version, exact IDs and counts,
acknowledged cursor recovery, both conflict resolutions, publication state
transitions, deterministic local remote commit hashes, seed and later
body-byte proofs, sidecar/reconciliation proofs, full SQLite integrity and
foreign-key checks, and the feasibility conjunction. It intentionally omits
timestamps, temporary paths, hostnames, and secrets.

## Limits

This is not a production sync service: it has no HTTP/auth/ACL layer; its
in-process mutex is **not** a multi-process or distributed publication lease;
it has no full Markdown/Apex validation, no CRDT or automatic Markdown merge,
and does not model external deletion/rename reconciliation. The feasibility
recommendation applies only if the demonstrated ledger,
CAS, acknowledgement, isolated Git, and reconciliation invariants remain
first-class production components.
