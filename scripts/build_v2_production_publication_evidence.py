#!/usr/bin/env python3
"""Run TASK-018's disposable publication proof and freeze canonical evidence."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = Path(
    "migration/v2/production-publication/production-publication-evidence.json"
)
TIMESTAMP = re.compile(r"\b20\d{2}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d|\b)")
ABSOLUTE_PATH = re.compile(r"(?:^|[\s\"'])/(?:home|tmp|var|private|Users)/")
HOST_OR_ADDRESS = re.compile(
    r"(?:localhost|127\.0\.0\.1|\[?::1\]?|https?://|"
    r"\b(?:[a-z0-9-]+\.)+(?:com|net|org|dev|test|invalid|local)\b)",
    re.IGNORECASE,
)
EMAIL = re.compile(r"\b[^\s@]+@[^\s@]+\b")
LONG_HEX = re.compile(r"\b[a-f0-9]{32,64}\b", re.IGNORECASE)
PROHIBITED_KEY = re.compile(
    r"(?:^|_)(?:token|hash|fingerprint|secret|credential|email|hostname|"
    r"timestamp|date|source|payload|body)(?:$|_)",
    re.IGNORECASE,
)


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def reject_prohibited_fields(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if PROHIBITED_KEY.search(key):
                raise RuntimeError(f"evidence contains prohibited field at {path}.{key}")
            reject_prohibited_fields(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_prohibited_fields(child, f"{path}[{index}]")


def generate(repo_root: Path = ROOT) -> bytes:
    completed = subprocess.run(
        ["go", "run", "./cmd/v2publication-evidence"],
        cwd=repo_root,
        check=True,
        capture_output=True,
    )
    value = json.loads(completed.stdout)
    if value.get("schema_version") != "1.0" or value.get("task") != "TASK-018":
        raise RuntimeError("production-publication runner returned the wrong evidence schema")
    if value.get("acceptance", {}).get("all_passed") is not True:
        raise RuntimeError("production-publication runner did not pass all assertions")
    reject_prohibited_fields(value)
    rendered = canonical(value)
    if completed.stdout != rendered:
        raise RuntimeError("runner output is not canonical two-space JSON with one final LF")
    text = rendered.decode("utf-8")
    for pattern, label in (
        (TIMESTAMP, "date or timestamp"),
        (ABSOLUTE_PATH, "temporary or machine path"),
        (HOST_OR_ADDRESS, "hostname or network address"),
        (EMAIL, "email address"),
        (LONG_HEX, "token, digest, or fingerprint value"),
    ):
        if pattern.search(text):
            raise RuntimeError(f"evidence contains a {label}")
    return rendered


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if checked-in deterministic evidence differs",
    )
    args = parser.parse_args()
    generated = generate()
    destination = ROOT / DEFAULT_OUTPUT
    if args.check:
        if not destination.exists() or destination.read_bytes() != generated:
            print(
                f"{DEFAULT_OUTPUT} is stale; run {Path(__file__).name}",
                file=sys.stderr,
            )
            return 1
        return 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(generated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
