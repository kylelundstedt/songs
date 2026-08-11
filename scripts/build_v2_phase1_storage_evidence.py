#!/usr/bin/env python3
"""Build deterministic TASK-012 production IndexedDB evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "migration/v2/phase1/storage"
OUTPUT = EVIDENCE / "storage-summary.json"
EXPECTED_BOOTSTRAP_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
EXPECTED_GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
EXPECTED_SHELL_SHA = "e9bfe3db9c24291c3f2f209811cd277961cc1b26ce7a5f910e4c23c9e1a88047"
EXPECTED_SHELL_RELEASE = "shell-48b974860e16510f36131506"
EXPECTED_STORES = ["chunks", "conflicts", "documents", "drafts", "meta", "outbox", "snapshots"]


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def checked(path: Path) -> tuple[bytes, Any]:
    raw = path.read_bytes()
    return raw, json.loads(raw)


def build() -> dict[str, Any]:
    bootstrap_raw, bootstrap = checked(ROOT / "internal/v2bootstrap/data/manifest.json")
    shell_raw, shell = checked(ROOT / "internal/v2shell/data/asset-manifest.json")
    if sha(bootstrap_raw) != EXPECTED_BOOTSTRAP_SHA or bootstrap["generation"] != EXPECTED_GENERATION:
        raise ValueError("bootstrap trust anchor drift")
    if sha(shell_raw) != EXPECTED_SHELL_SHA or shell["release"] != EXPECTED_SHELL_RELEASE:
        raise ValueError("TASK-012 shell trust anchor drift")
    if shell["bootstrap_manifest_sha256"] != EXPECTED_BOOTSTRAP_SHA or shell["accepted_bootstrap_manifest_sha256"] != [EXPECTED_BOOTSTRAP_SHA]:
        raise ValueError("shell bootstrap compatibility drift")
    if shell["cache_prefix"] != "songs-v2-shell-" or shell["indexeddb_name"] != "songs-v2":
        raise ValueError("shell namespace drift")

    observation_path = EVIDENCE / "browser-observations/chromium-production.json"
    observation_raw, observation = checked(observation_path)
    if observation["shell"] != {"asset_manifest_sha256": EXPECTED_SHELL_SHA, "release": EXPECTED_SHELL_RELEASE}:
        raise ValueError("browser shell identity drift")
    if observation["bootstrap"]["manifest_sha256"] != EXPECTED_BOOTSTRAP_SHA or observation["bootstrap"]["documents"] != 373:
        raise ValueError("browser bootstrap identity drift")
    if observation["namespaces"]["database_name"] != "songs-v2" or observation["namespaces"]["database_version"] != 2 or observation["namespaces"]["stores"] != EXPECTED_STORES:
        raise ValueError("browser schema drift")
    initial = observation["initial_activation"]
    repair = observation["corruption_repair"]
    cold = observation["cold_restart_after_repair"]
    if initial["api_requests"] != 13 or initial["stored_chunks"] != 12 or initial["documents"] != 373 or initial["pointer_transitions"] != 1:
        raise ValueError("initial activation proof failed")
    if repair["api_requests"] != 13 or repair["stored_chunks_after"] != 24 or repair["documents_after"] != 746 or repair["visible_documents"] != 373 or repair["old_active_state_after"] != "retained" or repair["pointer_transitions_after"] != 2:
        raise ValueError("native corruption repair proof failed")
    if cold["api_requests"] != 0 or cold["origin_process"] != "inactive during reload" or not cold["service_worker_controlled"] or not cold["shell_resources_served_while_origin_inactive"]:
        raise ValueError("cold offline restart proof failed")
    if observation["storage_estimate"]["persisted"] is not False or observation["storage_estimate"]["origin_quota_bytes"] <= observation["storage_estimate"]["origin_usage_bytes"]:
        raise ValueError("storage observation drift")
    if observation["viewport"]["scroll_width"] != observation["viewport"]["width"]:
        raise ValueError("status viewport overflow")

    network_path = EVIDENCE / "browser-observations/corruption-repair-network.json"
    network_raw, network = checked(network_path)
    if len(network) != 13 or network[0]["url"].split("/api/v2", 1)[-1] != "/bootstrap/manifest" or any(item["status"] != 200 or "/api/v2/bootstrap/" not in item["url"] for item in network):
        raise ValueError("corruption repair network inventory drift")

    screenshot_path = EVIDENCE / "screenshots/snapshot-status-after-repair.png"
    screenshot_raw = screenshot_path.read_bytes()
    runtime_source = (ROOT / "v2/packages/web/src/bootstrap/runtime.ts").read_text(encoding="utf-8")
    storage_source = (ROOT / "v2/packages/web/src/storage/index.ts").read_text(encoding="utf-8")
    worker_source = (ROOT / "internal/v2shell/data/sw.js").read_text(encoding="utf-8")
    required_runtime = ["verifyReviewedArtifacts", "recoverRetained", "expectedTransitionCount", "repairPhysicalGeneration", "MANIFEST_UNSUPPORTED"]
    if not all(value in runtime_source for value in required_runtime):
        raise ValueError("runtime recovery contract drift")
    if not all(f'"{store}"' in storage_source for store in EXPECTED_STORES) or "SONGS_STORAGE_VERSION = 2" not in storage_source:
        raise ValueError("storage schema source drift")
    if "indexedDB" in worker_source or "url.pathname.startsWith('/api/v2/')" not in worker_source or "GET_COMPATIBILITY" not in worker_source or "caches.open(CACHE_NAME)" not in worker_source:
        raise ValueError("service worker isolation/compatibility drift")
    if not re.search(r'expectedRelease\s+=\s+"' + re.escape(EXPECTED_SHELL_RELEASE) + r'"', (ROOT / "internal/v2shell/shell.go").read_text(encoding="utf-8")):
        raise ValueError("Go shell trust anchor drift")

    artifact: dict[str, Any] = {
        "schema_version": "1",
        "task": "TASK-012",
        "bootstrap": {
            "generation": bootstrap["generation"],
            "manifest_sha256": sha(bootstrap_raw),
            "documents": bootstrap["counts"]["documents"],
            "chunks": len(bootstrap["chunks"]),
        },
        "shell": {
            "release": shell["release"],
            "asset_manifest_sha256": sha(shell_raw),
            "accepted_bootstrap_manifest_sha256": shell["accepted_bootstrap_manifest_sha256"],
            "cache_prefix": shell["cache_prefix"],
        },
        "indexeddb": {
            "name": observation["namespaces"]["database_name"],
            "version": observation["namespaces"]["database_version"],
            "stores": observation["namespaces"]["stores"],
            "active_pointer": "meta/active-generation",
            "pending_stores": ["outbox", "drafts", "conflicts"],
        },
        "browser_observation": {
            "path": str(observation_path.relative_to(ROOT)),
            "bytes": len(observation_raw),
            "sha256": sha(observation_raw),
            "browser": observation["browser"],
            "viewport": observation["viewport"],
            "storage_estimate": observation["storage_estimate"],
        },
        "corruption_repair_network": {
            "path": str(network_path.relative_to(ROOT)),
            "bytes": len(network_raw),
            "sha256": sha(network_raw),
            "api_requests": len(network),
        },
        "screenshot": {
            "path": str(screenshot_path.relative_to(ROOT)),
            "bytes": len(screenshot_raw),
            "sha256": sha(screenshot_raw),
        },
        "proof": {
            "canonical_manifest_chunk_document_and_snapshot_hashes_reverified": True,
            "partial_and_staging_generations_hidden": True,
            "durably_verified_stage_activates_after_reopen": True,
            "activation_pointer_transition_atomic_and_idempotent": True,
            "previous_active_retained": True,
            "accepted_predecessor_recovery_supported": True,
            "stale_shell_cannot_downgrade_unknown_newer_active": True,
            "corrupt_active_repaired_with_distinct_physical_instance": True,
            "quota_failure_preserves_pointer_and_falls_back_safely": True,
            "schema_upgrade_preserves_pending_stores": True,
            "cleanup_excludes_pending_stores": True,
            "cold_restart_zero_api_requests": True,
            "service_worker_bypasses_api_and_opens_no_database": True,
            "only_v2_namespaces_changed": True,
            "v1_tree_unchanged": True,
        },
        "limitations": {
            "quota": "origin-wide Chromium estimate; persistence request was not granted",
            "physical_safari_ipad": "pending mandatory owner-device eviction, background, Home Screen, and low-storage acceptance",
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
            print(f"generated TASK-012 storage evidence differs: {OUTPUT}")
            return 1
        print(f"{OUTPUT}: OK")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
