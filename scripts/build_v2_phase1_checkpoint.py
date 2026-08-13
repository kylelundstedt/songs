#!/usr/bin/env python3
"""Build the deterministic TASK-016 / P1-009 software checkpoint package."""
from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "migration/v2/phase1/checkpoint"
OUTPUT = EVIDENCE / "checkpoint-summary.json"

CHECKPOINT_COMMIT = "47325f743f3092bfa7d9d108679a49a126a0b4cf"
CHECKPOINT_PACKAGE_ID = "p1-009-software-checkpoint-2026-08-12"
ROLLBACK_REF = "v1"
ROLLBACK_COMMIT = "546f59b41d9e9bcf0e81b543c27900a31e26c9e6"
SOURCE_REF = "v2-phase1-content-2026-08-10"
SOURCE_COMMIT = "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5"
EVIDENCE_REF = "v2-phase1-evidence-2026-08-10"
EVIDENCE_COMMIT = "5ea535b53b94445084586828389f44c1a5136877"
BOOTSTRAP_SHA = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
BOOTSTRAP_GENERATION = "phase1-f9634173e25ef4ca4b8330a3"
SHELL_SHA = "d3dfa5f989efa38ce237034a6f5df4834d9101195794cd124a5427c66c3dc6c7"
SHELL_RELEASE = "shell-39849548e3b7192a1c76aa6e"
BINARY_SHA = "4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc"
UNIT_SHA = "a1b1659d18660fe1ad297192ac703bbdf38d6b8d339824025a403a4aaa8bc1d3"
PUBLIC_IP = "161.210.92.174"
CERT_NOT_BEFORE = "2026-08-01T14:09:19Z"
CERT_NOT_AFTER = "2026-10-30T14:09:18Z"
EXPECTED_SUPPORTING = {
    "migration/v2/phase1/shell/browser-summary.json": "f32a31f5b0745f73edcad60a7ed5b350afc55204cd5d6f2ce990bbfd0c69fc64",
    "migration/v2/phase1/storage/storage-summary.json": "23dd82a73547aa7265eaf51899c82b31b1618ac7252ee4001c6c2207c8331fc4",
    "migration/v2/phase1/library/library-summary.json": "f0f57f59789af654c7e814f79ef771d56ba27880dc7b312d16e21ea1539dc382",
    "migration/v2/phase1/live/live-summary.json": "129fbe74573f686a830d4480c219efd3c34018733504f7f3e39209e7a10bb0a6",
    "migration/v2/phase1/hardening/hardening-summary.json": "5792e48749bf9d032fa2fc97be82b6bb7a43b403f6a9a68c88013a7a9f1ef8f3",
    "migration/v2/current/coexistence/browser-summary.json": "44cd55b26b48c59b21c3a0a14bb340922c83f07c0e5a09f8476865d183459c8d",
}
SESSION_RELATIVE = "migration/v2/phase1/checkpoint/physical/sessions/2026-08-13-ipad-pro-13-m5/checklist.json"
SESSION_TAG = "v2-p1-009-software-checkpoint-2026-08-12"
SESSION_TAG_COMMIT = "89cf2a1f7cbc025c99d3121923a1c3ddbd4a7aa3"
SESSION_SUMMARY_FILE_SHA = "137b5a3f3841d516e15a082c18e6b630abceacb13ecd8efc2cdddf2f8fe265a2"
SESSION_SUMMARY_SELF_SHA = "4eeb53adb7ef682d681c3afc98d4f0555dbb1ffd0c2c22dfd1d66e6439d5b860"
SOFTWARE_MATRIX = {
    "SW-001": "Frozen rollback, source, and evidence annotated refs match reviewed commits",
    "SW-002": "Bootstrap and shell trust anchors match the checkpoint release",
    "SW-003": "All deterministic TypeScript, Go, Python, fixture, and evidence checks pass",
    "SW-004": "Native Chromium desktop/tablet/phone route matrix passes",
    "SW-005": "Malformed hashes and unknown document paths fail explicitly",
    "SW-006": "Cold offline route reloads make zero API and post-ready application requests",
    "SW-007": "Interrupted, corrupt, quota, and retained-snapshot recovery contracts pass",
    "SW-008": "Offline library, search, and status behavior passes",
    "SW-009": "All Set Lists and locked Live occurrence behavior pass",
    "SW-010": "Axe, overflow, reduced motion, keyboard, and touch-target checks pass",
    "SW-011": "V1 remains default and V2 process/origin/cache/database namespaces remain isolated",
    "SW-012": "No mutation, provider, sync, publication, or outbox-submission controls are exposed",
    "SW-013": "Release binary builds reproducibly and matches the deployed binary",
    "SW-014": "Tracked service unit matches the installed V2 systemd unit",
    "SW-015": "Public port-8001 TLS/private-login boundary rejects unauthenticated and forged identity requests",
    "SW-016": "Runbook, physical checklist, session template, signoff form, and release archive are complete",
    "SW-017": "Storage/export limitations and writable-client prerequisites are explicit",
    "SW-018": "Every checkpoint artifact hash and self-hash reproduces exactly",
}


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def checked(relative: str) -> tuple[bytes, Any]:
    raw = (ROOT / relative).read_bytes()
    return raw, json.loads(raw)


