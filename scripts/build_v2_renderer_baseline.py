#!/usr/bin/env python3
"""Build the deterministic renderer/source/asset portion of TASK-002.

Every input is read from a fresh archive of the pinned ``v1`` commit.  The
working-tree songs, sets, templates, and assets are never consulted.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

BASELINE_REF = "v1"
BASELINE_COMMIT = "546f59b41d9e9bcf0e81b543c27900a31e26c9e6"
SCHEMA_VERSION = "1"
GENERATOR_VERSION = "1"
DEFAULT_OUTPUT = Path("migration/v2/renderer/renderer-baseline.json")
FIXTURE_DIR = Path("migration/v2/renderer/html")
APEX_FLAGS = ("--no-plugins", "--no-unsafe", "--aria", "--mode", "unified", "--to", "html")
ASSET_PATHS = (
    "srv/static/app.js",
    "srv/static/icon.svg",
    "srv/static/manifest.webmanifest",
    "srv/static/style.css",
    "srv/static/sw.js",
    "srv/templates/live.html",
    "srv/templates/song.html",
)
VIEWPORT_PROFILES = (
    {"name": "ipad-portrait", "width": 1024, "height": 1366, "form_factor": "tablet"},
    {"name": "ipad-landscape", "width": 1366, "height": 1024, "form_factor": "tablet"},
    {"name": "phone", "width": 390, "height": 844, "form_factor": "phone"},
)
FEATURE_ORDER = (
    "h2",
    "h3",
    "no_section_headings",
    "column_break",
    "hard_break",
    "blockquote_or_annotation",
    "front_matter",
    "longest_source",
    "likely_dense",
)
FRONT_MATTER_RE = re.compile(r"\A---(?:\r\n|\n|\r)(.*?)(?:\r\n|\n|\r)---(?:\r\n|\n|\r|\Z)", re.S)
H2_RE = re.compile(r"^##(?!#)\s+", re.M)
H3_RE = re.compile(r"^###\s+", re.M)
BLOCKQUOTE_RE = re.compile(r"^\s*>\s?", re.M)
# Parenthesized/bracketed text is the corpus's annotation convention (for
# example, backing-vocal cues); standalone Markdown links are not counted.
ANNOTATION_RE = re.compile(r"(?<!\!)\([^\n()]+\)|(?<!\!)\[[^\n\]]+\](?!\()")
HARD_BREAK_RE = re.compile(r"(?: {2,}|\\)\r?$", re.M)
COLUMN_BREAK_RE = re.compile(r"^\s*<!--\s*column-break\s*-->\s*$", re.I | re.M)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def render_with_verification(value: dict[str, Any]) -> str:
    value["verification"]["output_sha256"] = None
    value["verification"]["output_sha256"] = sha256_bytes(canonical_json(value).encode("utf-8"))
    return canonical_json(value)


def verify_ref(repo_root: Path) -> None:
    actual = subprocess.check_output(
        ["git", "-C", str(repo_root), "rev-parse", f"{BASELINE_REF}^{{commit}}"], text=True
    ).strip()
    if actual != BASELINE_COMMIT:
        raise RuntimeError(f"{BASELINE_REF} resolves to {actual}, expected {BASELINE_COMMIT}")


def export_tag(repo_root: Path) -> tuple[tempfile.TemporaryDirectory[str], Path]:
    archive = subprocess.check_output(
        ["git", "-C", str(repo_root), "archive", "--format=tar", BASELINE_REF], stderr=subprocess.PIPE
    )
    temporary = tempfile.TemporaryDirectory(prefix="v2-renderer-baseline-")
    destination = Path(temporary.name)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise RuntimeError(f"unsafe path in git archive: {member.name}")
            if not name.parts:
                continue
            if member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError(f"non-regular archive entry: {member.name}")
            source = tar.extractfile(member)
            if source is None:
                raise RuntimeError(f"unable to read archive entry: {member.name}")
            target = destination.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())
    return temporary, destination


def normalize_version_output(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="strict").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def apex_identity() -> dict[str, str]:
    found = shutil.which("apex")
    if not found:
        raise RuntimeError("Apex executable not found on PATH")
    path = Path(found).resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise RuntimeError(f"Apex is not an executable file: {path}")
    version = subprocess.run([str(path), "--version"], capture_output=True, check=False)
    if version.returncode != 0:
        raise RuntimeError(f"apex --version failed with exit status {version.returncode}")
    return {
        "executable_path": str(path),
        "version_output": normalize_version_output(version.stdout + version.stderr),
        "sha256": sha256_bytes(path.read_bytes()),
    }


def split_front_matter(text: str) -> tuple[str, str]:
    """Return ``(front_matter, lead_sheet_body)`` without parsing YAML.

    Feature detection intentionally ignores front-matter contents for Markdown
    constructs: metadata values such as ``annotations: []`` are not lyric
    annotations.  The delimiters and their presence remain separately
    measurable through ``front_matter``.
    """
    match = FRONT_MATTER_RE.match(text)
    if not match:
        return "", text
    return match.group(0), text[match.end() :]


def detect_features(raw: bytes | str) -> dict[str, Any]:
    """Return measurable source features, with Markdown features from the body."""
    data = raw.encode("utf-8") if isinstance(raw, str) else raw
    text = data.decode("utf-8", errors="strict")
    _, body = split_front_matter(text)
    lines = text.splitlines()
    body_lines = body.splitlines()
    h2_count = len(H2_RE.findall(body))
    h3_count = len(H3_RE.findall(body))
    hard_break_count = len(HARD_BREAK_RE.findall(body))
    blockquote_count = len(BLOCKQUOTE_RE.findall(body))
    annotation_count = len(ANNOTATION_RE.findall(body))
    nonblank = [line for line in lines if line.strip()]
    body_nonblank = [line for line in body_lines if line.strip()]
    max_line_length = max((len(line) for line in lines), default=0)
    body_max_line_length = max((len(line) for line in body_lines), default=0)
    density_score = len(nonblank) * max_line_length
    body_density_score = len(body_nonblank) * body_max_line_length
    column_break_count = len(COLUMN_BREAK_RE.findall(body))
    return {
        "bytes": len(data),
        "lines": len(lines),
        "nonblank_lines": len(nonblank),
        "body_bytes": len(body.encode("utf-8")),
        "body_lines": len(body_lines),
        "body_nonblank_lines": len(body_nonblank),
        "h1_count": len(re.findall(r"^#(?!#)\s+", body, re.M)),
        "h2_count": h2_count,
        "h3_count": h3_count,
        "section_heading_count": h2_count + h3_count,
        "column_break_count": column_break_count,
        "hard_break_count": hard_break_count,
        "blockquote_count": blockquote_count,
        "annotation_count": annotation_count,
        "front_matter": bool(FRONT_MATTER_RE.match(text)),
        "max_line_length": max_line_length,
        "density_score": density_score,
        "body_max_line_length": body_max_line_length,
        "body_density_score": body_density_score,
        "h2": h2_count > 0,
        "h3": h3_count > 0,
        "no_section_headings": h2_count + h3_count == 0,
        "column_break": column_break_count > 0,
        "hard_break": hard_break_count > 0,
        "blockquote_or_annotation": blockquote_count > 0 or annotation_count > 0,
    }


def markdown_paths(source_root: Path) -> list[Path]:
    return sorted(
        (p for p in source_root.rglob("*.md") if p.is_file()),
        key=lambda p: p.relative_to(source_root).as_posix(),
    )


def source_entries(source_root: Path) -> list[dict[str, Any]]:
    entries = []
    for path in markdown_paths(source_root):
        raw = path.read_bytes()
        relative = path.relative_to(source_root).as_posix()
        entries.append({"path": relative, "raw": raw, "features": detect_features(raw)})
    return entries


def representative_coverage_gaps(entries: list[dict[str, Any]]) -> list[str]:
    """List requested features unavailable in the tagged-song corpus."""
    songs = [entry for entry in entries if entry["path"].startswith("songs/")]
    gaps = []
    for feature in FEATURE_ORDER:
        available = any(entry["features"].get(feature, False) for entry in songs)
        if feature in ("longest_source", "likely_dense"):
            available = bool(songs)
        if not available:
            gaps.append(feature)
    return gaps


def select_representatives(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Select deterministic representative lead sheets from tagged songs only."""
    songs = [entry for entry in entries if entry["path"].startswith("songs/")]
    selected: dict[str, dict[str, Any]] = {}
    for feature in FEATURE_ORDER[:7]:
        candidates = [entry for entry in songs if entry["features"].get(feature)]
        if candidates:
            chosen = min(candidates, key=lambda entry: entry["path"])
            selected.setdefault(chosen["path"], {"entry": chosen, "reasons": []})["reasons"].append(feature)
    if songs:
        chosen = max(songs, key=lambda entry: (entry["features"]["bytes"], -len(entry["path"]), entry["path"]))
        selected.setdefault(chosen["path"], {"entry": chosen, "reasons": []})["reasons"].append("longest_source")
        chosen = max(
            songs,
            key=lambda entry: (
                entry["features"]["body_density_score"],
                entry["features"]["body_bytes"],
                entry["path"],
            ),
        )
        selected.setdefault(chosen["path"], {"entry": chosen, "reasons": []})["reasons"].append("likely_dense")
    return [
        {
            "path": path,
            "kind": "song",
            "source_sha256": sha256_bytes(selected[path]["entry"]["raw"]),
            "source_bytes": len(selected[path]["entry"]["raw"]),
            "features": selected[path]["entry"]["features"],
            "selection_reasons": sorted(set(selected[path]["reasons"])),
        }
        for path in sorted(selected)
    ]


