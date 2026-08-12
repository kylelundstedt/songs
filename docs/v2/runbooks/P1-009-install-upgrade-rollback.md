# P1-009 Install, Upgrade, Recovery, and Rollback Runbook

This runbook operates the **isolated read-only V2 pilot**. It does not promote
V2 to the default application and does not authorize writable behavior.

## Fixed endpoints

- **V1 default and immediate fallback:** `https://kgl-songs.exe.xyz/`
- **V2 opt-in pilot and Home Screen install:** `https://kgl-songs.exe.xyz:8001/#/`
- **V2 loopback listener:** `127.0.0.1:8001`
- **V1 service/listener:** `songs.service`, port 8000
- **V2 service/listener:** `songs-v2-api.service`, loopback port 8001

Do not move V2 under `/v2/`, change default routes, or modify the v1 worker as
part of this package.

## Release identity

The packaged software checkpoint is bound by
`migration/v2/phase1/checkpoint/checkpoint-summary.json`. Before operating it,
confirm the shell release, bootstrap generation, manifest hashes, service-unit
hash, and binary hash match that file.

## Verify and build

From `/home/exedev/songs-v2`:

```sh
git status --short --branch
git show -s --format='%H %D %s' HEAD
npm --prefix v2 ci
make v2-check
make v2-browser-check
python3 -m unittest discover -s tests
go test ./...
go test -race ./internal/v2bootstrap/... ./internal/v2shell/...
go vet ./...

# Build twice into temporary paths from two independent exports. Do not run
# `make v2-api-build` here: its output path is the live service binary.
EXPORT1="$(mktemp -d)"
EXPORT2="$(mktemp -d)"
git archive 47325f743f3092bfa7d9d108679a49a126a0b4cf | tar -x -C "${EXPORT1}"
git archive 47325f743f3092bfa7d9d108679a49a126a0b4cf | tar -x -C "${EXPORT2}"
(cd "${EXPORT1}" && go build -trimpath -buildvcs=false -o /tmp/songs-v2-checkpoint-1 ./cmd/v2api)
(cd "${EXPORT2}" && go build -trimpath -buildvcs=false -o /tmp/songs-v2-checkpoint-2 ./cmd/v2api)
cmp /tmp/songs-v2-checkpoint-1 /tmp/songs-v2-checkpoint-2
sha256sum /tmp/songs-v2-checkpoint-1 /tmp/songs-v2-checkpoint-2
rm -rf "${EXPORT1}" "${EXPORT2}" /tmp/songs-v2-checkpoint-1 /tmp/songs-v2-checkpoint-2
```

Do not run a build that writes `srv/songs-v2-api`; that legacy mutable path is
not a checkpoint deployment target. A checkpoint build must be repeated from
two independent exports and produce identical hashes. Do not install when the
worktree or deterministic fixtures differ.

## Install or upgrade V2

The checkpoint release archive targets Linux AMD64 with **GLIBC 2.34 or newer**.
Deployment uses a content-addressed release directory rather than the mutable
worktree binary. The reviewed checkpoint identity is:

```text
release id: p1-009-checkpoint-4e2e34972ee92164f
binary SHA-256: 4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc
bootstrap SHA-256: a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f
installed executable: /home/exedev/songs-v2/var/releases/p1-009-checkpoint-4e2e34972ee92164f/songs-v2-api
```

From `/home/exedev/songs-v2`, verify the package and invoke the fail-closed
installer:

```sh
cd migration/v2/phase1/checkpoint/release
sha256sum -c SHA256SUMS
xz -t songs-v2-api-linux-amd64.xz
cd /home/exedev/songs-v2

sudo scripts/install_v2_phase1_release.sh \
  migration/v2/phase1/checkpoint/release \
  checkpoint
```

The installer:

1. exits unless V1 is active and responds on port 8000;
2. verifies the archive, unit, decompression, binary hash, and exact unit
   `ExecStart` before changing V2;
3. records a complete, checksummed backup of the prior V2 unit, executable,
   enablement state, and active state;
4. installs the executable into the reviewed content-addressed directory;
5. atomically replaces the unit, restarts V2, and verifies service state,
   executable path/hash, authenticated root, and bootstrap SHA;
6. verifies V1 again; and
7. automatically invokes the exact-backup rollback helper on any failed gate.

Record the backup directory printed by the installer. Never use a partial backup,
continue after a failed command, or write the live executable with a build
command. V1 must remain running throughout.

Post-install inspection:

```sh
systemctl status --no-pager --full songs-v2-api.service
systemctl show -p ExecStart songs-v2-api.service
journalctl -u songs-v2-api.service -n 100 --no-pager
ss -ltnp | grep ':8001'

printf '%s  %s\n' \
  '4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc' \
  '/home/exedev/songs-v2/var/releases/p1-009-checkpoint-4e2e34972ee92164f/songs-v2-api' \
  | sha256sum -c -
printf '%s  %s\n' \
  'a1b1659d18660fe1ad297192ac703bbdf38d6b8d339824025a403a4aaa8bc1d3' \
  '/etc/systemd/system/songs-v2-api.service' | sudo sha256sum -c -

curl -fsSI \
  -H 'X-ExeDev-UserID: checkpoint-local' \
  -H 'X-Forwarded-Proto: https' \
  -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8001' \
  http://127.0.0.1:8001/

curl -fsS \
  -H 'X-ExeDev-UserID: checkpoint-local' \
  -H 'X-Forwarded-Proto: https' \
  -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8001' \
  http://127.0.0.1:8001/api/v2/bootstrap/manifest | sha256sum

systemctl is-active songs.service songs-v2-api.service
```