def artifact(relative: str, expected_sha: str | None = None) -> dict[str, Any]:
    raw = (ROOT / relative).read_bytes()
    digest = sha(raw)
    if expected_sha is not None and digest != expected_sha:
        raise ValueError(f"artifact hash drift: {relative}")
    return {"path": relative, "bytes": len(raw), "sha256": digest}


def git_output(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True, capture_output=True, text=True).stdout.strip()


def git_bytes(ref: str, relative: str) -> bytes:
    return subprocess.run(["git", "-C", str(ROOT), "show", f"{ref}:{relative}"], check=True, capture_output=True).stdout


def verify_refs() -> list[dict[str, str]]:
    records = []
    for name, commit, role in (
        (ROLLBACK_REF, ROLLBACK_COMMIT, "permanent v1 rollback oracle"),
        (SOURCE_REF, SOURCE_COMMIT, "frozen Phase 1 canonical source"),
        (EVIDENCE_REF, EVIDENCE_COMMIT, "frozen Phase 1 evidence inputs"),
    ):
        if git_output("cat-file", "-t", name) != "tag" or git_output("rev-parse", f"{name}^{{}}") != commit:
            raise ValueError(f"annotated ref drift: {name}")
        records.append({"ref": name, "commit": commit, "role": role})
    if git_output("rev-parse", CHECKPOINT_COMMIT) != CHECKPOINT_COMMIT:
        raise ValueError("checkpoint commit is unavailable")
    return records


def validate_summaries() -> list[dict[str, Any]]:
    records = []
    for relative, expected in EXPECTED_SUPPORTING.items():
        raw, value = checked(relative)
        if sha(raw) != expected:
            raise ValueError(f"supporting summary drift: {relative}")
        if value.get("verification", {}).get("output_sha256") is None:
            raise ValueError(f"supporting summary lacks self hash: {relative}")
        records.append({"path": relative, "bytes": len(raw), "sha256": expected, "task": value.get("task", "coexistence")})
    hardening = json.loads((ROOT / "migration/v2/phase1/hardening/hardening-summary.json").read_text(encoding="utf-8"))
    if hardening["shell"] != {"release": SHELL_RELEASE, "asset_manifest_sha256": SHELL_SHA, "cache_name": f"songs-v2-shell-{SHELL_RELEASE.removeprefix('shell-')}"}:
        raise ValueError("hardening shell identity drift")
    if hardening["native_capture"]["offline_api_requests"] != 0 or not hardening["proof"]["no_mutation_controls"]:
        raise ValueError("hardening checkpoint proof drift")
    return records