def parse_fitter_constants(app_text: str) -> dict[str, Any]:
    def integer(name: str) -> int:
        match = re.search(rf"const\s+{name}\s*=\s*(\d+)", app_text)
        if not match:
            raise RuntimeError(f"unable to find v1 fitter constant {name}")
        return int(match.group(1))

    line_match = re.search(r"for\s*\(const\s+line\s+of\s+\[([^]]+)\]", app_text)
    if not line_match:
        raise RuntimeError("unable to find v1 fitter line-height candidates")
    line_heights = [float(value.strip()) for value in line_match.group(1).split(",")]
    return {
        "min_px": integer("MIN_PX"),
        "preferred_px": integer("PREFERRED_PX"),
        "manual_min_px": integer("MANUAL_MIN_PX"),
        "manual_max_px": integer("MANUAL_MAX_PX"),
        "line_height_candidates": line_heights,
        "phone": {"font_px": 20, "line_height": 1.24, "columns": 1, "outcome": "scrollable"},
        "tablet": {"columns": 2, "font_range_px": [16, 21], "failure_font_px": 16, "failure_line_height": 1.12},
    }


def asset_records(source_root: Path) -> list[dict[str, Any]]:
    records = []
    for relative in sorted(ASSET_PATHS):
        path = source_root / relative
        if not path.is_file():
            raise RuntimeError(f"tagged asset missing: {relative}")
        raw = path.read_bytes()
        records.append({"path": relative, "sha256": sha256_bytes(raw), "bytes": len(raw)})
    return records


