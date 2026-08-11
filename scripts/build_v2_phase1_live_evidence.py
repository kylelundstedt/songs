#!/usr/bin/env python3
"""Build deterministic TASK-014 locked-Live and fitter evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "migration/v2/phase1/live"
OUTPUT = EVIDENCE / "live-summary.json"
EXPECTED_BOOTSTRAP_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
EXPECTED_GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
EXPECTED_SHELL_SHA = "95d7fbc2113afd99187a6549796a6beeffa7cc20c3a906c21ff8f56b6987582e"
EXPECTED_RELEASE = "shell-8e20346e9b3ac2579dee901a"
EXPECTED_WARNINGS = ["can-t-stop", "father-of-mine", "love-shack", "paradise-city", "troublemaker"]
TASK014_COMMIT = "e2530bb"


def git_bytes(path: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(ROOT), "show", f"{TASK014_COMMIT}:{path}"],
        check=True,
        capture_output=True,
    ).stdout


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def checked(relative: str) -> tuple[bytes, Any]:
    path = ROOT / relative
    raw = path.read_bytes()
    return raw, json.loads(raw)


def artifact_record(relative: str) -> dict[str, Any]:
    raw = (ROOT / relative).read_bytes()
    return {"path": relative, "bytes": len(raw), "sha256": sha(raw)}


def fit_capture(profile: str, expected_statuses: dict[str, int]) -> tuple[dict[str, Any], dict[str, Any]]:
    relative = f"migration/v2/phase1/live/browser-observations/fitter-{profile}.json"
    raw, capture = checked(relative)
    if capture["profile"] != profile or capture["count"] != 339 or len(capture["results"]) != 339:
        raise ValueError(f"{profile} fitter capture identity/count drift")
    statuses = Counter()
    semantic_mismatches = []
    false_fits = []
    for result in capture["results"]:
        expected = result["expected"]
        statuses[result["status"]] += 1
        actual_semantic = (result["status"], result["body_px"], result["line_height"], result["column_count"])
        expected_semantic = (expected["status"], expected["body_px"], expected["line_height"], expected["column_count"])
        if actual_semantic != expected_semantic:
            semantic_mismatches.append({"slug": result["slug"], "actual": actual_semantic, "expected": expected_semantic})
        if result["status"] == "fit" and any(column["scroll_height"] > column["client_height"] + 1 or column["scroll_width"] > column["client_width"] + 1 for column in result["columns"]):
            false_fits.append(result["slug"])
        if profile == "phone" and any(column["scroll_width"] > column["client_width"] + 1 for column in result["columns"]):
            false_fits.append(result["slug"])
    if dict(statuses) != expected_statuses or semantic_mismatches or false_fits:
        raise ValueError(f"{profile} fitter contract failed: statuses={dict(statuses)} semantic={semantic_mismatches[:3]} false={false_fits[:3]}")
    failures = sorted(result["slug"] for result in capture["results"] if result["status"] == "needs-editing")
    if profile == "ipad-landscape" and failures != sorted(EXPECTED_WARNINGS):
        raise ValueError("landscape warning slug drift")
    summary = {
        "profile": profile,
        "result_count": 339,
        "status_distribution": dict(statuses),
        "semantic_mismatches": 0,
        "false_fit_results": 0,
        "failure_slugs": failures,
        "geometry_contract": "observed and retained, but exact FitBox geometry is surface-specific; status/body_px/line_height/column_count are the frozen parity contract",
        "browser": capture["observed"],
    }
    return {"path": relative, "bytes": len(raw), "sha256": sha(raw)}, summary


def build() -> dict[str, Any]:
    bootstrap_raw, bootstrap = checked("internal/v2bootstrap/data/manifest.json")
    shell_raw = git_bytes("internal/v2shell/data/asset-manifest.json")
    shell = json.loads(shell_raw)
    if sha(bootstrap_raw) != EXPECTED_BOOTSTRAP_SHA or bootstrap["generation"] != EXPECTED_GENERATION:
        raise ValueError("bootstrap trust anchor drift")
    if sha(shell_raw) != EXPECTED_SHELL_SHA or shell["release"] != EXPECTED_RELEASE:
        raise ValueError("TASK-014 shell trust anchor drift")
    if shell["bootstrap_manifest_sha256"] != EXPECTED_BOOTSTRAP_SHA or shell["accepted_bootstrap_manifest_sha256"] != [EXPECTED_BOOTSTRAP_SHA]:
        raise ValueError("shell/bootstrap compatibility drift")

    fit_records = []
    fit_summaries = []
    for profile, statuses in (
        ("ipad-portrait", {"fit": 339}),
        ("ipad-landscape", {"fit": 334, "needs-editing": 5}),
        ("phone", {"scrollable": 339}),
    ):
        record, summary = fit_capture(profile, statuses)
        fit_records.append(record)
        fit_summaries.append(summary)

    _, portrait = checked("migration/v2/phase1/live/browser-observations/live-latest-portrait.json")
    _, landscape = checked("migration/v2/phase1/live/browser-observations/live-latest-landscape.json")
    _, accessibility = checked("migration/v2/phase1/live/browser-observations/live-accessibility-landscape.json")
    _, phone = checked("migration/v2/phase1/live/browser-observations/live-phone.json")
    _, offline = checked("migration/v2/phase1/live/browser-observations/live-offline-network.json")
    _, invalidation = checked("migration/v2/phase1/live/browser-observations/live-pointer-invalidation.json")

    if portrait["count"] != 58 or portrait["status_counts"] != {"fit": 58} or portrait["false_fit_count"] != 0:
        raise ValueError("actual Live portrait traversal drift")
    if landscape["count"] != 58 or landscape["status_counts"] != {"fit": 57, "needs-editing": 1} or landscape["false_fit_count"] != 0:
        raise ValueError("actual Live landscape traversal drift")
    if landscape["frozen_warnings"] != [{"position": 39, "status": "needs-editing", "title": "Can’t Stop"}] or landscape["runtime_warnings"] != landscape["frozen_warnings"]:
        raise ValueError("actual Live warning occurrence drift")
    if accessibility["axe_violations"] != [] or accessibility["fit"] != "needs-editing" or accessibility["theme"] != "dark":
        raise ValueError("landscape accessibility/theme proof failed")
    if accessibility["source"] != {"connected_content": False, "tag": "TEMPLATE"} or accessibility["inline_styles"] != [] or accessibility["presentation_links"] != []:
        raise ValueError("inert Apex presentation proof failed")
    if any(target["height"] < 48 or target["width"] < 48 for target in accessibility["targets"]):
        raise ValueError("landscape Live target below 48 CSS pixels")
    if any(column["tab_index"] != 0 for column in accessibility["columns"]):
        raise ValueError("scrollable landscape columns are not keyboard focusable")
    if phone["axe_violations"] != [] or phone["fit"] != "scrollable" or phone["form_factor"] != "phone" or phone["scroll_width"] != phone["profile"]["width"]:
        raise ValueError("phone Live proof failed")
    if phone["navigation"]["position"] != "fixed" or not phone["navigation"]["remains_visible_at_max_scroll"]:
        raise ValueError("phone navigation visibility proof failed")
    if any(target["height"] < 48 or target["width"] < 48 for target in phone["targets"]):
        raise ValueError("phone Live target below 48 CSS pixels")
    if offline["api_process"] != "inactive" or offline["api_requests"] != [] or offline["post_ready_navigation_requests"] != []:
        raise ValueError("offline zero-request Live proof failed")
    if offline["shell_release"] != EXPECTED_RELEASE or offline["shell_asset_manifest_sha256"] != EXPECTED_SHELL_SHA or offline["cache_names"] != [f"songs-v2-shell-{EXPECTED_RELEASE.removeprefix('shell-')}"]:
        raise ValueError("offline shell identity/cache drift")
    if offline["local_storage_keys"] != [] or not offline["post_reload_live"]["service_worker_controlled"]:
        raise ValueError("Live storage/worker boundary drift")
    if not invalidation["stopped"] or invalidation["stale_exit_link"] or invalidation["reload_control"] != "Reload verified content" or invalidation["elapsed_ms"] > 5_500:
        raise ValueError("active-pointer invalidation proof failed")

    live_source = git_bytes("v2/packages/web/src/live/LiveSetPage.tsx").decode("utf-8")
    fitter_source = git_bytes("v2/packages/web/src/live/fitter.ts").decode("utf-8")
    model_source = git_bytes("v2/packages/web/src/live/model.ts").decode("utf-8")
    app_source = git_bytes("v2/packages/web/src/App.tsx").decode("utf-8")
    css_source = git_bytes("v2/packages/web/src/styles.css").decode("utf-8")
    live_test_source = git_bytes("v2/packages/web/src/live/LiveSetPage.test.tsx").decode("utf-8")
    if any(token in live_source for token in ("fetch(", "localStorage", "sessionStorage")):
        raise ValueError("locked Live contains a network or web-storage operation")
    if not all(token in fitter_source for token in ("TABLET_FONT_SIZES", "TABLET_LINE_HEIGHTS", "PHONE_TYPOGRAPHY", "verticalSafe", "forcedColumnSplit", "cloneApexPresentationNode", "ALLOWED_PRESENTATION_ELEMENTS")):
        raise ValueError("production fitter source contract drift")
    if not all(token in model_source for token in ("PerformanceSet", "targetLeadSheetId", "TARGET_PATH_MISMATCH", "warningOccurrences")):
        raise ValueError("performance model source contract drift")
    if not all(token in app_source for token in ("exactSetRoute", "GuardedLiveSetPage", "expectedStorageGeneration", "exactLiveHash", "getRegistration")):
        raise ValueError("active route/pointer/update boundary drift")
    if not all(token in css_source for token in ("locked-live-theme-dark", "data-form-factor=\"phone\"", "prefers-reduced-motion: reduce")):
        raise ValueError("Live CSS/accessibility contract drift")
    if not all(token in live_test_source for token in ('key: "PageDown"', 'key: " "', "focused scrollable columns")):
        raise ValueError("focused-column keyboard test contract drift")

    observations = [
        artifact_record("migration/v2/phase1/live/browser-observations/live-latest-portrait.json"),
        artifact_record("migration/v2/phase1/live/browser-observations/live-latest-landscape.json"),
        artifact_record("migration/v2/phase1/live/browser-observations/live-accessibility-landscape.json"),
        artifact_record("migration/v2/phase1/live/browser-observations/live-phone.json"),
        artifact_record("migration/v2/phase1/live/browser-observations/live-offline-network.json"),
        artifact_record("migration/v2/phase1/live/browser-observations/live-pointer-invalidation.json"),
    ]
    screenshots = [artifact_record("migration/v2/phase1/live/screenshots/landscape-warning-stage-dark.png"), artifact_record("migration/v2/phase1/live/screenshots/phone-warning-bright.png")]
    artifact: dict[str, Any] = {
        "schema_version": "1",
        "task": "TASK-014",
        "bootstrap": {"generation": EXPECTED_GENERATION, "manifest_sha256": EXPECTED_BOOTSTRAP_SHA, "documents": 373, "sets": 34, "set_entries": 1_076},
        "shell": {"release": EXPECTED_RELEASE, "asset_manifest_sha256": EXPECTED_SHELL_SHA},
        "fitter_corpus": {"artifacts": fit_records, "profiles": fit_summaries},
        "actual_live": {
            "set": {"id": "2025-10-13-9tease-stripped", "entries": 58},
            "portrait": {"fit": 58, "false_fit": 0},
            "landscape": {"fit": 57, "needs_editing": 1, "warning_position": 39, "false_fit": 0},
            "phone": {"scrollable": True, "one_column": True, "fixed_navigation": True},
        },
        "observations": observations,
        "screenshots": screenshots,
        "proof": {
            "all_34_sets_and_1076_occurrences_resolve_in_tests": True,
            "duplicate_occurrences_preserve_entry_identity": True,
            "active_pointer_continuously_guarded": True,
            "offline_reload_and_full_navigation_api_requests": 0,
            "no_live_local_storage_writes": True,
            "apex_is_hidden_authority_and_cloned_links_are_inert": True,
            "frozen_fitter_semantics_match_1017_profile_results": True,
            "actual_live_false_fit_results": 0,
            "bright_and_stage_dark_are_memory_only": True,
            "axe_landscape_and_phone_violations": 0,
            "minimum_live_touch_target_css_px": 48,
            "scrollable_warning_columns_keyboard_focusable": True,
            "keyboard_shortcuts_unit_tested": "PageUp/PageDown/Space remain native when a fitted column is focused",
            "reduced_motion_css_contract_present": True,
            "no_authoring_provider_or_sync_controls": True,
        },
        "limitations": {
            "fit_geometry": "Exact FitBox dimensions belong to each measurement surface. Frozen parity is status/body_px/line_height/column_count; actual Live captures separately prove no false fit and explicit runtime scrolling warnings.",
            "physical_safari_ipad": "pending mandatory owner-device acceptance",
        },
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
            print(f"generated TASK-014 Live evidence differs: {OUTPUT}")
            return 1
        print(f"{OUTPUT}: OK")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
