#!/usr/bin/env python3
"""Build renderer evidence for the frozen Phase 1 current-content baseline."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT, EXPECTED_SONGS, load_script


def configured(repo: Path):
    renderer = load_script(repo, "build_v2_renderer_baseline.py", "v2_current_renderer_base")
    renderer.BASELINE_REF = CURRENT_REF
    renderer.BASELINE_COMMIT = CURRENT_COMMIT
    renderer.EXPECTED_SONG_COUNT = EXPECTED_SONGS
    renderer.RECORD_APEX_EXECUTABLE_PATH = False
    renderer.GENERATOR_NAME = "scripts/build_v2_current_renderer_baseline.py"
    renderer.GENERATOR_COMMAND = "python3 scripts/build_v2_current_renderer_baseline.py"
    renderer.BROWSER_FIT_ARTIFACT = "migration/v2/current/renderer/browser-fit-summary.json"
    return renderer


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    output = repo / CURRENT_ROOT / "renderer/renderer-baseline.json"
    return configured(repo).write_or_check(repo, output, args.check)


if __name__ == "__main__":
    raise SystemExit(main())