def validate_release() -> dict[str, Any]:
    archive_relative = "migration/v2/phase1/checkpoint/release/songs-v2-api-linux-amd64.xz"
    archive_raw = (ROOT / archive_relative).read_bytes()
    binary_raw = lzma.decompress(archive_raw)
    if sha(binary_raw) != BINARY_SHA:
        raise ValueError("checkpoint release binary hash drift")
    if sha((ROOT / "songs-v2-api.service").read_bytes()) != UNIT_SHA:
        raise ValueError("tracked checkpoint service-unit hash drift")
    unit = artifact("migration/v2/phase1/checkpoint/release/songs-v2-api.service", UNIT_SHA)
    sums = artifact("migration/v2/phase1/checkpoint/release/SHA256SUMS")
    expected_sums = f"{sha(archive_raw)}  songs-v2-api-linux-amd64.xz\n{UNIT_SHA}  songs-v2-api.service\n".encode("utf-8")
    if (ROOT / "migration/v2/phase1/checkpoint/release/SHA256SUMS").read_bytes() != expected_sums:
        raise ValueError("checkpoint SHA256SUMS drift")
    if (ROOT / "migration/v2/phase1/checkpoint/release/songs-v2-api.service").read_bytes() != (ROOT / "songs-v2-api.service").read_bytes():
        raise ValueError("packaged unit differs from tracked checkpoint unit")
    return {
        "binary": {"path": archive_relative, "archive_bytes": len(archive_raw), "archive_sha256": sha(archive_raw), "uncompressed_bytes": len(binary_raw), "uncompressed_sha256": BINARY_SHA, "format": "xz", "platform": "linux-amd64"},
        "service_unit": unit,
        "sha256sums": sums,
        "runtime": {"listen": "127.0.0.1:8001", "working_directory": "/home/exedev/songs-v2", "service": "songs-v2-api.service", "exec": f"/home/exedev/songs-v2/var/releases/p1-009-checkpoint-{BINARY_SHA[:17]}/songs-v2-api"},
    }


def validate_observation() -> dict[str, Any]:
    relative = "migration/v2/phase1/checkpoint/software-observation.json"
    raw, observation = checked(relative)
    expected_self = observation.get("verification", {}).get("output_sha256")
    copy = json.loads(raw)
    copy["verification"]["output_sha256"] = None
    if expected_self != sha(canonical(copy)):
        raise ValueError("software observation self hash drift")
    build = observation["reproducible_build"]
    if not build["byte_identical"] or {build["build_1_sha256"], build["build_2_sha256"], build["deployed_binary_sha256"]} != {BINARY_SHA}:
        raise ValueError("reproducible/deployed binary observation drift")
    services = observation["services"]
    if not all((services[role]["enabled"] and services[role]["active"]) for role in ("v1", "v2")):
        raise ValueError("service health observation failed")
    if services["v1"]["commit"] != SOURCE_COMMIT or services["v2"]["listener"] != "127.0.0.1:8001" or services["v2"]["installed_unit_sha256"] != UNIT_SHA or not services["v2"]["unit_bytes_match"]:
        raise ValueError("service identity/isolation observation drift")
    local = observation["local_authenticated_probe"]
    if local["root_status"] != 200 or local["manifest_status"] != 200 or local["manifest_etag"] != BOOTSTRAP_SHA or local["manifest_body_sha256"] != BOOTSTRAP_SHA:
        raise ValueError("local authenticated probe drift")
    public = observation["public_proxy_probe"]
    if public["public_dns_ipv4"] != PUBLIC_IP or public["tls"]["negotiated"] != "TLSv1.3" or public["unauthenticated"]["status"] != 307 or public["forged_identity_header"]["status"] != 307 or public["forged_identity_header"]["reached_application"]:
        raise ValueError("public proxy/auth observation drift")
    if public["authorized_owner_reachability"] != "PENDING":
        raise ValueError("owner reachability must remain pending until physical confirmation")
    if observation["checkpoint_commit"] != CHECKPOINT_COMMIT or not observation["checkpoint_worktree"]["package_files_uncommitted_during_observation"] or not observation["checkpoint_worktree"]["completion_commit_or_tag_is_not_an_acceptance_input"]:
        raise ValueError("checkpoint observation dependency direction drift")
    return {"path": relative, "bytes": len(raw), "sha256": sha(raw), "self_sha256": expected_self, "observation": observation}