def render_one(apex_path: str, source_root: Path, relative: str) -> bytes:
    path = source_root / relative
    result = subprocess.run(
        [apex_path, *APEX_FLAGS, str(path)], cwd=source_root, capture_output=True, check=False
    )
    if result.returncode != 0:
        detail = (result.stdout + result.stderr).decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Apex failed for {relative} (exit {result.returncode}): {detail}")
    try:
        result.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError(f"Apex produced non-UTF-8 output for {relative}") from exc
    return result.stdout


def fixture_name(relative: str) -> str:
    return relative.replace("/", "--").removesuffix(".md") + ".html"


def generate(repo_root: Path) -> tuple[str, dict[str, bytes], dict[str, Any]]:
    verify_ref(repo_root)
    apex = apex_identity()
    temporary, source_root = export_tag(repo_root)
    try:
        entries = source_entries(source_root)
        songs = [entry for entry in entries if entry["path"].startswith("songs/")]
        if len(songs) != 291:
            raise RuntimeError(f"expected 291 tagged songs, found {len(songs)}")
        renders = []
        for entry in songs:
            html = render_one(apex["executable_path"], source_root, entry["path"])
            renders.append({
                "path": entry["path"],
                "source_sha256": sha256_bytes(entry["raw"]),
                "source_bytes": len(entry["raw"]),
                "rendered_html_sha256": sha256_bytes(html),
                "rendered_html_bytes": len(html),
                "success": True,
                "error": None,
            })

        selected = select_representatives(entries)
        fixtures: dict[str, bytes] = {}
        for item in selected:
            html = render_one(apex["executable_path"], source_root, item["path"])
            item["fixture"] = f"html/{fixture_name(item['path'])}"
            item["rendered_html_sha256"] = sha256_bytes(html)
            item["rendered_html_bytes"] = len(html)
            fixtures[item["fixture"]] = html

        app_text = (source_root / "srv/static/app.js").read_text(encoding="utf-8")
        style_text = (source_root / "srv/static/style.css").read_text(encoding="utf-8")
        font_families = sorted(set(re.findall(r"font-family:\s*([^;]+)", style_text)))
        server_bytes = (source_root / "srv/server.go").read_bytes()
        artifact: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "baseline": {"ref": BASELINE_REF, "commit": BASELINE_COMMIT},
            "generator": {
                "name": "scripts/build_v2_renderer_baseline.py",
                "version": GENERATOR_VERSION,
                "command": "python3 scripts/build_v2_renderer_baseline.py",
            },
            "apex": {**apex, "flags": list(APEX_FLAGS)},
            "renderer": {
                "command_template": ["apex", *APEX_FLAGS, "<tagged-song-markdown-path>"],
                "working_directory": "fresh git archive root",
                "input_encoding": "UTF-8",
                "output_encoding": "UTF-8",
                "error_policy": "fail on nonzero exit or non-UTF-8 output",
            },
            "renderer_implementation": {
                "path": "srv/server.go",
                "sha256": sha256_bytes(server_bytes),
                "bytes": len(server_bytes),
            },
            "presentation_inputs": {
                "css_path": "srv/static/style.css",
                "font_families": font_families,
                "templates": ["srv/templates/song.html", "srv/templates/live.html"],
            },
            "assets": asset_records(source_root),
            "fitter": {
                "constants": parse_fitter_constants(app_text),
                "viewport_profiles": list(VIEWPORT_PROFILES),
                "browser_fit": {
                    "status": "recorded-separate-artifact",
                    "artifact": "migration/v2/renderer/browser-fit-summary.json",
                    "profiles": [{"name": p["name"], "status": "recorded"} for p in VIEWPORT_PROFILES],
                },
                "physical_ipad": {"status": "pending", "note": "Browser emulation is not physical-iPad validation."},
            },
            "corpus": {
                "song_count": len(songs),
                "render_count": len(renders),
                "success_count": sum(1 for record in renders if record["success"]),
                "failure_count": sum(1 for record in renders if not record["success"]),
                "renders": renders,
            },
            "representatives": selected,
            "representative_coverage_gaps": representative_coverage_gaps(entries),
            "verification": {"record_count": len(renders), "output_sha256": None},
        }
        return render_with_verification(artifact), fixtures, artifact
    finally:
        temporary.cleanup()


