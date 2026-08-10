#!/usr/bin/env python3
"""Validate separate-origin service-worker, Cache Storage, and IndexedDB evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT

RAW = CURRENT_ROOT / "coexistence/browser-observations"
POLICY = CURRENT_ROOT / "coexistence/coexistence-policy.json"
OUTPUT = CURRENT_ROOT / "coexistence/browser-summary.json"


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: object required")
    return value


def validate(
    path: Path,
    role: str,
    expected_origin: str,
    expected_cache: str,
    expected_database: str | None,
    expected_implementation: str,
    identity: dict[str, str] | None,
) -> tuple[dict[str, Any], dict[str, str]]:
    data = load(path)
    if data.get("schema_version") != "1" or data.get("baseline") != {"ref": CURRENT_REF, "commit": CURRENT_COMMIT}:
        raise ValueError(f"{path}: exact baseline required")
    expected = {"cache": expected_cache, "database": expected_database}
    if data.get("role") != role or data.get("expected") != expected or data.get("implementation") != expected_implementation:
        raise ValueError(f"{path}: role/config/implementation mismatch")
    origin = data.get("origin")
    parsed = urlsplit(origin) if isinstance(origin, str) else None
    if origin != expected_origin or parsed is None or parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port is None:
        raise ValueError(f"{path}: exact loopback test origin required")
    worker = data.get("service_worker")
    if not isinstance(worker, dict) or worker.get("controlled") is not True:
        raise ValueError(f"{path}: page is not controlled by its worker")
    if worker.get("scope") != origin + "/" or worker.get("script_url") != origin + "/sw.js":
        raise ValueError(f"{path}: worker identity/scope mismatch")
    if data.get("cache_names") != [expected_cache]:
        raise ValueError(f"{path}: cache namespace mismatch")
    expected_databases = [] if expected_database is None else [expected_database]
    if data.get("database_names") != expected_databases:
        raise ValueError(f"{path}: IndexedDB namespace mismatch")
    engine = data.get("browser_engine")
    if not isinstance(engine, dict) or not all(isinstance(engine.get(key), str) and engine[key] for key in ("name", "user_agent", "platform")):
        raise ValueError(f"{path}: browser identity required")
    current_identity = {key: engine[key] for key in ("name", "user_agent", "platform")}
    if identity is not None and current_identity != identity:
        raise ValueError(f"{path}: browser identity differs")
    record = {
        "role": role,
        "path": path.name,
        "sha256": sha256(path.read_bytes()),
        "bytes": path.stat().st_size,
        "origin": origin,
        "service_worker": worker,
        "cache_names": data["cache_names"],
        "database_names": data["database_names"],
    }
    return record, current_identity


def build(repo: Path) -> bytes:
    policy = load(repo / POLICY)
    if policy.get("baseline") != {"ref": CURRENT_REF, "commit": CURRENT_COMMIT}:
        raise ValueError("coexistence policy baseline mismatch")
    records = []
    identity = None
    names = policy["names"]
    browser_test = policy["browser_test"]
    expected = {
        "v1": {
            "origin": browser_test["v1_origin"],
            "cache": names["v1_cache_exact"],
            "database": names["v1_indexeddb"],
            "implementation": "actual-frozen-v1",
        },
        "v2": {
            "origin": browser_test["v2_origin"],
            "cache": names["v2_test_cache_exact"],
            "database": names["v2_indexeddb"],
            "implementation": "synthetic-v2-reservation",
        },
    }
    for role in ("v1", "v2"):
        path = repo / RAW / f"{role}.json"
        if not path.is_file():
            raise ValueError(f"missing observation {path}")
        item = expected[role]
        record, identity = validate(
            path, role, item["origin"], item["cache"], item["database"], item["implementation"], identity
        )
        records.append(record)
    if records[0]["origin"] == records[1]["origin"]:
        raise ValueError("browser observations must use distinct origins")
    if records[0]["cache_names"][0] == records[1]["cache_names"][0]:
        raise ValueError("cache names must differ")
    if set(records[0]["database_names"]) & set(records[1]["database_names"]):
        raise ValueError("database names must not overlap")
    value = {
        "schema_version": "1",
        "baseline": {"ref": CURRENT_REF, "commit": CURRENT_COMMIT},
        "policy_sha256": policy["verification"]["output_sha256"],
        "browser_engine": identity,
        "captures": records,
        "proof": {
            "distinct_test_origins": True,
            "actual_frozen_v1_worker_observed": True,
            "independent_service_worker_scopes": True,
            "v1_sees_only_frozen_v1_cache": True,
            "v1_has_no_indexeddb": True,
            "v2_sees_only_reserved_v2_cache": True,
            "v2_sees_only_reserved_v2_indexeddb": True,
            "separate_origin_requires_no_v1_root_worker_patch": True,
        },
        "limitations": {
            "production_v2_shell": "pending P1-004",
            "public_proxy_port_8001": "pending P1-004",
            "physical_safari_ipad": "pending physical acceptance",
        },
        "note": "Chromium loopback observation exercises the actual frozen v1 worker and a synthetic V2 namespace reservation. It proves the selected origin-partitioning mechanism, not the future V2 shell or public proxy deployment.",
        "verification": {"output_sha256": None},
    }
    value["verification"]["output_sha256"] = sha256(canonical(value))
    return canonical(value)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    output = repo / OUTPUT
    try:
        generated = build(repo)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"coexistence observations unavailable or invalid: {exc}", file=sys.stderr)
        return 1
    if args.check:
        if not output.is_file() or output.read_bytes() != generated:
            print(f"{output}: generated summary differs", file=sys.stderr)
            return 1
        print(f"{output}: OK")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(generated)
    print(f"wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
