# VM rebuild and restore

**Prepared:** August 19, 2026

How to rebuild this exe.dev VM from a new image and resume work, including
TASK-021 physical writable acceptance, without losing reviewed state.

## What is durable

Everything required to resume is in the remote repository
`https://github.int.exe.xyz/kylelundstedt/songs.git`:

| Branch | Contents |
| --- | --- |
| `main` | V1 application, `songs/`, `sets/` |
| `v2` | V2 program, docs, evidence, embedded shell |
| `setlist-research` | Set List reconstruction history, plus `preserved/` sources |

Before rebuilding, confirm each working tree is clean and fully pushed:

```
git -C ~/songs status --short --branch
git -C ~/songs-v2 status --short --branch
git -C ~/set-lists-reference status --short --branch
git -C ~/setlist-research status --short --branch
```

Every repository must report no local modifications and no unpushed commits.

## What is intentionally not preserved

These regenerate and must not block a rebuild:

- `songs/var/songs.sqlite3` — derived search index, rebuilt from Markdown at
  startup or by the reindex endpoint.
- `songs-v2/var/releases/**` — built executables. Rebuild from source; expected
  hashes are recorded in `migration/v2/phase1/checkpoint/`.
- `v2/node_modules`, `v2/packages/*/dist`, `~/go`, `~/node`, `__pycache__`.
- Local agent conversation history.

## What must be retained outside the VM

`setlist-research/raw/Band.zip` (27,957,887 bytes) is the original iCloud
archive, referenced by reports as `n.zip`.

```
sha256  fb389f053cdd55d0520f29193a8673680ace72b5d7b4b9b5db83f1b7dc6ab8be
```

It is deliberately untracked. All derived artifacts needed to review the
reconciliation are committed, so it is required only to re-run extraction from
scratch. Keep the original in iCloud or another durable location.

## Restore procedure

```
git clone https://github.int.exe.xyz/kylelundstedt/songs.git ~/songs
git -C ~/songs worktree add ~/songs-v2 v2
git clone --branch setlist-research \
  https://github.int.exe.xyz/kylelundstedt/songs.git ~/setlist-research
```

Note that `~/songs-v2` is a worktree of `~/songs`, not an independent clone.

Then install toolchains (Go, Node), and verify:

```
cd ~/songs-v2
npm --prefix v2 install
go test ./...
make v2-writable-conflict-recovery-check
```

Reinstall services from the committed unit files:

```
sudo cp ~/songs/songs.service /etc/systemd/system/songs.service
sudo cp ~/songs-v2/songs-v2-api.service /etc/systemd/system/songs-v2-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now songs songs-v2-api
```

`songs-v2-api.service` references a built executable under `var/releases/`.
Rebuild it with `go build ./cmd/v2api` and install it at the recorded path, or
update the unit to the new path, before enabling the service.

## Resuming TASK-021 physical acceptance

No V2 sync database or master key exists yet, so nothing writable is lost in a
rebuild. The acceptance session creates them.

Preserve the V2 origin hostname across the rebuild. iPad bootstrap state lives
in IndexedDB keyed to that origin. If the hostname changes:

- previously verified device state resets;
- PHY-037's port-8001 eviction surrogate must be re-established;
- re-run affected physical rows from a clean baseline and record why.

All writable gates stay disabled by default after a rebuild. Enable them only
for an approved acceptance session, and record Set List and lead-sheet gates
independently, per the two-device checklist.
