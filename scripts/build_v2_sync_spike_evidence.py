#!/usr/bin/env python3
"""Run the disposable Go TASK-005 sync proof and freeze its deterministic evidence."""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = Path("migration/v2/sync-spike/sync-spike-evidence.json")
FORBIDDEN = (b"/home/", b"/tmp/", b"localhost", b"127.0.0.1", b"://", b"@")
TIMESTAMP = re.compile(rb"\b20\d{2}-\d{2}-\d{2}T\d{2}:")

def generate(repo_root: Path = ROOT) -> bytes:
    completed = subprocess.run(["go", "run", "./cmd/syncspike-evidence"], cwd=repo_root, check=True, capture_output=True)
    value = json.loads(completed.stdout)
    if value["schema_version"] != "1.0" or not value["recommendation"]["feasible"]:
        raise RuntimeError("sync spike did not produce a feasible schema 1.0 result")
    if any(token in completed.stdout for token in FORBIDDEN) or TIMESTAMP.search(completed.stdout):
        raise RuntimeError("evidence contains a path, host, identity address, or timestamp")
    return completed.stdout

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if checked-in deterministic evidence differs")
    args = parser.parse_args()
    generated = generate()
    destination = ROOT / DEFAULT_OUTPUT
    if args.check:
        if not destination.exists() or destination.read_bytes() != generated:
            print(f"{DEFAULT_OUTPUT} is stale; run {Path(__file__).name}", file=sys.stderr)
            return 1
        return 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(generated)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