def validate_update_drill() -> dict[str, Any]:
    metadata_relative = "migration/v2/phase1/checkpoint/update-drill/successor-metadata.json"
    raw, metadata = checked(metadata_relative)
    expected = metadata.get("verification", {}).get("metadata_sha256")
    copy = json.loads(raw)
    copy["verification"]["metadata_sha256"] = None
    if expected != sha(canonical(copy)):
        raise ValueError("update-drill metadata self hash drift")
    if metadata["source_commit"] != CHECKPOINT_COMMIT or metadata["physical_target"] != "PHY-039" or metadata["status"] != "SOFTWARE_PASS_PHYSICAL_PENDING":
        raise ValueError("update-drill identity/status drift")
    if metadata["bootstrap"] != {"generation": BOOTSTRAP_GENERATION, "manifest_sha256": BOOTSTRAP_SHA}:
        raise ValueError("update-drill bootstrap compatibility drift")
    successor = metadata["successor"]
    if successor["shell_release"] == SHELL_RELEASE or successor["cache_name"] == f"songs-v2-shell-{SHELL_RELEASE.removeprefix('shell-')}":
        raise ValueError("update-drill successor is not distinct")
    archive_relative = "migration/v2/phase1/checkpoint/update-drill/release/songs-v2-api-linux-amd64.xz"
    archive_raw = (ROOT / archive_relative).read_bytes()
    if sha(archive_raw) != metadata["binary"]["archive_sha256"] or sha(lzma.decompress(archive_raw)) != metadata["binary"]["sha256"] or metadata["binary"]["reproducible_builds"] != 2:
        raise ValueError("update-drill binary/archive drift")
    unit = artifact("migration/v2/phase1/checkpoint/update-drill/release/songs-v2-api.service")
    expected_exec = f"ExecStart=/home/exedev/songs-v2/var/releases/p1-009-successor-{metadata['binary']['sha256'][:17]}/songs-v2-api -listen 127.0.0.1:8001"
    if expected_exec not in (ROOT / unit["path"]).read_text(encoding="utf-8"):
        raise ValueError("update-drill content-addressed service path drift")
    expected_sums = f"{metadata['binary']['archive_sha256']}  songs-v2-api-linux-amd64.xz\n{unit['sha256']}  songs-v2-api.service\n".encode("utf-8")
    sums_path = ROOT / "migration/v2/phase1/checkpoint/update-drill/release/SHA256SUMS"
    if sums_path.read_bytes() != expected_sums:
        raise ValueError("update-drill SHA256SUMS drift")
    sums = artifact("migration/v2/phase1/checkpoint/update-drill/release/SHA256SUMS")
    readme = artifact("migration/v2/phase1/checkpoint/update-drill/README.md")
    generator = artifact("scripts/build_v2_phase1_update_drill.py")
    return {"metadata": {"path": metadata_relative, "bytes": len(raw), "sha256": sha(raw), "self_sha256": expected}, "archive": artifact(archive_relative), "service_unit": unit, "sha256sums": sums, "readme": readme, "generator": generator, "successor": successor, "binary_sha256": metadata["binary"]["sha256"]}


def validate_physical() -> tuple[dict[str, Any], list[dict[str, str]]]:
    _, matrix = checked("migration/v2/phase1/checkpoint/physical/device-matrix.json")
    items = matrix["items"]
    if matrix["status"] != "PENDING" or matrix["software_evidence_may_satisfy_items"] or len(items) != 57:
        raise ValueError("physical matrix identity/status drift")
    expected_ids = [f"PHY-{number:03d}" for number in range(1, 58)]
    if [item["id"] for item in items] != expected_ids or any(item["status"] != "PENDING" for item in items):
        raise ValueError("physical matrix items must all remain pending")
    gates = {item["gate"] for item in items}
    if gates != {f"G{number}" for number in range(1, 8)}:
        raise ValueError("physical gate inventory drift")
    policy = matrix.get("acceptance_policy")
    expected_policy = {
        "read_only_physical_evaluation": "G1-G5 required items",
        "optional_nonblocking_items": ["PHY-044"],
        "optional_operational_trials": ["G6", "G7"],
        "writable_features_covered": False,
        "stage_or_gig_use_implied": False,
    }
    if policy != expected_policy:
        raise ValueError("physical acceptance policy drift")
    for item in items:
        expected_blocking = item["id"] != "PHY-044" and item["gate"] not in {"G6", "G7"}
        expected_category = "optional_accessibility_observation" if item["id"] == "PHY-044" else "optional_operational_trial" if item["gate"] in {"G6", "G7"} else "read_only_physical_evaluation"
        if item.get("blocking") != expected_blocking or item.get("category") != expected_category:
            raise ValueError(f"physical item policy drift: {item['id']}")
    records = [{"id": item["id"], "gate": item["gate"], "title": item["title"], "status": "PENDING", "blocking": item["blocking"], "category": item["category"]} for item in items]
    blocking_count = sum(item["blocking"] for item in items)
    return {"status": "PENDING", "required": True, "item_count": len(records), "blocking_item_count": blocking_count, "optional_item_count": len(records) - blocking_count, "policy": policy, "gates": sorted(gates), "signoff": None}, records


