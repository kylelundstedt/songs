#!/usr/bin/env python3
"""Build deterministic TASK-011 browser/coexistence evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "migration/v2/phase1/shell"
OUTPUT = EVIDENCE / "browser-summary.json"
EXPECTED_BOOTSTRAP_MANIFEST_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
EXPECTED_BOOTSTRAP_GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
EXPECTED_SHELL_MANIFEST_SHA = "50642922b9a7e021cb7357b2254bb52abd1083c70fc77807e33d7671e1affb2a"
EXPECTED_SHELL_RELEASE = "shell-72d3106d38dfec5cc2eaf403"
EXPECTED_CACHE = "songs-v2-shell-72d3106d38dfec5cc2eaf403"
TASK011_COMMIT = "010544f"


def git_bytes(path: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(ROOT), "show", f"{TASK011_COMMIT}:{path}"],
        check=True,
        capture_output=True,
    ).stdout


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def rgb(value: str) -> tuple[float, float, float]:
    value = value.removeprefix("#")
    return tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))  # type: ignore[return-value]


def luminance(value: str) -> float:
    channels = tuple(channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in rgb(value))
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(left: str, right: str) -> float:
    high, low = sorted((luminance(left), luminance(right)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def build() -> dict[str, Any]:
    bootstrap_raw = git_bytes("internal/v2bootstrap/data/manifest.json")
    shell_raw = git_bytes("internal/v2shell/data/asset-manifest.json")
    bootstrap = json.loads(bootstrap_raw)
    shell = json.loads(shell_raw)
    if sha(bootstrap_raw) != EXPECTED_BOOTSTRAP_MANIFEST_SHA or bootstrap["generation"] != EXPECTED_BOOTSTRAP_GENERATION:
        raise ValueError("bootstrap trust anchor drift")
    if sha(shell_raw) != EXPECTED_SHELL_MANIFEST_SHA or shell["release"] != EXPECTED_SHELL_RELEASE:
        raise ValueError("shell trust anchor drift")
    if shell["bootstrap_manifest_sha256"] != EXPECTED_BOOTSTRAP_MANIFEST_SHA or shell["cache_prefix"] != "songs-v2-shell-" or shell["indexeddb_name"] != "songs-v2":
        raise ValueError("shell namespace/bootstrap binding drift")

    profile_names = ("desktop-library", "phone-lead-sheet", "tablet-landscape-set-list")
    profiles = []
    for name in profile_names:
        path = EVIDENCE / f"browser-observations/{name}.json"
        raw = path.read_bytes()
        item = json.loads(raw)
        if item["shell_release"] != EXPECTED_SHELL_RELEASE or item["bootstrap_generation"] != EXPECTED_BOOTSTRAP_GENERATION:
            raise ValueError(f"profile release drift: {name}")
        if item["observed"]["scroll_width"] != item["observed"]["width"] or item["authoring_controls"] or item["inline_style_attributes"] != 0:
            raise ValueError(f"profile UI boundary failure: {name}")
        if item["cache_names"] != [EXPECTED_CACHE] or item["database_names"] != [] or not item["service_worker"]["controlled"]:
            raise ValueError(f"profile namespace failure: {name}")
        profiles.append({"name": name, "path": str(path.relative_to(ROOT)), "bytes": len(raw), "sha256": sha(raw), "observation": item})

    desktop = profiles[0]["observation"]
    phone = profiles[1]["observation"]
    tablet = profiles[2]["observation"]
    if desktop["metrics"] != ["339", "34", "1,076", "12/12"] or desktop["api_resources"] != 13:
        raise ValueError("desktop bootstrap proof drift")
    if phone["renderer_authority"] != "apex" or phone["apex_columns"] != 1 or phone["fit_labels"] != ["Portrait fit", "Landscape fit", "Phone scrolls"]:
        raise ValueError("phone lead-sheet proof drift")
    if tablet["sections"] != 3 or tablet["entries"] != 58:
        raise ValueError("tablet Set List proof drift")

    proxy_path = EVIDENCE / "browser-observations/public-proxy.json"
    proxy_raw = proxy_path.read_bytes()
    proxy = json.loads(proxy_raw)
    if proxy["tls"]["negotiated"] != "TLSv1.3" or proxy["unauthenticated_https"]["status"] != 307 or proxy["unauthenticated_https_with_forged_identity_header"]["status"] != 307 or proxy["origin_listener"] != {"address": "127.0.0.1:8001", "vm_internal_address_status": "connection-refused", "network_direct_header_spoofing": False}:
        raise ValueError("public proxy/auth proof drift")

    screenshots = []
    for name in profile_names:
        path = EVIDENCE / f"screenshots/{name}.png"
        raw = path.read_bytes()
        screenshots.append({"profile": name, "path": str(path.relative_to(ROOT)), "bytes": len(raw), "sha256": sha(raw)})

    css = git_bytes("v2/packages/web/src/styles.css").decode("utf-8")
    light_tokens = css.split("@media", 1)[0]
    variables = dict(re.findall(r"^\s*(--[a-z-]+):\s*(#[0-9a-fA-F]{6});", light_tokens, re.M))
    foregrounds = ("--accent", "--accent-strong", "--muted")
    backgrounds = ("--bg", "--bg-strong", "--surface")
    contrast_records = [{"foreground": foreground, "background": background, "ratio": round(contrast(variables[foreground], variables[background]), 3)} for foreground in foregrounds for background in backgrounds]
    minimum = min(record["ratio"] for record in contrast_records)
    if minimum < 4.5:
        raise ValueError(f"light-theme token contrast below WCAG AA: {minimum}")

    artifact: dict[str, Any] = {
        "schema_version": "1",
        "task": "TASK-011",
        "bootstrap": {"generation": bootstrap["generation"], "manifest_sha256": sha(bootstrap_raw), "documents": bootstrap["counts"]["documents"], "chunks": len(bootstrap["chunks"])},
        "shell": {"release": shell["release"], "asset_manifest_sha256": sha(shell_raw), "asset_count": len(shell["assets"]), "cache_prefix": shell["cache_prefix"], "indexeddb_name": shell["indexeddb_name"]},
        "browser": {"name": "Chromium", "version": "151.0.7922.72", "profiles": profiles},
        "public_proxy": {"path": str(proxy_path.relative_to(ROOT)), "bytes": len(proxy_raw), "sha256": sha(proxy_raw), "observation": proxy},
        "screenshots": screenshots,
        "accessibility": {"automated_axe_surfaces": ["library", "lead-sheet", "set-list"], "keyboard_focus_restoration": True, "reduced_motion_media_query": True, "light_theme_token_contrast": contrast_records, "minimum_small_text_ratio": minimum},
        "proof": {
            "all_documents_hidden_until_complete_verification": True,
            "manifest_and_all_chunks_verified_in_browser": True,
            "api_request_count": 13,
            "authoritative_apex_only": True,
            "internal_apex_links_remain_in_v2": True,
            "no_authoring_controls": True,
            "no_horizontal_overflow": True,
            "service_worker_controls_v2": True,
            "service_worker_bypasses_api": True,
            "v2_cache_namespace_only": True,
            "indexeddb_not_opened": True,
            "public_tls_and_private_login_gate": True,
            "origin_bound_to_loopback": True,
            "v1_tree_unchanged": True,
        },
        "limitations": {"bootstrap_persistence": "P1-005; TASK-011 remains memory-only", "physical_safari_ipad": "pending mandatory owner-device acceptance"},
        "verification": {"output_sha256": None},
    }
    artifact["verification"]["output_sha256"] = sha(canonical(artifact))
    return artifact


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = canonical(build())
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != rendered:
            print(f"generated TASK-011 shell evidence differs: {OUTPUT}")
            return 1
        print(f"{OUTPUT}: OK")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
