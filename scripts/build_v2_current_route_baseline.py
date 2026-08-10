#!/usr/bin/env python3
"""Build route evidence for the frozen Phase 1 current-content baseline."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT, EXPECTED_SETS, EXPECTED_SONGS, load_script


def configured(repo: Path):
    routes = load_script(repo, "build_v2_route_baseline.py", "v2_current_routes_base")
    routes.BASELINE_REF = CURRENT_REF
    routes.BASELINE_COMMIT = CURRENT_COMMIT
    routes.EXPECTED_SONG_COUNT = EXPECTED_SONGS
    routes.EXPECTED_SET_COUNT = EXPECTED_SETS
    routes.GENERATOR_NAME = "scripts/build_v2_current_route_baseline.py"
    routes.GENERATOR_COMMAND = "python3 scripts/build_v2_current_route_baseline.py"
    return routes


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    output = repo / CURRENT_ROOT / "routes/route-baseline.json"
    try:
        rendered = configured(repo).generate(repo).encode("utf-8")
    except Exception as exc:
        print(f"current route baseline generation failed: {exc}", file=sys.stderr)
        return 1
    if args.check:
        if not output.exists() or output.read_bytes() != rendered:
            print(f"{output}: generated output differs", file=sys.stderr)
            return 1
        print(f"{output}: OK")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.exists() or output.read_bytes() != rendered:
        output.write_bytes(rendered)
        print(f"wrote {output}")
    else:
        print(f"unchanged {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
