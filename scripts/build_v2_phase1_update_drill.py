#!/usr/bin/env python3
"""Build and verify the deterministic PHY-039 V2 successor update drill."""
from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "migration/v2/phase1/checkpoint/update-drill"
COMMIT = "47325f743f3092bfa7d9d108679a49a126a0b4cf"
CHECKPOINT_BINARY_SHA = "4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc"
UNIT_EXEC_TOKEN = "__SONGS_V2_RELEASE_EXEC__"
BOOTSTRAP_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
BOOTSTRAP_GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
DESCRIPTION = "Verified read-only lead sheets and Set Lists (PHY-039 successor update drill)."


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def run(args: list[str], cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def archive_export(destination: Path) -> None:
    destination.mkdir(parents=True)
    proc = subprocess.Popen(["git", "-C", str(ROOT), "archive", "--format=tar", COMMIT], stdout=subprocess.PIPE)
    assert proc.stdout is not None
    untar = subprocess.Popen(["tar", "-x", "-C", str(destination)], stdin=proc.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proc.stdout.close()
    out, err = untar.communicate()
    if proc.wait() != 0 or untar.returncode != 0:
        raise RuntimeError(err.decode(errors="replace") or out.decode(errors="replace"))
    link = destination / "v2" / "node_modules"
    link.symlink_to(ROOT / "v2" / "node_modules", target_is_directory=True)


def patch_export(export: Path) -> tuple[str, str]:
    manifest = export / "v2/packages/web/public/manifest.webmanifest"
    value = json.loads(manifest.read_text())
    value["description"] = DESCRIPTION
    manifest.write_bytes(canonical(value))
    web = export / "v2/packages/web"
    run(["node", "--import", "tsx", "scripts/build-shell.ts", "generate"], web)
    shell_manifest = export / "internal/v2shell/data/asset-manifest.json"
    shell = json.loads(shell_manifest.read_text())
    shell_sha = sha(shell_manifest.read_bytes())
    shell_go = export / "internal/v2shell/shell.go"
    text = shell_go.read_text()
    replacements = {
        'expectedAssetManifestSHA256 = "d3dfa5f989efa38ce237034a6f5df4834d9101195794cd124a5427c66c3dc6c7"': f'expectedAssetManifestSHA256 = "{shell_sha}"',
        'expectedRelease             = "shell-39849548e3b7192a1c76aa6e"': f'expectedRelease             = "{shell["release"]}"',
    }
    for old, new in replacements.items():
        if old not in text:
            raise RuntimeError(f"shell trust anchor not found: {old}")
        text = text.replace(old, new)
    shell_go.write_text(text)
    return shell["release"], shell_sha


def build_export(export: Path, name: str) -> tuple[bytes, str]:
    run(["go", "test", "./internal/v2shell/...", "./internal/v2bootstrap/..."], export)
    output = export / name
    run(["go", "build", "-trimpath", "-buildvcs=false", "-o", str(output), "./cmd/v2api"], export)
    raw = output.read_bytes()
    return raw, sha(raw)


def make_package(staging: Path, binary: bytes, release: str, shell_sha: str, binary_sha: str) -> None:
    release_dir = staging / "release"
    release_dir.mkdir(parents=True)
    # FORMAT_XZ with a fixed preset/check is reproducible: no filename, time, or host metadata.
    archive = lzma.compress(binary, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, preset=9)
    archive_path = release_dir / "songs-v2-api-linux-amd64.xz"
    archive_path.write_bytes(archive)
    unit_text = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{COMMIT}:songs-v2-api.service"], text=True)
    old_exec = "ExecStart=/home/exedev/songs-v2/srv/songs-v2-api -listen 127.0.0.1:8001"
    successor_exec = f"ExecStart=/home/exedev/songs-v2/var/releases/p1-009-successor-{binary_sha[:17]}/songs-v2-api -listen 127.0.0.1:8001"
    if old_exec not in unit_text:
        raise RuntimeError("checkpoint service unit ExecStart drift")
    unit = unit_text.replace(old_exec, successor_exec).encode()
    (release_dir / "songs-v2-api.service").write_bytes(unit)
    sums = f"{sha(archive)}  songs-v2-api-linux-amd64.xz\n{sha(unit)}  songs-v2-api.service\n".encode()
    (release_dir / "SHA256SUMS").write_bytes(sums)
    metadata = {
        "schema_version": "1",
        "kind": "songs-v2.phase1.update-drill-successor",
        "physical_target": "PHY-039",
        "status": "SOFTWARE_PASS_PHYSICAL_PENDING",
        "source_commit": COMMIT,
        "bootstrap": {"manifest_sha256": BOOTSTRAP_SHA, "generation": BOOTSTRAP_GENERATION},
        "successor": {"shell_release": release, "asset_manifest_sha256": shell_sha, "cache_name": f"songs-v2-shell-{release.removeprefix('shell-')}"},
        "binary": {"sha256": binary_sha, "archive_sha256": sha(archive), "format": "xz", "platform": "linux-amd64", "reproducible_builds": 2},
        "artifacts": {"archive": "release/songs-v2-api-linux-amd64.xz", "service_unit": "release/songs-v2-api.service", "sha256sums": "release/SHA256SUMS", "readme": "README.md"},
        "verification": {"metadata_sha256": None},
    }
    metadata["verification"]["metadata_sha256"] = sha(canonical(metadata))
    (staging / "successor-metadata.json").write_bytes(canonical(metadata))
    (staging / "README.md").write_text(f'''# PHY-039 V2 successor update drill

This deterministic package is generated offline and does not deploy or restart anything. It is a harmless read-only successor built from checkpoint commit `{COMMIT}`. It changes only the PWA manifest description, accepts bootstrap SHA `{BOOTSTRAP_SHA}` / generation `{BOOTSTRAP_GENERATION}`, and uses shell release `{release}` with a distinct cache.

## Controlled server deployment

The engineer operates on the V2 server; the approved iPad is used only for browser validation. From `/home/exedev/songs-v2`, verify the generated package and use the fail-closed installer:

```sh
python3 scripts/build_v2_phase1_update_drill.py --check
cd migration/v2/phase1/checkpoint/update-drill/release
sha256sum -c SHA256SUMS
xz -t songs-v2-api-linux-amd64.xz
cd /home/exedev/songs-v2
sudo scripts/install_v2_phase1_release.sh \\
  migration/v2/phase1/checkpoint/update-drill/release \\
  successor
```

The installer requires V1 health before and after deployment, captures a complete rollback backup, installs to the content-addressed release directory, verifies the exact unit `ExecStart`, starts V2, and automatically restores the prior V2 release on any failed gate. Record the printed backup directory. Do not alter V1 or deploy during rehearsal/performance.

## PHY-039 device verification

On the approved iPad, follow PHY-039 in the physical checklist: complete/exit locked Live, close every V2 Safari/Home Screen instance, reopen online, verify bootstrap generation `{BOOTSTRAP_GENERATION}`, shell release `{release}`, distinct cache/worker activation, offline restart, and read-only behavior. Record operator, UTC time, device, timings, and results. Never force `skipWaiting` from DevTools.

## Rollback

On any failed checksum, health, bootstrap, shell/cache, or PHY-039 gate, run on the server with the exact backup directory printed by the installer:

```sh
sudo scripts/rollback_v2_phase1_release.sh \\
  /home/exedev/songs-v2/var/releases/backups/<recorded-backup-directory>
```

Then confirm checkpoint binary SHA `{CHECKPOINT_BINARY_SHA}`, checkpoint shell release `shell-39849548e3b7192a1c76aa6e`, bootstrap identity, V1 health, and the public login boundary.
''')


def generate() -> Path:
    staging = Path(tempfile.mkdtemp(prefix="songs-v2-update-drill-"))
    one = staging / "export-1"
    two = staging / "export-2"
    archive_export(one)
    archive_export(two)
    release, shell_sha = patch_export(one)
    release2, shell_sha2 = patch_export(two)
    if (release, shell_sha) != (release2, shell_sha2):
        raise RuntimeError("independent shell exports differ")
    binary1, binary_sha1 = build_export(one, "v2api-1")
    binary2, binary_sha2 = build_export(two, "v2api-2")
    if binary1 != binary2:
        raise RuntimeError(f"independent binaries differ: {binary_sha1} != {binary_sha2}")
    package = staging / "package"
    make_package(package, binary1, release, shell_sha, binary_sha1)
    return package


def compare_package(package: Path) -> bool:
    expected = sorted(p.relative_to(package) for p in package.rglob("*") if p.is_file())
    actual = sorted(p.relative_to(OUT) for p in OUT.rglob("*") if p.is_file()) if OUT.exists() else []
    if expected != actual:
        return False
    return all((package / rel).read_bytes() == (OUT / rel).read_bytes() for rel in expected)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    package = generate()
    try:
        if args.check:
            if not compare_package(package):
                print("PHY-039 update-drill package differs")
                return 1
            print(f"{OUT}: OK")
            return 0
        OUT.mkdir(parents=True, exist_ok=True)
        for child in list(OUT.iterdir()):
            if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
            else: child.unlink()
        for source in package.iterdir():
            target = OUT / source.name
            if source.is_dir(): shutil.copytree(source, target)
            else: shutil.copy2(source, target)
        print(f"wrote {OUT}")
        return 0
    finally:
        shutil.rmtree(package.parent, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
