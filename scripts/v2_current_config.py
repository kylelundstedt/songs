"""Shared constants/helpers for the frozen Phase 1 current-content baseline."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

CURRENT_REF = "v2-phase1-content-2026-08-10"
CURRENT_COMMIT = "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5"
CURRENT_DATE = "2026-08-10"
EXPECTED_SONGS = 339
EXPECTED_SETS = 34
EXPECTED_DOCUMENTS = 373
EXPECTED_SOURCE_BYTES = 748_034
CURRENT_ROOT = Path("migration/v2/current")


def load_script(repo_root: Path, filename: str, module_name: str) -> ModuleType:
    path = repo_root / "scripts" / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