def validate_recorded_session() -> dict[str, Any]:
    raw, session = checked(SESSION_RELATIVE)
    if session.get("status") != "IN_PROGRESS" or session.get("software_evidence_may_satisfy_items") or not session.get("required"):
        raise ValueError("recorded physical session identity/status drift")
    checkpoint = session.get("session", {}).get("checkpoint")
    expected_checkpoint = {
        "publication_tag": SESSION_TAG,
        "tagged_commit": SESSION_TAG_COMMIT,
        "summary_file_sha256": SESSION_SUMMARY_FILE_SHA,
        "summary_self_sha256": SESSION_SUMMARY_SELF_SHA,
    }
    if checkpoint != expected_checkpoint:
        raise ValueError("recorded physical session checkpoint binding drift")
    if git_output("rev-parse", f"{SESSION_TAG}^{{}}") != SESSION_TAG_COMMIT:
        raise ValueError("recorded physical session tag drift")
    tagged_summary = git_bytes(SESSION_TAG, "migration/v2/phase1/checkpoint/checkpoint-summary.json")
    if sha(tagged_summary) != SESSION_SUMMARY_FILE_SHA or json.loads(tagged_summary)["verification"]["output_sha256"] != SESSION_SUMMARY_SELF_SHA:
        raise ValueError("recorded physical session tagged summary drift")
    items = session["items"]
    if [item["id"] for item in items] != [f"PHY-{number:03d}" for number in range(1, 58)]:
        raise ValueError("recorded physical session item inventory drift")
    expected_statuses = {
        **{f"PHY-{number:03d}": "PASS" for number in range(1, 28)},
        "PHY-028": "PENDING", "PHY-029": "PENDING",
        **{f"PHY-{number:03d}": "PASS" for number in range(30, 32)},
        "PHY-032": "PENDING",
        **{f"PHY-{number:03d}": "PASS" for number in range(33, 37)},
        "PHY-037": "PENDING", "PHY-038": "PENDING", "PHY-039": "PASS",
        **{f"PHY-{number:03d}": "PASS" for number in range(40, 44)},
        "PHY-044": "NOT_REQUIRED",
        **{f"PHY-{number:03d}": "PASS" for number in range(45, 51)},
        **{f"PHY-{number:03d}": "NOT_PLANNED" for number in range(51, 58)},
    }
    if {item["id"]: item["status"] for item in items} != expected_statuses:
        raise ValueError("recorded physical session result drift")
    for item in items:
        expected_blocking = item["id"] != "PHY-044" and item["gate"] not in {"G6", "G7"}
        if item.get("blocking") != expected_blocking:
            raise ValueError(f"recorded physical session blocking policy drift: {item['id']}")
        if item["status"] == "PASS" and not item.get("evidence"):
            raise ValueError(f"recorded physical PASS lacks evidence: {item['id']}")
    deferred = [item["id"] for item in items if item["blocking"] and item["status"] == "PENDING"]
    if deferred != ["PHY-028", "PHY-029", "PHY-032", "PHY-037", "PHY-038"]:
        raise ValueError("recorded physical deferred G4 inventory drift")
    timings = json.loads((ROOT / SESSION_RELATIVE).with_name("timings.json").read_text(encoding="utf-8"))
    if timings.get("checkpoint") != expected_checkpoint:
        raise ValueError("recorded physical timings checkpoint binding drift")
    notes = (ROOT / SESSION_RELATIVE).with_name("notes.md").read_text(encoding="utf-8")
    for token in ("deferred blocking G4 checks", "NOT_REQUIRED", "NOT_PLANNED", "unimplemented and untested", "No writable"):
        if token.casefold() not in notes.casefold():
            raise ValueError(f"recorded physical session notes contract missing: {token}")
    return {
        "path": SESSION_RELATIVE,
        "bytes": len(raw),
        "sha256": sha(raw),
        "status": "IN_PROGRESS",
        "checkpoint": checkpoint,
        "passed": sum(item["status"] == "PASS" for item in items),
        "deferred_blocking": deferred,
        "optional_not_required": ["PHY-044"],
        "optional_not_planned": [f"PHY-{number:03d}" for number in range(51, 58)],
        "writable_features_covered": False,
    }


