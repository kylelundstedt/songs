#!/usr/bin/env python3
"""Validate browser-fit captures for the frozen current-content baseline."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT, EXPECTED_SONGS, load_script


def configured(repo: Path):
    fit = load_script(repo, "build_v2_browser_fit_baseline.py", "v2_current_fit_summary_base")
    fit.BASELINE_REF = CURRENT_REF
    fit.BASELINE_COMMIT = CURRENT_COMMIT
    fit.EXPECTED_SONG_COUNT = EXPECTED_SONGS
    fit.BIND_SCREENSHOT_METRICS = True
    fit.EXPECTED_FAILURES = {
        "ipad-portrait": [],
        "ipad-landscape": ["can-t-stop", "father-of-mine", "love-shack", "paradise-city", "troublemaker"],
        "phone": [],
    }
    fit.EXPECTED_SCREENSHOTS = (
        ("ipad-portrait", "father-of-mine", "ipad-portrait-father-of-mine.png", "fit", 21, 1.16, 2),
        ("ipad-landscape", "father-of-mine", "ipad-landscape-father-of-mine-needs-editing.png", "needs-editing", 16, 1.12, 2),
        ("phone", "1979", "phone-1979-scrollable.png", "scrollable", 20, 1.24, 1),
    )
    fit.GENERATOR_NAME = "scripts/build_v2_current_browser_fit_baseline.py"
    fit.GENERATOR_COMMAND = "python3 scripts/build_v2_current_browser_fit_baseline.py"
    fit.SCREENSHOT_MEASUREMENT_SURFACE = "frozen current /song/{id} route after DOMContentLoaded fitAll"
    return fit


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    root = repo / CURRENT_ROOT / "renderer"
    output = root / "browser-fit-summary.json"
    try:
        rendered = configured(repo).build(repo, root / "renderer-baseline.json", root / "browser-fit", root / "screenshots").encode("utf-8")
    except ValueError as exc:
        print(f"current browser-fit captures unavailable or invalid: {exc}", file=sys.stderr)
        return 1
    if args.check:
        if not output.is_file() or output.read_bytes() != rendered:
            print(f"{output}: generated summary differs", file=sys.stderr)
            return 1
        print(f"{output}: OK")
        return 0
    output.write_bytes(rendered)
    print(f"wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
