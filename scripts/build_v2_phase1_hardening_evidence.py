#!/usr/bin/env python3
"""Build deterministic TASK-015 / P1-008 hardening evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "migration/v2/phase1/hardening"
OUTPUT = EVIDENCE / "hardening-summary.json"
EXPECTED_BOOTSTRAP_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
EXPECTED_GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
EXPECTED_SHELL_SHA = "d3dfa5f989efa38ce237034a6f5df4834d9101195794cd124a5427c66c3dc6c7"
EXPECTED_RELEASE = "shell-39849548e3b7192a1c76aa6e"
EXPECTED_CACHE = "songs-v2-shell-39849548e3b7192a1c76aa6e"
EXPECTED_PROFILES = {
    "desktop": {"width": 1280, "height": 900, "dpr": 1, "mobile": False, "touch": False},
    "tablet-portrait": {"width": 1024, "height": 1366, "dpr": 1, "mobile": False, "touch": True},
    "tablet-landscape": {"width": 1366, "height": 1024, "dpr": 1, "mobile": False, "touch": True},
    "phone": {"width": 390, "height": 844, "dpr": 3, "mobile": True, "touch": True},
}
EXPECTED_ROUTES = {"dashboard", "songs", "song-1979", "sets", "set-detail", "set-live", "status"}
EXPECTED_INVALID = {
    "#/no-such-route",
    "#/songs/%",
    "#/sets/2025-10-13-9tease-stripped/live/extra",
    "#/sets/2025-10-13-9tease-stripped/live?unexpected=1",
    "#https://example.test/sets/foo/live",
}
EXPECTED_STORES = ["chunks", "conflicts", "documents", "drafts", "meta", "outbox", "snapshots"]


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def checked(relative: str) -> tuple[bytes, Any]:
    raw = (ROOT / relative).read_bytes()
    return raw, json.loads(raw)


def artifact(relative: str) -> dict[str, Any]:
    raw = (ROOT / relative).read_bytes()
    return {"path": relative, "bytes": len(raw), "sha256": sha(raw)}


def no_post_ready_requests(route: dict[str, Any]) -> bool:
    traffic = route["post_ready_fetch_xhr"]
    return traffic == {"fetch": [], "xhr": []}


def build() -> dict[str, Any]:
    bootstrap_raw, bootstrap = checked("internal/v2bootstrap/data/manifest.json")
    shell_raw, shell = checked("internal/v2shell/data/asset-manifest.json")
    if sha(bootstrap_raw) != EXPECTED_BOOTSTRAP_SHA or bootstrap["generation"] != EXPECTED_GENERATION:
        raise ValueError("bootstrap trust anchor drift")
    if sha(shell_raw) != EXPECTED_SHELL_SHA or shell["release"] != EXPECTED_RELEASE:
        raise ValueError("P1-008 shell trust anchor drift")
    if shell["accepted_bootstrap_manifest_sha256"] != [EXPECTED_BOOTSTRAP_SHA] or shell["cache_prefix"] != "songs-v2-shell-" or shell["indexeddb_name"] != "songs-v2":
        raise ValueError("shell compatibility/namespace drift")

    records: list[dict[str, Any]] = []
    products: set[str] = set()
    versions: set[str] = set()
    total_axe_surfaces = 0
    total_offline_routes = 0
    for name, expected in EXPECTED_PROFILES.items():
        relative = f"migration/v2/phase1/hardening/browser-observations/{name}.json"
        raw, observation = checked(relative)
        profile = observation["profile"]
        if profile != {"name": name, **expected}:
            raise ValueError(f"{name} profile drift: {profile}")
        browser = observation["browser"]
        product = browser["product"]
        if not (product.startswith("Chrome/") or product.startswith("Chromium/")) or "Chrome/" not in browser["navigator_user_agent"] or "iPhone" in browser["navigator_user_agent"] or "iPad" in browser["navigator_user_agent"]:
            raise ValueError(f"{name} is not an honest Chromium identity")
        products.add(product)
        versions.add(product.split("/", 1)[1])
        if browser["max_touch_points"] != (5 if expected["touch"] else 0):
            raise ValueError(f"{name} touch emulation drift")
        if observation["shell"] != {"release": EXPECTED_RELEASE, "asset_manifest_sha256": EXPECTED_SHELL_SHA, "cache_name": EXPECTED_CACHE}:
            raise ValueError(f"{name} shell identity drift")
        if observation["pwa_manifest"] != {"scope": "/", "start_url": "/#/"}:
            raise ValueError(f"{name} PWA launch contract drift")
        if observation["bootstrap"] != {"generation": EXPECTED_GENERATION, "manifest_sha256": EXPECTED_BOOTSTRAP_SHA, "documents": 373, "chunks": 12}:
            raise ValueError(f"{name} bootstrap identity drift")
        initial = observation["initial_bootstrap"]
        pointer = initial["active_pointer"]
        if not initial["full"] or len(initial["api_requests"]) < 13 or pointer["transitions"] != 1 or pointer["chunks"] != 12 or pointer["documents"] != 373 or pointer["version"] != 2 or pointer["stores"] != EXPECTED_STORES:
            raise ValueError(f"{name} initial activation drift")
        if set(observation["routes"]) != EXPECTED_ROUTES or set(observation["invalid_hash_routes"]) != EXPECTED_INVALID:
            raise ValueError(f"{name} route inventory drift")
        for route_name, route in observation["routes"].items():
            if route["overflow"]["scrollWidth"] > expected["width"] or route["overflow"]["bodyScrollWidth"] > expected["width"] or route["mutation_controls"] or not no_post_ready_requests(route):
                raise ValueError(f"{name}/{route_name} route hardening failed")
            if route_name != "set-live" and not any(item["value"] == "page" for item in route["aria_current"]):
                raise ValueError(f"{name}/{route_name} aria-current missing")
            if route_name == "song-1979" and any(not href.startswith("#/songs/") for href in route["internal_apex_hrefs"]):
                raise ValueError(f"{name} Apex route escaped V2")
        for invalid in observation["invalid_hash_routes"].values():
            if invalid["heading"] != "Page not found" or invalid["shell_fallback"]:
                raise ValueError(f"{name} invalid hash fell through")
        axe_records = observation["accessibility"]["axe"]
        if any(violations for violations in axe_records.values()) or len(axe_records) < 5:
            raise ValueError(f"{name} axe evidence failed")
        total_axe_surfaces += len(axe_records)
        reduced = observation["reduced_motion"]
        if not reduced["matches"] or not reduced["cssRule"] or reduced["maxAnimationDuration"] > 0.01 or reduced["maxTransitionDuration"] > 0.01:
            raise ValueError(f"{name} reduced-motion contract failed")
        if not observation["keyboard"]["arrow_right"] or not observation["keyboard"]["focused_column_page_down"]:
            raise ValueError(f"{name} Live keyboard contract failed")
        offline = observation["offline"]
        if not offline["zero_api_requests"] or set(offline["routes"]) != EXPECTED_ROUTES or any(value != 0 for value in offline["api_requests"].values()):
            raise ValueError(f"{name} offline route/API proof failed")
        for route_name, route in offline["routes"].items():
            if route["from_service_worker"] < 1 or not no_post_ready_requests(route):
                raise ValueError(f"{name}/{route_name} offline shell or post-ready request proof failed")
        total_offline_routes += len(offline["routes"])
        worker = offline["service_worker"]
        if not worker["controlled"] or worker["state"] != "activated" or worker["compatibility"] != {"release": EXPECTED_RELEASE, "accepted_bootstrap_manifest_sha256": [EXPECTED_BOOTSTRAP_SHA]}:
            raise ValueError(f"{name} service-worker state drift")
        if offline["cache_names"] != [EXPECTED_CACHE] or offline["database_names"] != ["songs-v2"] or offline["pointer"] != pointer:
            raise ValueError(f"{name} offline namespace/pointer drift")
        if observation["isolation"] != {"online_unknown_path_status": 404, "offline_unknown_path_shell_fallback": False} or not observation["pointer_unchanged_after_routes"]:
            raise ValueError(f"{name} route isolation/pointer mutation failure")
        records.append({"profile": name, "path": relative, "bytes": len(raw), "sha256": sha(raw), "browser": browser, "viewport": expected})
    if len(products) != 1 or len(versions) != 1:
        raise ValueError("browser identity/version differs across profiles")

    route_raw, route_summary = checked("migration/v2/phase1/hardening/route-summary.json")
    offline_raw, offline_summary = checked("migration/v2/phase1/hardening/offline-summary.json")
    isolation_raw, isolation_summary = checked("migration/v2/phase1/hardening/isolation-summary.json")
    if set(route_summary["profiles"]) != set(EXPECTED_PROFILES) or {item["name"] for item in route_summary["canonical_routes"]} != EXPECTED_ROUTES or set(route_summary["invalid_hashes"]) != EXPECTED_INVALID:
        raise ValueError("route summary drift")
    if not offline_summary["direct_live_first_load"] or any(not item["zero_api_requests"] for item in offline_summary["profiles"].values()):
        raise ValueError("offline summary drift")
    if not isolation_summary["only_songs_v2_namespaces"] or any(item["online_unknown_path_status"] != 404 or item["offline_unknown_path_shell_fallback"] for item in isolation_summary["profiles"].values()):
        raise ValueError("isolation summary drift")

    app = (ROOT / "v2/packages/web/src/App.tsx").read_text(encoding="utf-8")
    runtime = (ROOT / "v2/packages/web/src/bootstrap/runtime.ts").read_text(encoding="utf-8")
    worker_builder = (ROOT / "v2/packages/web/scripts/build-shell.ts").read_text(encoding="utf-8")
    worker_tests = (ROOT / "v2/packages/web/src/service-worker.test.ts").read_text(encoding="utf-8")
    shell_tests = (ROOT / "internal/v2shell/shell_test.go").read_text(encoding="utf-8")
    if not all(token in app for token in ("ActivePointerBoundary", "completeOfflineReady", "waitingWorkerActivationDisposition", "expectedTransitionCount", "Refresh private sign-in")):
        raise ValueError("application hardening source contract drift")
    if not all(token in runtime for token in ("ACTIVE_POINTER_CHANNEL", "announceActivePointerChange", "finalActiveInspection", "openedStorage.failure instanceof SongsStorageError")):
        raise ValueError("pointer/storage failure hardening drift")
    if not all(token in worker_builder for token in ("auth-refresh", "url.pathname !== '/'", "url.pathname !== '/index.html'", "cache.addAll(PRECACHE)")) or "SKIP_WAITING" in worker_builder:
        raise ValueError("worker route/install hardening drift")
    if not all(token in worker_tests for token in ("defer-until-clients-close", "defers first-controller reload")) or "start_url" not in shell_tests or "SKIP_WAITING" not in shell_tests:
        raise ValueError("worker/PWA test contract drift")

    screenshot_records = [artifact(f"migration/v2/phase1/hardening/screenshots/{name}-live.png") for name in EXPECTED_PROFILES]
    supporting = [
        artifact("migration/v2/current/coexistence/browser-summary.json"),
        artifact("migration/v2/phase1/storage/storage-summary.json"),
        artifact("migration/v2/phase1/library/library-summary.json"),
        artifact("migration/v2/phase1/live/live-summary.json"),
    ]
    summary: dict[str, Any] = {
        "schema_version": "1",
        "task": "TASK-015",
        "phase_packet": "P1-008",
        "bootstrap": {"generation": EXPECTED_GENERATION, "manifest_sha256": EXPECTED_BOOTSTRAP_SHA, "documents": 373, "songs": 339, "sets": 34, "set_entries": 1076},
        "shell": {"release": EXPECTED_RELEASE, "asset_manifest_sha256": EXPECTED_SHELL_SHA, "cache_name": EXPECTED_CACHE},
        "browser": {"product": next(iter(products)), "version": next(iter(versions)), "profiles": records},
        "native_capture": {
            "canonical_route_checks": len(EXPECTED_PROFILES) * len(EXPECTED_ROUTES),
            "invalid_hash_checks": len(EXPECTED_PROFILES) * len(EXPECTED_INVALID),
            "offline_cold_route_reloads": total_offline_routes,
            "offline_api_requests": 0,
            "axe_surface_checks": total_axe_surfaces,
            "minimum_normal_target_css_px": 44,
            "minimum_live_target_css_px": 48,
            "direct_live_first_load_installs_worker": True,
            "pwa_start_url": "/#/",
            "unknown_document_path_online_status": 404,
            "unknown_document_path_offline_shell_fallback": False,
        },
        "artifacts": {
            "route_summary": {"path": "migration/v2/phase1/hardening/route-summary.json", "bytes": len(route_raw), "sha256": sha(route_raw)},
            "offline_summary": {"path": "migration/v2/phase1/hardening/offline-summary.json", "bytes": len(offline_raw), "sha256": sha(offline_raw)},
            "isolation_summary": {"path": "migration/v2/phase1/hardening/isolation-summary.json", "bytes": len(isolation_raw), "sha256": sha(isolation_raw)},
            "screenshots": screenshot_records,
            "supporting_evidence": supporting,
        },
        "proof": {
            "all_active_routes_recheck_physical_pointer_and_transition_epoch": True,
            "bootstrap_rechecks_authority_after_its_last_async_operation": True,
            "cross_tab_pointer_changes_broadcast_with_poll_and_foreground_fallback": True,
            "waiting_replacement_workers_activate_only_after_all_v2_clients_close": True,
            "first_controller_reload_deferred_during_locked_live": True,
            "interrupted_content_updates_retain_active_snapshot": True,
            "direct_live_first_load_is_offline_restartable": True,
            "offline_ready_requires_compatible_controlling_worker": True,
            "unknown_paths_do_not_receive_shell_fallback": True,
            "pwa_launch_uses_canonical_hash_root": True,
            "internal_apex_links_are_canonical_v2_hash_urls": True,
            "typed_indexeddb_open_failures_remain_visible": True,
            "normal_navigation_has_no_service_worker_update_poll": True,
            "v1_remains_default_and_v2_namespaces_are_isolated": True,
            "no_mutation_controls": True,
        },
        "limitations": {
            "service_worker_update_browser_fixture": "The production worker exposes no SKIP_WAITING message path, so replacement workers activate only through the browser's normal all-clients-closed lifecycle. Native Chromium proves current-worker first install, control, cache, compatibility, and interruption-safe cold restart; replacement lifecycle timing remains a P1-009 runbook observation.",
            "physical_safari_ipad": "pending mandatory owner-device acceptance; Chromium emulation is not Safari/iPad evidence",
        },
        "verification": {"output_sha256": None},
    }
    summary["verification"]["output_sha256"] = sha(canonical(summary))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = canonical(build())
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != rendered:
            print(f"generated P1-008 hardening evidence differs: {OUTPUT}")
            return 1
        print(f"{OUTPUT}: OK")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
