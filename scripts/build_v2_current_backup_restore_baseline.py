#!/usr/bin/env python3
"""Run the recovery drill for the frozen Phase 1 current-content baseline."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT, load_script


def configured(repo: Path):
    recovery = load_script(repo, "build_v2_backup_restore_baseline.py", "v2_current_recovery_base")
    recovery.BASELINE_REF = CURRENT_REF
    recovery.BASELINE_COMMIT = CURRENT_COMMIT
    recovery.BUNDLE_REF = f"refs/tags/{CURRENT_REF}"
    recovery.CORPUS_PATH = CURRENT_ROOT / "corpus-manifest.json"
    recovery.RENDERER_PATH = CURRENT_ROOT / "renderer/renderer-baseline.json"
    recovery.ROUTE_PATH = CURRENT_ROOT / "routes/route-baseline.json"
    recovery.GENERATOR_NAME = "scripts/build_v2_current_backup_restore_baseline.py"
    recovery.GENERATOR_COMMAND = "python3 scripts/build_v2_current_backup_restore_baseline.py"
    return recovery


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    output = repo / CURRENT_ROOT / "backup-restore/backup-restore-baseline.json"
    try:
        rendered = configured(repo).generate(repo).encode("utf-8")
    except Exception as exc:
        print(f"current backup/restore baseline generation failed: {exc}", file=sys.stderr)
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
