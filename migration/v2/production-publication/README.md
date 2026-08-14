# TASK-018 production publication evidence

This package is the deterministic acceptance runner for fenced publication of
current V2 sync revisions into an isolated Git archive. The runner uses
filesystem-backed temporary SQLite ledgers, a disposable bare Git remote, the
production `internal/v2publish` state machine, and real `internal/v2sync`
revisions. It never points publication at the checked-out repository.

Regenerate or verify the checked-in canonical evidence:

```sh
go run ./cmd/v2publication-evidence
python3 scripts/build_v2_production_publication_evidence.py
python3 scripts/build_v2_production_publication_evidence.py --check
```

The Python builder requires the runner's stdout to be exactly two-space-indented
UTF-8 JSON with one final LF. It rejects dates and timestamps, temporary or
machine paths, hostnames and network addresses, email addresses, long digest-like
values, and fields that could expose tokens, digests, fingerprints, secrets,
credentials, payloads, bodies, or publication source bytes.

## What the runner proves

- Two independently opened publication ledgers contend on the same OS flock.
  Once the next holder advances the durable generation, the prior fence is
  rejected.
- The immutable publication intent, expected current revision, expected prior
  publication, and expected Git base are durable before materialization. An
  injected stop at that boundary leaves no worktree, local commit, or remote
  change.
- Production schema, identity, link/corpus, and Apex validation failures leave
  terminal validation records without commits. A successful non-deletion is
  observed invoking the installed real Apex executable before finalization.
- Independent runs from identical SQLite and Git inputs produce the same commit
  and tree identities. Only equality is recorded; object IDs are excluded.
- Process loss after local commit creation, remote push acceptance, and ledger
  finalization converges on retry to one added remote commit and one finalized
  durable state. A further retry is idempotent. The resulting `published` sync
  event is pulled without changing the device cursor and advances only after an
  explicit ordinary TASK-017 acknowledgement.
- A Git change racing immediately before push wins the expected-base compare and
  swap. The publisher's push is rejected, the external head is not overwritten,
  and recovery records remote drift.
- External edit, deletion, and rename transitions preserve exact candidate bytes
  durably. Editable sidecar claims do not define candidate identity, and repeat
  scans are idempotent.
- An unowned canonical addition is preserved separately, leaves the durable base
  unchanged, and blocks publication from advancing it.
- During the publication backup flock, the drill takes an online sync-ledger
  backup and serves both a V1 lead-sheet handler and the read-only V2 shell and
  manifest handlers. The publication-ledger online backup and verified Git
  bundle restore with the sync backup, then recover a remote-accepted but
  unfinalized publication without another remote commit.
- A bounded inspection of `cmd/v2publisher/main.go` verifies that enablement is
  false by default, operational defaults are empty, disabled configuration is
  rejected, and only one-shot publish/reconcile calls cross the enable gate.

## Evidence boundary

`production-publication-evidence.json` is a stable semantic transcript. It
contains statuses, counts, relative canonical document paths, and boolean
assertions only. It deliberately excludes song and set text, Git object IDs,
SQLite rows, operation internals, editable sidecar values, credentials,
machine-specific data, and all clock values.

Passing this package does not enable the publisher command, add a publication
loop, alter the V1 service, or make the V2 browser shell writable by default.
