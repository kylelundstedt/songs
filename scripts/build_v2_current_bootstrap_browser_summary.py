#!/usr/bin/env python3
"""Validate Chromium bootstrap observations for the frozen current baseline."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable

from v2_current_config import (
    CURRENT_COMMIT,
    CURRENT_REF,
    CURRENT_ROOT,
    EXPECTED_DOCUMENTS,
    EXPECTED_SOURCE_BYTES,
    load_script,
)


def configured(repo: Path):
    summary = load_script(repo, "build_v2_bootstrap_browser_summary.py", "v2_current_bootstrap_summary_base")
    summary.BASELINE_REF = CURRENT_REF
    summary.BASELINE_COMMIT = CURRENT_COMMIT
    summary.DOCUMENTS = EXPECTED_DOCUMENTS
    summary.SOURCE_BYTES = EXPECTED_SOURCE_BYTES
    summary.BASELINE = CURRENT_ROOT / "bootstrap/bootstrap-baseline.json"
    summary.REQUIRE_EVIDENCE_BINDING = True
    return summary


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    raw = repo / CURRENT_ROOT / "bootstrap/browser-observations"
    output = repo / CURRENT_ROOT / "bootstrap/browser-summary.json"
    try:
        generated = configured(repo).build(repo, raw)
    except ValueError as exc:
        print(f"current browser observations unavailable or invalid: {exc}", file=sys.stderr)
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