def write_or_check(repo_root: Path, output: Path, check: bool) -> int:
    rendered, fixtures, _ = generate(repo_root)
    expected = rendered.encode("utf-8")
    mismatches = []
    if not output.exists() or output.read_bytes() != expected:
        mismatches.append(str(output))
    fixture_root = output.parent / "html"
    expected_names = set(fixtures)
    actual_names = {f"html/{path.name}" for path in fixture_root.glob("*.html")} if fixture_root.is_dir() else set()
    for name, data in fixtures.items():
        path = output.parent / name
        if not path.exists() or path.read_bytes() != data:
            mismatches.append(str(path))
    mismatches.extend(str(fixture_root / name.removeprefix("html/")) for name in sorted(actual_names - expected_names))
    if check:
        if mismatches:
            print("generated renderer baseline differs:", file=sys.stderr)
            for mismatch in mismatches:
                print(f"  {mismatch}", file=sys.stderr)
            return 1
        print(f"{output}: OK ({len(fixtures)} fixtures)")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    fixture_root.mkdir(parents=True, exist_ok=True)
    # Remove only stale regular HTML files directly under the expected fixture
    # directory; never recurse or follow links outside the artifact directory.
    for stale in fixture_root.glob("*.html"):
        if (stale.is_file() or stale.is_symlink()) and f"html/{stale.name}" not in expected_names:
            stale.unlink()
    if not output.exists() or output.read_bytes() != expected:
        output.write_bytes(expected)
    for name, data in fixtures.items():
        path = output.parent / name
        if not path.exists() or path.read_bytes() != data:
            path.write_bytes(data)
    print(f"wrote {output} and {len(fixtures)} fixtures")
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated artifacts differ")
    parser.add_argument("--output", type=Path, default=None, help="JSON output path")
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parents[1]
    output = (args.output or repo_root / DEFAULT_OUTPUT).resolve()
    return write_or_check(repo_root, output, args.check)


if __name__ == "__main__":
    raise SystemExit(main())