def validate_docs() -> list[dict[str, Any]]:
    required = [
        "docs/v2/tasks/TASK-016-software-checkpoint-physical-device-acceptance.md",
        "docs/v2/runbooks/P1-009-install-upgrade-rollback.md",
        "docs/v2/acceptance/P1-009-ipad-safari-checklist.md",
        "docs/v2/acceptance/P1-009-signoff-template.md",
        "migration/v2/phase1/checkpoint/README.md",
        "migration/v2/phase1/checkpoint/physical/device-matrix.json",
        "migration/v2/phase1/checkpoint/physical/sessions/TEMPLATE/checklist.json",
        "migration/v2/phase1/checkpoint/physical/sessions/TEMPLATE/notes.md",
        "migration/v2/phase1/checkpoint/physical/sessions/TEMPLATE/timings.json",
        "scripts/capture_v2_phase1_checkpoint_observation.py",
        "scripts/install_v2_phase1_release.sh",
        "scripts/rollback_v2_phase1_release.sh",
    ]
    records = [artifact(relative) for relative in required]
    records.append(artifact("scripts/build_v2_phase1_checkpoint.py"))
    combined = "\n".join((ROOT / relative).read_text(encoding="utf-8") for relative in required if relative.endswith(".md"))
    for token in (
        "https://kgl-songs.exe.xyz:8001/#/",
        "https://kgl-songs.exe.xyz/",
        "SOFTWARE_PASS_PHYSICAL_PENDING",
        "No user-facing V2 export/import",
        "read-only physical evaluation",
        "Writable",
    ):
        if token.casefold() not in combined.casefold():
            raise ValueError(f"checkpoint documentation contract missing: {token}")
    return records


