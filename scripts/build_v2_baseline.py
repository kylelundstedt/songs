#!/usr/bin/env python3
"""Build the immutable v1 Markdown corpus manifest.

The default input is a fresh ``git archive v1`` export.  In particular, this
script never reads ``songs/`` or ``sets/`` from the mutable worktree.  The
``--source-root`` option exists for tests and for inspecting an already-created
archive export; callers must provide an exported tree, not a working tree.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import posixpath
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit

BASELINE_REF = "v1"
BASELINE_COMMIT = "546f59b41d9e9bcf0e81b543c27900a31e26c9e6"
SCHEMA_VERSION = "1"
GENERATOR_VERSION = "1"
DEFAULT_OUTPUT = Path("migration/v2/v1-corpus-manifest.json")

FRONT_MATTER_RE = re.compile(r"\A---(?:\r\n|\n|\r)(.*?)(?:\r\n|\n|\r)---(?:\r\n|\n|\r|\Z)", re.S)
FRONT_MATTER_LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$")
H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.M)
LINK_START_RE = re.compile(r"(?<!!)(?<!\\)\[([^\n\]]*)\]\(")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def classify_newlines(data: bytes) -> str:
    """Return a stable description of the line-ending bytes in *data*."""
    styles: set[str] = set()
    index = 0
    while index < len(data):
        if data[index:index + 2] == b"\r\n":
            styles.add("CRLF")
            index += 2
        elif data[index:index + 1] == b"\r":
            styles.add("CR")
            index += 1
        elif data[index:index + 1] == b"\n":
            styles.add("LF")
            index += 1
        else:
            index += 1
    if not styles:
        return "none"
    return next(iter(styles)) if len(styles) == 1 else "mixed"


def parse_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, str) else str(parsed)
        except json.JSONDecodeError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def extract_metadata(text: str, fallback_title: str) -> tuple[str, str | None]:
    """Extract the first H1 title and a scalar front-matter ``id``."""
    front_matter_id: str | None = None
    match = FRONT_MATTER_RE.match(text)
    if match:
        for line in match.group(1).splitlines():
            field = FRONT_MATTER_LINE_RE.match(line)
            if field and field.group(1) == "id":
                front_matter_id = parse_scalar(field.group(2))
                break
    title_match = H1_RE.search(text[match.end():] if match else text)
    title = title_match.group(1).strip() if title_match else fallback_title
    return title, front_matter_id


def _link_target_end(text: str, start: int) -> int | None:
    """Find a Markdown destination's closing paren, allowing nested parens."""
    depth = 0
    escaped = False
    in_angle = False
    for index in range(start, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "<" and depth == 0:
            in_angle = True
        elif char == ">" and in_angle:
            in_angle = False
        elif not in_angle and char == "(":
            depth += 1
        elif not in_angle and char == ")":
            if depth == 0:
                return index
            depth -= 1
    return None


def markdown_links(text: str) -> list[tuple[str, str]]:
    """Extract inline Markdown links as (label, exact destination) pairs."""
    links: list[tuple[str, str]] = []
    for match in LINK_START_RE.finditer(text):
        end = _link_target_end(text, match.end())
        if end is None:
            continue
        target = text[match.end():end]
        links.append((match.group(1), target))
    return links


def classify_link(source_path: str, target: str, canonical_paths: set[str]) -> tuple[str, str | None]:
    """Classify one exact Markdown destination and return an optional path."""
    classification_target = target.strip()
    if classification_target.startswith("<") and classification_target.endswith(">"):
        classification_target = classification_target[1:-1]
    if classification_target.startswith("#"):
        return "anchor", None
    if classification_target.startswith("unresolved:"):
        return "unresolved: reference", None
    parsed = urlsplit(classification_target)
    if parsed.scheme or classification_target.startswith("//"):
        return "external URL", None

    relative_target = parsed.path
    if not relative_target:
        return "missing", None
    source_parent = posixpath.dirname(source_path)
    resolved = posixpath.normpath(posixpath.join(source_parent, unquote(relative_target)))
    if resolved in canonical_paths:
        return "resolved canonical file", resolved
    return "missing", None


def build_links(source_path: str, text: str, canonical_paths: set[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for label, target in markdown_links(text):
        classification, resolved_path = classify_link(source_path, target, canonical_paths)
        link: dict[str, Any] = {
            "label": label,
            "target": target,
            "classification": classification,
        }
        if resolved_path is not None:
            link["resolved_path"] = resolved_path
        result.append(link)
    return result


def markdown_paths(source_root: Path) -> list[Path]:
    paths: list[Path] = []
    for directory in ("songs", "sets"):
        root = source_root / directory
        if root.is_dir():
            paths.extend(path for path in root.rglob("*.md") if path.is_file())
    return sorted(paths, key=lambda path: path.relative_to(source_root).as_posix())


def build_manifest(source_root: Path, baseline_ref: str = BASELINE_REF, baseline_commit: str = BASELINE_COMMIT) -> dict[str, Any]:
    paths = markdown_paths(source_root)
    relative_paths = [path.relative_to(source_root).as_posix() for path in paths]
    canonical_paths = set(relative_paths)
    records: list[dict[str, Any]] = []
    for path, relative in zip(paths, relative_paths):
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        title, front_matter_id = extract_metadata(text, Path(relative).stem)
        kind = "song" if relative.startswith("songs/") else "set"
        record: dict[str, Any] = {
            "kind": kind,
            "path": relative,
            "sha256": sha256_bytes(raw),
            "bytes": len(raw),
            "newline_style": classify_newlines(raw),
            "title": title,
            "front_matter_id": front_matter_id,
            "legacy_slug": Path(relative).stem,
            "links": build_links(relative, text, canonical_paths),
            "rendered_fixture_refs": [],
        }
        records.append(record)

    song_records = [record for record in records if record["kind"] == "song"]
    set_records = [record for record in records if record["kind"] == "set"]
    total_bytes = sum(record["bytes"] for record in records)
    return {
        "schema_version": SCHEMA_VERSION,
        "baseline": {"ref": baseline_ref, "commit": baseline_commit},
        "corpus": {
            "counts": {"files": len(records), "songs": len(song_records), "sets": len(set_records)},
            "bytes": {
                "total": total_bytes,
                "songs": sum(record["bytes"] for record in song_records),
                "sets": sum(record["bytes"] for record in set_records),
            },
        },
        "generator": {
            "name": "scripts/build_v2_baseline.py",
            "version": GENERATOR_VERSION,
            "command": "python3 scripts/build_v2_baseline.py",
        },
        "verification": {
            "record_count": len(records),
            "output_sha256": None,
        },
        "records": records,
    }


def render_json(manifest: dict[str, Any]) -> str:
    """Render canonical JSON: UTF-8, two spaces, fixed insertion order, LF."""
    return json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


def render_with_verification(manifest: dict[str, Any]) -> str:
    """Render and add a non-circular hash of the canonical pre-hash document."""
    manifest["verification"]["output_sha256"] = None
    pre_hash = render_json(manifest).encode("utf-8")
    manifest["verification"]["output_sha256"] = sha256_bytes(pre_hash)
    return render_json(manifest)


def export_git_tree(repo_root: Path, ref: str) -> tuple[tempfile.TemporaryDirectory[str], Path]:
    archive = subprocess.check_output(
        ["git", "-C", str(repo_root), "archive", "--format=tar", ref], stderr=subprocess.PIPE
    )
    temporary = tempfile.TemporaryDirectory(prefix="v2-baseline-")
    destination = Path(temporary.name)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for member in tar.getmembers():
            member_path = PurePosixPath(member.name)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise RuntimeError(f"unsafe path in git archive: {member.name}")
            if not member_path.parts or member_path.parts[0] not in {"songs", "sets"}:
                continue
            if member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError(f"non-regular corpus entry in git archive: {member.name}")
            source = tar.extractfile(member)
            if source is None:
                raise RuntimeError(f"unable to read git archive entry: {member.name}")
            target = destination.joinpath(*member_path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())
    return temporary, destination


def verify_ref(repo_root: Path, ref: str, expected_commit: str) -> None:
    actual = subprocess.check_output(
        ["git", "-C", str(repo_root), "rev-parse", f"{ref}^{{commit}}"], text=True, stderr=subprocess.PIPE
    ).strip()
    if actual != expected_commit:
        raise RuntimeError(f"{ref} resolves to {actual}, expected {expected_commit}")


def generate(repo_root: Path, source_root: Path | None = None) -> str:
    temporary: tempfile.TemporaryDirectory[str] | None = None
    try:
        if source_root is None:
            verify_ref(repo_root, BASELINE_REF, BASELINE_COMMIT)
            temporary, source_root = export_git_tree(repo_root, BASELINE_REF)
        manifest = build_manifest(source_root)
        return render_with_verification(manifest)
    finally:
        if temporary is not None:
            temporary.cleanup()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the generated output differs")
    parser.add_argument("--output", type=Path, default=None, help="manifest path (defaults to migration/v2/v1-corpus-manifest.json)")
    parser.add_argument("--source-root", type=Path, default=None, help="already-exported tree; intended for tests")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    output = (args.output or repo_root / DEFAULT_OUTPUT).resolve()
    source_root = args.source_root.resolve() if args.source_root else None
    rendered = generate(repo_root, source_root)
    expected = rendered.encode("utf-8")
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
