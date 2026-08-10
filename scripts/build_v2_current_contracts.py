#!/usr/bin/env python3
"""Build route and separate-origin coexistence contracts for Phase 1."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT

ROUTE_OUTPUT = CURRENT_ROOT / "routes/route-policy.json"
COEXISTENCE_OUTPUT = CURRENT_ROOT / "coexistence/coexistence-policy.json"


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def with_hash(value: dict[str, Any]) -> bytes:
    value["verification"]["output_sha256"] = None
    value["verification"]["output_sha256"] = hashlib.sha256(canonical(value)).hexdigest()
    return canonical(value)


def route_decisions() -> dict[str, tuple[str, str | None, str]]:
    return {
        "GET /{$}": ("preserve", "/", "V2 pilot origin root opens its read-only dashboard while v1 remains default on its own origin"),
        "GET /songs": ("preserve", "/songs", "canonical library bookmark"),
        "GET /songs/new": ("redirect", "/songs", "Phase 1 is read-only and exposes no draft form"),
        "POST /songs": ("defer", None, "song creation is outside the read-only slice"),
        "GET /set-lists": ("preserve", "/set-lists", "canonical Set List library bookmark"),
        "GET /about": ("preserve", "/about", "product and build information remains available"),
        "GET /song/{id}": ("preserve", "/song/{slug}", "legacy bookmark slug resolves through identity-sidecars slug_routes to an immutable lead-sheet ID"),
        "GET /sets/{id}": ("preserve", "/sets/{slug}", "legacy bookmark slug resolves through identity-sidecars slug_routes to an immutable Set List ID"),
        "GET /api/sets/{id}/markdown": ("defer", None, "authenticated authoring source is outside Phase 1"),
        "PUT /api/sets/{id}/markdown": ("defer", None, "Set List writes require the production sync gate"),
        "PUT /api/sets/{id}/order": ("defer", None, "Set Entry reorder requires stable IDs and production sync"),
        "POST /api/sets/{id}/items": ("defer", None, "Set Entry creation requires the writable slice"),
        "DELETE /api/sets/{id}/items/{position}": ("defer", None, "position-based deletion is replaced by stable Set Entry IDs"),
        "GET /sets/{id}/live": ("preserve", "/sets/{slug}/live", "performance bookmark slug resolves through identity sidecars before locked Live navigation"),
        "GET /api/lyrics/search": ("defer", None, "remote provider workflows are not part of offline Phase 1"),
        "POST /api/lyrics/import": ("defer", None, "provider import is a later writable workflow"),
        "GET /api/catalog": ("defer", None, "legacy catalog remains on v1; V2 introduces a new versioned bootstrap contract without redirecting JSON clients"),
        "GET /api/songs/{id}": ("preserve", "/api/songs/{id}", "legacy read clients remain supported during parallel operation"),
        "GET /api/songs/{id}/markdown": ("defer", None, "authenticated authoring source is outside Phase 1"),
        "PUT /api/songs/{id}/markdown": ("defer", None, "lead-sheet writing is later than the first writable Set List slice"),
        "GET /api/offline/sets/{id}": ("preserve", "/api/offline/sets/{id}", "v1 offline snapshots remain available during parallel operation"),
        "POST /api/shelley/edit": ("defer", None, "LLM editing is not a core offline workflow"),
        "GET /api/shelley/jobs/{id}": ("defer", None, "Shelley jobs remain a legacy/provider workflow"),
        "POST /api/reindex": ("retire", None, "V2 internal projection rebuilds are not a client-facing mutation route"),
        "GET /manifest.webmanifest": ("preserve", "/manifest.webmanifest", "each origin serves its own manifest"),
        "GET /sw.js": ("preserve", "/sw.js", "each origin serves a same-origin worker with independent scope/storage names"),
        "* /static/": ("preserve", "/static/<asset>", "exact assets remain; directory listing behavior is retired"),
    }


def build_route_policy(repo: Path) -> bytes:
    baseline_path = repo / CURRENT_ROOT / "routes/route-baseline.json"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    if baseline.get("baseline") != {"ref": CURRENT_REF, "commit": CURRENT_COMMIT}:
        raise ValueError("current route baseline identity mismatch")
    identity = json.loads((repo / CURRENT_ROOT / "identity-sidecars.json").read_text(encoding="utf-8"))
    if identity.get("baseline") != {"ref": CURRENT_REF, "commit": CURRENT_COMMIT} or identity.get("counts", {}).get("slug_routes") != 373:
        raise ValueError("current identity sidecar/slug map mismatch")
    inventory = baseline["route_inventory"]
    decisions = route_decisions()
    keys = {f'{route["method"]} {route["path"]}' for route in inventory}
    if keys != set(decisions):
        raise ValueError(f"route policy coverage mismatch: missing={sorted(keys-set(decisions))} extra={sorted(set(decisions)-keys)}")
    routes = []
    for route in inventory:
        key = f'{route["method"]} {route["path"]}'
        decision, target, rationale = decisions[key]
        item = {
            "method": route["method"],
            "path": route["path"],
            "legacy_classification": route["classification"],
            "decision": decision,
            "parallel_operation": "legacy route remains on v1 default origin",
            "target": target,
            "rationale": rationale,
        }
        routes.append(item)
    counts = {name: sum(route["decision"] == name for route in routes) for name in ("preserve", "redirect", "retire", "defer")}
    value = {
        "schema_version": "1",
        "baseline": {"ref": CURRENT_REF, "commit": CURRENT_COMMIT},
        "source_route_baseline_sha256": baseline["verification"]["output_sha256"],
        "identity_sidecars_sha256": identity["verification"]["output_sha256"],
        "slug_route_count": identity["counts"]["slug_routes"],
        "policy": {
            "parallel_default": "v1 remains on the default origin; V2 is opt-in on its isolated origin",
            "redirect_timing": "redirects are policy targets only and are not activated before cutover approval",
            "edge_behavior_retired": [
                "browsable /static/ directory index",
                "arbitrary offline fallback of every failed GET to /",
                "authoring/provider controls in Live mode",
            ],
        },
        "counts": {"registered_routes": len(routes), **counts},
        "routes": routes,
        "verification": {"output_sha256": None},
    }
    return with_hash(value)


def normalized_origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, parsed.hostname or "", port


def build_coexistence_policy(repo: Path) -> bytes:
    routes = json.loads((repo / CURRENT_ROOT / "routes/route-baseline.json").read_text(encoding="utf-8"))
    worker_record = next(record for record in routes["records"] if record["id"] == "service-worker")
    v1_cache = worker_record["response"]["semantic"]["cache_name"]
    v1_public = "https://kgl-songs.exe.xyz/"
    v2_public = "https://kgl-songs.exe.xyz:8001/"
    if normalized_origin(v1_public) == normalized_origin(v2_public):
        raise ValueError("V1 and V2 public origins must differ")
    value = {
        "schema_version": "1",
        "baseline": {"ref": CURRENT_REF, "commit": CURRENT_COMMIT},
        "decision": "separate-origin parallel deployment",
        "origins": {
            "v1": {"public": v1_public, "local": "http://127.0.0.1:8000/", "role": "default production and rollback"},
            "v2": {"public": v2_public, "local": "http://127.0.0.1:8001/", "role": "opt-in Phase 1 pilot"},
        },
        "names": {
            "v1_manifest": "/manifest.webmanifest",
            "v2_manifest": "/manifest.webmanifest",
            "v1_service_worker": "/sw.js",
            "v2_service_worker": "/sw.js",
            "v1_cache_exact": v1_cache,
            "v2_cache_prefix": "songs-v2-shell-",
            "v2_test_cache_exact": "songs-v2-shell-coexistence-v1",
            "v1_indexeddb": None,
            "v2_indexeddb": "songs-v2",
        },
        "browser_test": {
            "v1_origin": "http://127.0.0.1:8770",
            "v2_origin": "http://127.0.0.1:8771",
            "v1_implementation": "actual worker/assets proxied from the frozen source tag",
            "v2_implementation": "synthetic reservation probe; production V2 shell does not exist yet",
        },
        "assertions": {
            "origins_are_distinct": True,
            "service_worker_control_cannot_cross_origin": True,
            "cache_storage_is_origin_partitioned": True,
            "indexeddb_is_origin_partitioned": True,
            "v1_root_worker_change_required": False,
            "default_routes_change_in_phase1": False,
        },
        "browser_evidence": "migration/v2/current/coexistence/browser-summary.json",
        "browser_evidence_scope": "actual frozen v1 worker plus synthetic V2 namespace reservation on two loopback origins; the future V2 shell/public port is a P1-004 acceptance test",
        "fallback": "If the separate origin cannot be retained, stop and implement/test the documented root-worker bypass and controller handoff before /v2/ deployment.",
        "verification": {"output_sha256": None},
    }
    return with_hash(value)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    outputs = {ROUTE_OUTPUT: build_route_policy(repo), COEXISTENCE_OUTPUT: build_coexistence_policy(repo)}
    changed = [repo / path for path, raw in outputs.items() if not (repo / path).is_file() or (repo / path).read_bytes() != raw]
    if args.check:
        if changed:
            print("generated current contracts differ:\n" + "\n".join(map(str, changed)), file=sys.stderr)
            return 1
        print("current route/coexistence contracts: OK")
        return 0
    for relative, raw in outputs.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_bytes() != raw:
            target.write_bytes(raw)
            print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
