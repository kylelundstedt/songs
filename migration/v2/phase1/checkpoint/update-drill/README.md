# PHY-039 V2 successor update drill

This deterministic package is generated offline and does not deploy or restart anything. It is a harmless read-only successor built from checkpoint commit `47325f743f3092bfa7d9d108679a49a126a0b4cf`. It changes only the PWA manifest description, accepts bootstrap SHA `a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f` / generation `phase1-f9634173e25ef4ca4b8330a3`, and uses shell release `shell-093b56870d7220008b559673` with a distinct cache.

## Controlled server deployment

The engineer operates on the V2 server; the approved iPad is used only for browser validation. From `/home/exedev/songs-v2`, verify the generated package and use the fail-closed installer:

```sh
python3 scripts/build_v2_phase1_update_drill.py --check
cd migration/v2/phase1/checkpoint/update-drill/release
sha256sum -c SHA256SUMS
xz -t songs-v2-api-linux-amd64.xz
cd /home/exedev/songs-v2
sudo scripts/install_v2_phase1_release.sh \
  migration/v2/phase1/checkpoint/update-drill/release \
  successor
```

The installer requires V1 health before and after deployment, captures a complete rollback backup, installs to the content-addressed release directory, verifies the exact unit `ExecStart`, starts V2, and automatically restores the prior V2 release on any failed gate. Record the printed backup directory. Do not alter V1 or deploy during rehearsal/performance.

## PHY-039 device verification

On the approved iPad, follow PHY-039 in the physical checklist: complete/exit locked Live, close every V2 Safari/Home Screen instance, reopen online, verify bootstrap generation `phase1-f9634173e25ef4ca4b8330a3`, shell release `shell-093b56870d7220008b559673`, distinct cache/worker activation, offline restart, and read-only behavior. Record operator, UTC time, device, timings, and results. Never force `skipWaiting` from DevTools.

## Rollback

On any failed checksum, health, bootstrap, shell/cache, or PHY-039 gate, run on the server with the exact backup directory printed by the installer:

```sh
sudo scripts/rollback_v2_phase1_release.sh \
  /home/exedev/songs-v2/var/releases/backups/<recorded-backup-directory>
```

Then confirm checkpoint binary SHA `4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc`, checkpoint shell release `shell-39849548e3b7192a1c76aa6e`, bootstrap identity, V1 health, and the public login boundary.
