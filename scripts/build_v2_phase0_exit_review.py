#!/usr/bin/env python3
"""Build the bounded current-main observation used by the Phase 0 exit review."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

REVIEW_COMMIT = "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5"
ROLLBACK_REF = "v1"
ROLLBACK_COMMIT = "546f59b41d9e9bcf0e81b543c27900a31e26c9e6"
DEFAULT_OUTPUT = Path("migration/v2/phase-0-exit-review.json")

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SCRIPT = ROOT / "scripts/build_v2_baseline.py"
SPEC = importlib.util.spec_from_file_location("build_v2_baseline", BASELINE_SCRIPT)
assert SPEC and SPEC.loader
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)

STATUS_RE = re.compile(r"^status:\s*[\"']?([^\n\"']*)", re.M)


def git(repo_root: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo_root), *args], text=True, stderr=subprocess.PIPE
    ).strip()


def render_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def add_output_hash(value: dict[str, Any]) -> str:
    value["verification"]["output_sha256"] = None
    pre_hash = render_json(value).encode("utf-8")
    value["verification"]["output_sha256"] = hashlib.sha256(pre_hash).hexdigest()
    return render_json(value)


def diff_summary(repo_root: Path) -> dict[str, Any]:
    names = git(repo_root, "diff", "--name-status", f"{ROLLBACK_REF}..{REVIEW_COMMIT}", "--", "songs", "sets")
    statuses = Counter(line.split("\t", 1)[0] for line in names.splitlines() if line)
    numstat = git(repo_root, "diff", "--numstat", f"{ROLLBACK_REF}..{REVIEW_COMMIT}", "--", "songs", "sets")
    added_lines = deleted_lines = 0
    for line in numstat.splitlines():
        added, deleted, _ = line.split("\t", 2)
        added_lines += int(added)
        deleted_lines += int(deleted)
    return {
        "commits_since_v1": int(git(repo_root, "rev-list", "--count", f"{ROLLBACK_REF}..{REVIEW_COMMIT}")),
        "files": {
            "added": statuses["A"],
            "deleted": statuses["D"],
            "modified": statuses["M"],
        },
        "lines": {"added": added_lines, "deleted": deleted_lines},
    }


def render_songs(source_root: Path) -> dict[str, Any]:
    version = subprocess.check_output(["apex", "--version"], text=True).splitlines()[0]
    songs = sorted((source_root / "songs").glob("*.md"))
    failures: list[dict[str, Any]] = []
    for path in songs:
        result = subprocess.run(
            [
                "apex", "--no-plugins", "--no-unsafe", "--aria",
                "--mode", "unified", "--to", "html", str(path),
            ],
            cwd=source_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode:
            failures.append({
                "path": path.relative_to(source_root).as_posix(),
                "returncode": result.returncode,
                "stderr": result.stderr,
            })
    return {
        "tool": version,
        "flags": ["--no-plugins", "--no-unsafe", "--aria", "--mode", "unified", "--to", "html"],
        "attempted": len(songs),
        "passed": len(songs) - len(failures),
        "failures": failures,
    }


def build(repo_root: Path) -> dict[str, Any]:
    if git(repo_root, "rev-parse", f"{ROLLBACK_REF}^{{commit}}") != ROLLBACK_COMMIT:
        raise RuntimeError("v1 rollback tag moved")
    if git(repo_root, "rev-parse", f"{REVIEW_COMMIT}^{{commit}}") != REVIEW_COMMIT:
        raise RuntimeError("review commit is unavailable")

    temporary, source_root = baseline.export_git_tree(repo_root, REVIEW_COMMIT)
    try:
        manifest = baseline.build_manifest(source_root, baseline_ref="current-main-observation", baseline_commit=REVIEW_COMMIT)
        records = manifest["records"]
        songs = [record for record in records if record["kind"] == "song"]
        sets = [record for record in records if record["kind"] == "set"]
        set_link_counts = Counter(
            link["classification"] for record in sets for link in record["links"]
        )
        status_counts = Counter()
        for path in sorted((source_root / "sets").glob("*.md")):
            match = STATUS_RE.search(path.read_text(encoding="utf-8"))
            status_counts[match.group(1).strip() if match else "(missing)"] += 1
        value: dict[str, Any] = {
            "schema_version": "1",
            "review": {
                "date": "2026-08-09",
                "source_commit": REVIEW_COMMIT,
                "source_tree": git(repo_root, "rev-parse", f"{REVIEW_COMMIT}^{{tree}}"),
                "source_subject": git(repo_root, "show", "-s", "--format=%s", REVIEW_COMMIT),
                "rollback_ref": ROLLBACK_REF,
                "rollback_commit": ROLLBACK_COMMIT,
            },
            "diff_from_v1": diff_summary(repo_root),
            "corpus": {
                "counts": manifest["corpus"]["counts"],
                "bytes": manifest["corpus"]["bytes"],
                "front_matter_ids": {
                    "songs": sum(record["front_matter_id"] is not None for record in songs),
                    "sets": sum(record["front_matter_id"] is not None for record in sets),
                },
                "set_link_classifications": dict(sorted(set_link_counts.items())),
                "set_statuses": dict(sorted(status_counts.items())),
            },
            "renderer": render_songs(source_root),
            "generator": {
                "name": "scripts/build_v2_phase0_exit_review.py",
                "version": "1",
                "command": "python3 scripts/build_v2_phase0_exit_review.py",
            },
            "verification": {"output_sha256": None},
        }
        return value
    finally:
        temporary.cleanup()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated output differs")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)

    output = (args.output or ROOT / DEFAULT_OUTPUT).resolve()
    expected = add_output_hash(build(ROOT)).encode("utf-8")
    if args.check:
        if not output.exists() or output.read_bytes() != expected:
            print(f"{output}: generated output differs", file=sys.stderr)
            return 1
        print(f"{output}: OK")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.exists() or output.read_bytes() != expected:
        output.write_bytes(expected)
        print(f"wrote {output}")
    else:
        print(f"unchanged {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