The V2 service must bind loopback only. Verify V1 before and after every V2
install.

## Public proxy/auth probe

The VM resolves its own hostname internally. Probe public DNS explicitly:

```sh
PUBLIC_IP="$(dig @1.1.1.1 +short A kgl-songs.exe.xyz | head -1)"
curl --resolve "kgl-songs.exe.xyz:8001:${PUBLIC_IP}" \
  -o /dev/null -D - https://kgl-songs.exe.xyz:8001/
```

An unauthenticated request must redirect to the exe.dev login boundary. A forged
`X-ExeDev-UserID` header must receive the same redirect. An authorized owner
must separately confirm the V2 root opens after login before physical testing.

## Browser installation

1. Open the V2 pilot URL in Safari while online and authenticated.
2. Wait for verification to finish, then open **Status**.
3. Confirm the expected generation, 373 documents, 12/12 chunks, active storage
   instance, compatible controlling worker, and offline restart availability.
4. Use Safari Share → **Add to Home Screen**.
5. Launch from the new icon once while online before beginning offline tests.
6. Keep V1 bookmarked or open on an independent fallback device.

## Worker upgrades

Replacement V2 workers have no immediate `skipWaiting` path.

- Never force worker activation from DevTools.
- Finish and exit locked Live.
- Close every V2 Safari tab and every V2 Home Screen instance.
- Reopen V2 online to allow the waiting replacement to activate normally.
- Recheck Status and then repeat an offline launch.

Schedule upgrades outside rehearsal and performance windows.

## Safe recovery order

1. Record diagnostics before changing anything.
2. Reload V2 online.
3. If Status says an update failed but the active snapshot was retained, continue
   using that snapshot or switch to V1.
4. If a pointer or Live guard stops the UI, choose **Reload verified content**.
5. For urgent use, switch immediately to V1.
6. Only after recording diagnostics, use Safari Settings → Apps → Safari →
   Advanced → Website Data and remove the exact `kgl-songs.exe.xyz` V2
   port-8001 site entry. If Safari does not expose a port-specific entry or the
   pending-store state cannot be confirmed, **do not clear website data**;
   switch to V1 and escalate for engineering-assisted inspection.
7. Bootstrap V2 again online and repeat Status/offline checks.

Do not clear v1 data for a V2 problem.

## Diagnostics to record

- UTC time and exact hash route;
- iPad model, iPadOS/Safari version, Safari tab versus Home Screen;
- online/offline/authentication state and whether V1 works;
- screenshot, error code, and exact message;
- generation and manifest SHA;
- active/retained physical generations and pointer-transition count;
- worker state and offline-restart status;
- persistence, origin usage, quota, and headroom;
- `systemctl status` and the last 100 V2 service log lines.

## Storage and export status

The current V2 slice is read-only. **No user-facing V2 export/import** exists,
and there is no authored V2 data that requires export. Pending `drafts`, `outbox`, and
`conflicts` stores exist for additive schema safety but are not exposed by the
product and must remain empty.

Persistence is advisory and was denied in Chromium evidence. No persistence,
eviction-resistance, or Safari durability claim is permitted. User-facing
export/recovery is mandatory before any writable pilot.

## Rollback layers

### Immediate user fallback

Open V1 at the default URL. This requires no server change.

### Disable the V2 pilot

```sh
sudo systemctl stop songs-v2-api.service
sudo systemctl disable songs-v2-api.service
```

Do not stop or modify `songs.service`.

### Restore an exact prior V2 release

Use only the exact backup directory printed by the installer. The rollback
helper verifies the backup manifest, confirms V1 health, restores the prior
executable to its recorded absolute path, atomically restores the prior unit,
and restores the prior enabled/active state:

```sh
sudo scripts/rollback_v2_phase1_release.sh \
  /home/exedev/songs-v2/var/releases/backups/<recorded-backup-directory>
```

After rollback, reconfirm the startup release/generation, installed executable
hash, authenticated manifest ETag, public login boundary, and V1 health. Do not
construct a rollback directory manually or restore only one of the unit/binary
pair.

### Remove client state

Stopping the server does not remove a Home Screen icon, worker, cache, or
IndexedDB. Client-state deletion is **engineering-assisted only** for this
checkpoint because Safari may not expose a safely distinguishable port-8001
site-data entry and the read-only UI does not expose pending-store counts. When
controlled cleanup is approved:

1. close all V2 clients;
2. remove the V2 Home Screen icon;
3. have engineering confirm `drafts`, `outbox`, and `conflicts` are empty;
4. remove only the exact V2-origin website-data entry if Safari exposes it
   distinctly; otherwise do not delete data;
5. reinstall and bootstrap the approved release online.

If safe origin-specific cleanup cannot be proven, use V1 and leave V2 data
untouched. Destructive client cleanup is acceptable only for this read-only
release and is not a future writable-client recovery plan.