def build() -> dict[str, Any]:
    refs = verify_refs()
    bootstrap_raw, bootstrap = checked("internal/v2bootstrap/data/manifest.json")
    shell_raw, shell = checked("internal/v2shell/data/asset-manifest.json")
    if sha(bootstrap_raw) != BOOTSTRAP_SHA or bootstrap["generation"] != BOOTSTRAP_GENERATION:
        raise ValueError("bootstrap checkpoint identity drift")
    if sha(shell_raw) != SHELL_SHA or shell["release"] != SHELL_RELEASE or shell["accepted_bootstrap_manifest_sha256"] != [BOOTSTRAP_SHA]:
        raise ValueError("shell checkpoint identity drift")
    if sha(git_bytes(CHECKPOINT_COMMIT, "internal/v2bootstrap/data/manifest.json")) != BOOTSTRAP_SHA or sha(git_bytes(CHECKPOINT_COMMIT, "internal/v2shell/data/asset-manifest.json")) != SHELL_SHA:
        raise ValueError("checkpoint commit trust anchors drift")

    supporting = validate_summaries()
    release = validate_release()
    software_observation = validate_observation()
    update_drill = validate_update_drill()
    physical, physical_matrix = validate_physical()
    recorded_session = validate_recorded_session()
    documents = validate_docs()
    software_matrix = [{"id": identifier, "title": title, "status": "PASS"} for identifier, title in SOFTWARE_MATRIX.items()]

    artifact_value: dict[str, Any] = {
        "schema_version": "1",
        "task": "TASK-016",
        "phase_packet": "P1-009",
        "checkpoint_package_id": CHECKPOINT_PACKAGE_ID,
        "checkpoint_code_commit": CHECKPOINT_COMMIT,
        "acceptance_root": {
            "kind": "immutable tagged software checkpoint plus living supplemental index",
            "software_checkpoint": {
                "publication_tag": SESSION_TAG,
                "tagged_commit": SESSION_TAG_COMMIT,
                "tagged_summary_path": "migration/v2/phase1/checkpoint/checkpoint-summary.json",
                "tagged_summary_file_sha256": SESSION_SUMMARY_FILE_SHA,
                "tagged_summary_self_sha256": SESSION_SUMMARY_SELF_SHA,
            },
            "current_summary": {
                "path": "migration/v2/phase1/checkpoint/checkpoint-summary.json",
                "self_sha256": "verification.output_sha256",
                "role": "living supplemental policy, session, and roadmap index; does not rewrite the tagged software checkpoint",
            },
            "dependency_direction": "reviewed refs and code commit -> immutable tagged checkpoint; later policy/session/roadmap records -> living supplemental index",
        },
        "status": {
            "software": "PASS",
            "physical": "PENDING",
            "overall": "SOFTWARE_PASS_PHYSICAL_PENDING",
            "stage_ready": False,
            "writable_allowed": False,
            "default_route_or_cutover_allowed": False,
        },
        "urls": {"v1_default_and_fallback": "https://kgl-songs.exe.xyz/", "v2_opt_in_install": "https://kgl-songs.exe.xyz:8001/#/"},
        "refs": refs,
        "bootstrap": {"generation": BOOTSTRAP_GENERATION, "manifest_sha256": BOOTSTRAP_SHA, "documents": 373, "songs": 339, "sets": 34, "set_entries": 1076, "chunks": 12},
        "shell": {"release": SHELL_RELEASE, "asset_manifest_sha256": SHELL_SHA, "cache_prefix": "songs-v2-shell-", "indexeddb_name": "songs-v2"},
        "release": release,
        "update_drill": update_drill,
        "software_observation": software_observation,
        "service_observation": software_observation["observation"]["services"],
        "public_proxy_observation": software_observation["observation"]["public_proxy_probe"],
        "software_matrix": software_matrix,
        "physical": physical,
        "physical_matrix": physical_matrix,
        "recorded_physical_session": recorded_session,
        "storage_and_export": {
            "product_mode": "read-only",
            "persistence_guaranteed": False,
            "chromium_persistence_observation": "denied",
            "quota_and_headroom": "origin-wide advisory diagnostics",
            "user_facing_export_import": False,
            "authored_v2_user_data": False,
            "pending_stores_exposed": False,
            "writable_prerequisite": "browser export/recovery for unsynced authored work",
        },
        "supporting_evidence": supporting,
        "package_documents": documents,
        "commands": {
            "deterministic": ["make v2-check", "python3 -m unittest discover -s tests", "go test ./...", "go test -race ./internal/v2bootstrap/... ./internal/v2shell/...", "go vet ./...", "git diff --check"],
            "native_browser": "make v2-browser-check",
            "checkpoint": "python3 scripts/build_v2_phase1_checkpoint.py --check",
        },
        "prohibited_claims": ["support outside the approved iPad contract", "VoiceOver or screen-reader compatibility", "persistence or eviction resistance", "Home Screen reliability beyond recorded checks", "stage or gig readiness", "writable readiness", "default-route or cutover readiness", "v1 retirement"],
        "next_required_action": "Begin TASK-017 production authorization and durable sync. Continue TASK-018–021 through complete Set List and lead-sheet writable workflows, then TASK-022 product-wide web design overhaul. Defer TASK-023/024 printing/export; complete deferred blocking read-only G4 checks before TASK-021 physical acceptance.",
        "verification": {"output_sha256": None},
    }
    artifact_value["verification"]["output_sha256"] = sha(canonical(artifact_value))
    return artifact_value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = canonical(build())
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != rendered:
            print(f"generated P1-009 checkpoint differs: {OUTPUT}")
            return 1
        print(f"{OUTPUT}: OK")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
