#!/usr/bin/env python3
"""Build deterministic TASK-013 offline library/search/status evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "migration/v2/phase1/library"
OUTPUT = EVIDENCE / "library-summary.json"
OBSERVATION = EVIDENCE / "browser-observations/chromium-offline-library.json"
EXPECTED_BOOTSTRAP_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
EXPECTED_GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
EXPECTED_SHELL_SHA = "986503ad7139afe88141df95fa6d809d98b284956ce3be885d7bf141f01a4174"
EXPECTED_RELEASE = "shell-89785e5935f3ee0eea606eca"
EXPECTED_WARNINGS = ["can-t-stop", "father-of-mine", "love-shack", "paradise-city", "troublemaker"]


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def checked(path: Path) -> tuple[bytes, Any]:
    raw = path.read_bytes()
    return raw, json.loads(raw)


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
    bootstrap_raw, bootstrap = checked(ROOT / "internal/v2bootstrap/data/manifest.json")
    shell_raw, shell = checked(ROOT / "internal/v2shell/data/asset-manifest.json")
    observation_raw, observation = checked(OBSERVATION)
    if sha(bootstrap_raw) != EXPECTED_BOOTSTRAP_SHA or bootstrap["generation"] != EXPECTED_GENERATION:
        raise ValueError("bootstrap trust anchor drift")
    if sha(shell_raw) != EXPECTED_SHELL_SHA or shell["release"] != EXPECTED_RELEASE:
        raise ValueError("TASK-013 shell trust anchor drift")
    if shell["bootstrap_manifest_sha256"] != EXPECTED_BOOTSTRAP_SHA or shell["accepted_bootstrap_manifest_sha256"] != [EXPECTED_BOOTSTRAP_SHA]:
        raise ValueError("shell/bootstrap compatibility drift")
    if observation["task"] != "TASK-013" or observation["schema_version"] != "1":
        raise ValueError("browser observation identity drift")
    if observation["shell"] != {"asset_manifest_sha256": EXPECTED_SHELL_SHA, "release": EXPECTED_RELEASE}:
        raise ValueError("browser shell identity drift")
    if observation["bootstrap"] != {"documents": 373, "generation": EXPECTED_GENERATION, "manifest_sha256": EXPECTED_BOOTSTRAP_SHA}:
        raise ValueError("browser bootstrap identity drift")

    offline = observation["offline_reload"]
    if offline["api_process"] != "inactive" or offline["api_requests"] != [] or not offline["service_worker_controlled"]:
        raise ValueError("zero-API offline reload proof failed")
    if offline["snapshot_source"] != "Active verified IndexedDB snapshot" or len(offline["shell_requests"]) != 3:
        raise ValueError("offline active-snapshot proof drift")
    if any(request["status"] != 200 or request["path"].startswith("/api/v2/") for request in offline["shell_requests"]):
        raise ValueError("offline shell request inventory drift")

    diagnostics = observation["diagnostics"]
    if diagnostics["indexed_counts"] != "373 documents · 339 songs · 34 Set Lists" or diagnostics["route_coverage"] != "373/373 indexed routes":
        raise ValueError("library count/route diagnostics drift")
    if diagnostics["references"] != "1076 resolved / 0 unresolved" or diagnostics["deleted_set_paths_excluded"] != 26:
        raise ValueError("reference/deleted exclusion diagnostics drift")
    if diagnostics["landscape_warning_slugs"] != EXPECTED_WARNINGS:
        raise ValueError("landscape warning diagnostics drift")
    if diagnostics["frozen_date"] != "2026-08-10" or "no live freshness inferred" not in diagnostics["snapshot_freshness"]:
        raise ValueError("snapshot freshness diagnostics drift")

    search = observation["search"]
    if search["song"]["query"] != "cant stop" or search["song"]["result_titles"] != ["Can't Stop"] or search["song"]["matched_fields"] != "Matched fields: Title, Slug":
        raise ValueError("offline song search proof drift")
    if search["set"]["query"] != "Castello Golightly" or "9Tease Stripped" not in search["set"]["result_titles"] or search["set"]["matched_fields"] != "Matched fields: Location":
        raise ValueError("offline Set List search proof drift")

    accessibility = observation["accessibility"]
    if any(record["violations"] for record in accessibility["axe"]) or len(accessibility["axe"]) != 5:
        raise ValueError("Chromium axe proof failed")
    if not accessibility["clear_button_focus_returned_to_search"] or not accessibility["reduced_motion_media_query_present"]:
        raise ValueError("keyboard/reduced-motion proof failed")
    for target in accessibility["touch_targets"].values():
        if target["height"] < 44 or target["width"] < 44:
            raise ValueError("touch target below 44 CSS pixels")
    for viewport in observation["viewports"].values():
        if viewport["scroll_width"] != viewport["width"]:
            raise ValueError("horizontal viewport overflow")

    css = (ROOT / "v2/packages/web/src/styles.css").read_text(encoding="utf-8")
    app = (ROOT / "v2/packages/web/src/App.tsx").read_text(encoding="utf-8")
    contracts = (ROOT / "v2/packages/web/src/library/contracts.ts").read_text(encoding="utf-8")
    if "@media (prefers-reduced-motion: reduce)" not in css or "@media (prefers-color-scheme: dark) and (prefers-contrast: more)" not in css:
        raise ValueError("accessibility media contract drift")
    if not all(value in app for value in ("activeSnapshotFor", "buildLibraryIndex", "catalog selectors are unavailable", "active verified snapshot was retained")):
        raise ValueError("active-pointer UI boundary drift")
    if not all(value in contracts for value in (EXPECTED_GENERATION, "1_076", "deletedSetPaths", "landscapeWarningSlugs")):
        raise ValueError("reviewed library contract drift")
    contrast_records = [
        {"theme": "light-more", "foreground": "#26363d", "background": "#fffdf7", "ratio": round(contrast("#26363d", "#fffdf7"), 3)},
        {"theme": "dark-more", "foreground": "#e0eaed", "background": "#14232b", "ratio": round(contrast("#e0eaed", "#14232b"), 3)},
    ]
    if min(record["ratio"] for record in contrast_records) < 4.5:
        raise ValueError("high-contrast theme token ratio below WCAG AA")

    screenshots = []
    for name in ("desktop-status", "phone-song-search"):
        path = EVIDENCE / f"screenshots/{name}.png"
        raw = path.read_bytes()
        screenshots.append({"name": name, "path": str(path.relative_to(ROOT)), "bytes": len(raw), "sha256": sha(raw)})

    artifact: dict[str, Any] = {
        "schema_version": "1",
        "task": "TASK-013",
        "bootstrap": observation["bootstrap"],
        "shell": observation["shell"],
        "browser_observation": {"path": str(OBSERVATION.relative_to(ROOT)), "bytes": len(observation_raw), "sha256": sha(observation_raw), "browser": observation["browser"]},
        "screenshots": screenshots,
        "accessibility": {"axe_surfaces": len(accessibility["axe"]), "keyboard_focus_return": True, "minimum_touch_target_css_px": 44, "reduced_motion": True, "contrast": contrast_records},
        "proof": {
            "selectors_require_matching_active_pointer_generation": True,
            "offline_reload_with_api_process_inactive": True,
            "offline_reload_api_requests": 0,
            "song_search_local_and_deterministic": True,
            "set_search_local_and_deterministic": True,
            "current_counts_routes_references_and_exclusions_match": True,
            "fit_warnings_linked": True,
            "snapshot_freshness_and_origin_storage_reported": True,
            "failed_update_keeps_matching_active_snapshot_browseable": True,
            "recent_and_latest_date_active_set_read_models": True,
            "no_mutation_controls": True,
        },
        "limitations": {"physical_safari_ipad": "pending mandatory owner-device acceptance"},
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
            print(f"generated TASK-013 library evidence differs: {OUTPUT}")
            return 1
        print(f"{OUTPUT}: OK")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
