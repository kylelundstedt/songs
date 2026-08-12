#!/usr/bin/env python3
"""Capture or verify P1-009 software/service/proxy checkpoint observations."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import lzma
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "migration/v2/phase1/checkpoint/software-observation.json"
CHECKPOINT_COMMIT = "47325f743f3092bfa7d9d108679a49a126a0b4cf"
BINARY_SHA = "4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc"
UNIT_SHA = "a1b1659d18660fe1ad297192ac703bbdf38d6b8d339824025a403a4aaa8bc1d3"
RELEASE_EXEC = Path("/home/exedev/songs-v2/var/releases/p1-009-checkpoint-4e2e34972ee92164f/songs-v2-api")
BOOTSTRAP_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
SHELL_RELEASE = "shell-39849548e3b7192a1c76aa6e"
GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
V1_COMMIT = "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5"
V1_BINARY_SHA = "8eebdf81dd5497e8a8a1fee2bd5daab40a7dc1957cfd8964d91e0b813e0c1c1c"
ARCHIVE = ROOT / "migration/v2/phase1/checkpoint/release/songs-v2-api-linux-amd64.xz"


def run(*command: str, cwd: Path | None = None, input_text: str | None = None) -> str:
    return subprocess.run(command, cwd=cwd, input=input_text, check=True, capture_output=True, text=True).stdout.strip()


def raw(*command: str, cwd: Path | None = None) -> bytes:
    return subprocess.run(command, cwd=cwd, check=True, capture_output=True).stdout


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def command_version(*command: str) -> str:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return (result.stdout or result.stderr).splitlines()[0].strip()


def build_twice() -> tuple[str, str]:
    hashes: list[str] = []
    with tempfile.TemporaryDirectory(prefix="songs-v2-checkpoint-export-1-") as left, tempfile.TemporaryDirectory(prefix="songs-v2-checkpoint-export-2-") as right:
        for target in (Path(left), Path(right)):
            archive = subprocess.Popen(["git", "-C", str(ROOT), "archive", CHECKPOINT_COMMIT], stdout=subprocess.PIPE)
            assert archive.stdout is not None
            extract = subprocess.run(["tar", "-x", "-C", str(target)], stdin=archive.stdout, check=True)
            archive.stdout.close()
            if archive.wait() != 0 or extract.returncode != 0:
                raise RuntimeError("checkpoint git archive export failed")
            subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-o", str(target / "songs-v2-api"), "./cmd/v2api"], cwd=target, check=True)
            hashes.append(sha((target / "songs-v2-api").read_bytes()))
    return hashes[0], hashes[1]


def parse_headers(raw_headers: str) -> tuple[int, dict[str, str]]:
    blocks = [block for block in re.split(r"\r?\n\r?\n", raw_headers.strip()) if block.startswith("HTTP/")]
    if not blocks:
        raise ValueError("HTTP response headers missing")
    lines = blocks[-1].splitlines()
    status = int(lines[0].split()[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    return status, headers


def curl_probe(url: str, headers: tuple[str, ...] = (), resolve: str | None = None) -> tuple[int, dict[str, str], bytes]:
    with tempfile.TemporaryDirectory(prefix="songs-v2-checkpoint-curl-") as directory:
        header_path = Path(directory) / "headers"
        body_path = Path(directory) / "body"
        command = ["curl", "-sS", "--max-time", "20", "-D", str(header_path), "-o", str(body_path)]
        if resolve is not None:
            command.extend(["--resolve", resolve])
        for header in headers:
            command.extend(["-H", header])
        command.append(url)
        subprocess.run(command, check=True)
        status, parsed = parse_headers(header_path.read_text(encoding="utf-8"))
        return status, parsed, body_path.read_bytes()


def unit_bytes() -> bytes:
    try:
        return Path("/etc/systemd/system/songs-v2-api.service").read_bytes()
    except PermissionError:
        return raw("sudo", "cat", "/etc/systemd/system/songs-v2-api.service")


def certificate(public_ip: str) -> dict[str, Any]:
    result = subprocess.run(["openssl", "s_client", "-connect", f"{public_ip}:8001", "-servername", "kgl-songs.exe.xyz", "-tls1_3"], input=b"", check=True, capture_output=True)
    pem = result.stdout
    result = subprocess.run(["openssl", "x509", "-noout", "-subject", "-issuer", "-dates"], input=pem, check=True, capture_output=True)
    text = result.stdout.decode("utf-8")
    def value(prefix: str) -> str:
        found = next((line.split("=", 1)[1].strip() for line in text.splitlines() if line.startswith(prefix)), None)
        if found is None:
            raise ValueError(f"certificate field missing: {prefix}")
        return found
    subject = value("subject=")
    issuer = value("issuer=")
    convert = lambda source: dt.datetime.strptime(source, "%b %d %H:%M:%S %Y GMT").replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "negotiated": "TLSv1.3",
        "certificate_common_name": subject.split("CN = ", 1)[-1],
        "certificate_issuer": issuer.split("CN = ", 1)[-1],
        "not_before": convert(value("notBefore=")),
        "not_after": convert(value("notAfter=")),
    }


def capture() -> dict[str, Any]:
    build_1, build_2 = build_twice()
    deployed = RELEASE_EXEC.read_bytes()
    packaged = lzma.decompress(ARCHIVE.read_bytes())
    installed_unit = unit_bytes()
    v1_binary = Path("/home/exedev/songs/srv/songs").read_bytes()
    if {build_1, build_2, sha(deployed), sha(packaged)} != {BINARY_SHA}:
        raise ValueError("reproducible, deployed, or packaged binary hash drift")
    if sha(installed_unit) != UNIT_SHA or sha((ROOT / "songs-v2-api.service").read_bytes()) != UNIT_SHA:
        raise ValueError("installed/tracked service unit drift")
    if run("git", "-C", "/home/exedev/songs", "rev-parse", "HEAD") != V1_COMMIT or sha(v1_binary) != V1_BINARY_SHA:
        raise ValueError("v1 fallback identity drift")

    root_status, root_headers, _ = curl_probe("http://127.0.0.1:8001/", (
        "X-ExeDev-UserID: checkpoint-local", "X-Forwarded-Proto: https", "X-Forwarded-Host: kgl-songs.exe.xyz:8001",
    ))
    manifest_status, manifest_headers, manifest_body = curl_probe("http://127.0.0.1:8001/api/v2/bootstrap/manifest", (
        "X-ExeDev-UserID: checkpoint-local", "X-Forwarded-Proto: https", "X-Forwarded-Host: kgl-songs.exe.xyz:8001",
    ))
    v1_status, _, _ = curl_probe("http://127.0.0.1:8000/")
    public_ip = run("bash", "-lc", "dig @1.1.1.1 +short A kgl-songs.exe.xyz | head -1")
    unauth_status, unauth_headers, _ = curl_probe("https://kgl-songs.exe.xyz:8001/", resolve=f"kgl-songs.exe.xyz:8001:{public_ip}")
    forged_status, forged_headers, _ = curl_probe("https://kgl-songs.exe.xyz:8001/", ("X-ExeDev-UserID: forged-checkpoint",), resolve=f"kgl-songs.exe.xyz:8001:{public_ip}")
    cert = certificate(public_ip)
    cert["hsts"] = "strict-transport-security" in unauth_headers

    enabled_v2 = run("systemctl", "is-enabled", "songs-v2-api.service") == "enabled"
    active_v2 = run("systemctl", "is-active", "songs-v2-api.service") == "active"
    enabled_v1 = run("systemctl", "is-enabled", "songs.service") == "enabled"
    active_v1 = run("systemctl", "is-active", "songs.service") == "active"
    listeners = run("ss", "-ltn")
    if "127.0.0.1:8001" not in listeners or ":8000" not in listeners:
        raise ValueError("service listener boundary drift")
    if not all((enabled_v1, active_v1, enabled_v2, active_v2)):
        raise ValueError("required service is not enabled and active")

    artifact: dict[str, Any] = {
        "schema_version": "1",
        "observed_at_utc": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "checkpoint_commit": CHECKPOINT_COMMIT,
        "checkpoint_worktree": {"base_commit": CHECKPOINT_COMMIT, "package_files_uncommitted_during_observation": True, "completion_commit_or_tag_is_not_an_acceptance_input": True},
        "toolchain": {
            "go": command_version("go", "version").removeprefix("go version "),
            "node": command_version("node", "--version"),
            "npm": command_version("npm", "--version"),
            "python": command_version("python3", "--version").removeprefix("Python "),
            "apex": command_version("apex", "--version").removeprefix("Apex "),
        },
        "reproducible_build": {
            "command": "go build -trimpath -buildvcs=false -o <temporary> ./cmd/v2api",
            "source_export": f"git archive {CHECKPOINT_COMMIT}",
            "independent_source_exports": True,
            "build_1_sha256": build_1,
            "build_2_sha256": build_2,
            "deployed_binary_sha256": sha(deployed),
            "packaged_binary_sha256": sha(packaged),
            "minimum_runtime": "linux-amd64 with GLIBC 2.34 or newer",
            "byte_identical": True,
        },
        "services": {
            "v1": {"service": "songs.service", "enabled": enabled_v1, "active": active_v1, "listener": "*:8000", "working_tree": "/home/exedev/songs", "commit": V1_COMMIT, "binary_sha256": sha(v1_binary), "root_status": v1_status, "role": "default production and immediate fallback"},
            "v2": {"service": "songs-v2-api.service", "enabled": enabled_v2, "active": active_v2, "listener": "127.0.0.1:8001", "working_tree": str(ROOT), "release_exec": str(RELEASE_EXEC), "binary_sha256": sha(deployed), "tracked_unit_sha256": UNIT_SHA, "installed_unit_sha256": sha(installed_unit), "unit_bytes_match": installed_unit == (ROOT / "songs-v2-api.service").read_bytes(), "startup_release": SHELL_RELEASE, "startup_generation": GENERATION},
        },
        "local_authenticated_probe": {
            "root_status": root_status,
            "root_cache_control": root_headers.get("cache-control"),
            "root_content_security_policy_present": "content-security-policy" in root_headers,
            "manifest_status": manifest_status,
            "manifest_content_type": manifest_headers.get("content-type"),
            "manifest_cache_control": manifest_headers.get("cache-control"),
            "manifest_vary": manifest_headers.get("vary"),
            "manifest_etag": manifest_headers.get("etag", "").strip('"'),
            "manifest_body_sha256": sha(manifest_body),
        },
        "public_proxy_probe": {
            "production_origin": "https://kgl-songs.exe.xyz:8001/",
            "public_dns_ipv4": public_ip,
            "tls": cert,
            "unauthenticated": {"status": unauth_status, "location_prefix": unauth_headers.get("location", "").split("?", 1)[0]},
            "forged_identity_header": {"status": forged_status, "same_login_boundary": forged_headers.get("location", "").split("?", 1)[0] == unauth_headers.get("location", "").split("?", 1)[0], "reached_application": forged_status == 200},
            "authorized_owner_reachability": "PENDING",
        },
        "verification": {"output_sha256": None},
    }
    artifact["verification"]["output_sha256"] = sha(canonical(artifact))
    return artifact


def stable(value: dict[str, Any]) -> dict[str, Any]:
    copy = json.loads(json.dumps(value))
    copy.pop("observed_at_utc", None)
    copy["public_proxy_probe"]["public_dns_ipv4"] = "<current-public-ip>"
    for key in ("not_before", "not_after", "certificate_issuer"):
        copy["public_proxy_probe"]["tls"].pop(key, None)
    copy["verification"]["output_sha256"] = None
    return copy


def validate_self(value: dict[str, Any]):
    expected = value["verification"]["output_sha256"]
    copy = json.loads(json.dumps(value))
    copy["verification"]["output_sha256"] = None
    if expected != sha(canonical(copy)):
        raise ValueError("committed software observation self hash drift")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    fresh = capture()
    if args.check:
        recorded = json.loads(OUTPUT.read_text(encoding="utf-8"))
        validate_self(recorded)
        if stable(recorded) != stable(fresh):
            print(f"current checkpoint observation differs from recorded stable contract: {OUTPUT}")
            return 1
        print(f"{OUTPUT}: current service/proxy/build contract OK")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(canonical(fresh))
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
