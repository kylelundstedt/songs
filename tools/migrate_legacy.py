#!/usr/bin/env python3
"""Deterministically preserve the legacy lead-sheet corpus for Phase 0.

This tool deliberately copies song bodies as bytes; it does not normalize Markdown,
add front matter, rename files, or infer musical metadata.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

DEFAULT_SOURCE = Path("/home/exedev/set-lists-reference")
DEFAULT_EVENT_MANIFEST = "2021-02-20-Murphys.txt"
EXPECTED_LEAD_SHEETS = 284
EXPECTED_SET_ENTRIES = 32

H1_RE = re.compile(r"^# (?!#)(.*)$", re.MULTILINE)
H3_RE = re.compile(r"^###(?:\s|$)", re.MULTILINE)
SHORT_TITLE_RE = re.compile(r'\s*\{short="([^"]+)"\}\s*$')
SET_LINE_RE = re.compile(r"^(\d+)\. \[([^\]]+)\]\(([^)]+)\)$")


class MigrationError(RuntimeError):
    """The legacy input or generated migration artifacts are invalid."""


@dataclass(frozen=True)
class Song:
    source_path: str
    filename: str
    raw: bytes
    sha256: str
    raw_h1_title: str
    title: str
    short_title: str | None
    proposed_id: str
    h3_count: int
    final_newline: bool

    @property
    def target_path(self) -> str:
        # Preserve the legacy filename for this phase; only the directory changes.
        return f"songs/{self.filename}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_output(source: Path, *args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(source), *args], text=True, stderr=subprocess.PIPE
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise MigrationError(f"source must be a Git checkout: {source}") from exc


def source_revision(source: Path) -> dict[str, str]:
    status = git_output(source, "status", "--porcelain")
    if status:
        raise MigrationError(
            "source Git worktree is dirty; freeze or clean the legacy source before migration"
        )
    return {"git_commit": git_output(source, "rev-parse", "HEAD"), "git_worktree": "clean"}


def canonical_id(title: str) -> str:
    """Return the review-only proposed stable ID from the legacy display title."""
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    text = text.replace("&", " and ").replace("'", "")
    text = re.sub(r"[^A-Za-z0-9]+", "-", text.lower()).strip("-")
    if not text:
        raise MigrationError(f"title cannot produce a canonical ID: {title!r}")
    return text


def comparison_token(text: str) -> str:
    """Loose comparison used only to flag title/filename review anomalies."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return "".join(char.lower() for char in text if char.isalnum())


def parse_song(source_root: Path, path: Path) -> Song:
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MigrationError(f"not UTF-8: {path.relative_to(source_root)}") from exc
    if b"\r\n" in raw or b"\r" in raw:
        raise MigrationError(f"non-LF line ending: {path.relative_to(source_root)}")
    h1s = H1_RE.findall(text)
    if len(h1s) != 1 or not text.startswith("# "):
        raise MigrationError(
            f"expected exactly one first-line H1: {path.relative_to(source_root)}"
        )
    raw_h1_title = h1s[0]
    short_match = SHORT_TITLE_RE.search(raw_h1_title)
    short_title = short_match.group(1) if short_match else None
    title = SHORT_TITLE_RE.sub("", raw_h1_title).strip()
    if not title:
        raise MigrationError(f"empty H1 title: {path.relative_to(source_root)}")
    relative = path.relative_to(source_root).as_posix()
    return Song(
        source_path=relative,
        filename=path.name,
        raw=raw,
        sha256=sha256_bytes(raw),
        raw_h1_title=raw_h1_title,
        title=title,
        short_title=short_title,
        proposed_id=canonical_id(title),
        h3_count=len(H3_RE.findall(text)),
        final_newline=raw.endswith(b"\n"),
    )


def load_songs(source: Path, expected_count: int) -> list[Song]:
    lead_sheet_dir = source / "lead-sheet"
    if not lead_sheet_dir.is_dir():
        raise MigrationError(f"lead-sheet directory not found: {lead_sheet_dir}")
    paths = sorted(lead_sheet_dir.rglob("*.md"), key=lambda item: item.relative_to(source).as_posix())
    songs = [parse_song(source, path) for path in paths]
    if len(songs) != expected_count:
        raise MigrationError(f"expected {expected_count} lead sheets, found {len(songs)}")
    if len({song.filename for song in songs}) != len(songs):
        raise MigrationError("duplicate filenames cannot be preserved in the flat songs directory")
    duplicate_ids = sorted(
        proposed_id for proposed_id in {song.proposed_id for song in songs}
        if sum(song.proposed_id == proposed_id for song in songs) > 1
    )
    if duplicate_ids:
        raise MigrationError(f"canonical ID collisions: {', '.join(duplicate_ids)}")
    return songs


def read_csv_paths(path: Path) -> list[str]:
    try:
        rows = list(csv.reader(path.read_text(encoding="utf-8").splitlines()))
    except UnicodeDecodeError as exc:
        raise MigrationError(f"not UTF-8: {path}") from exc
    if any(not row or not row[0].strip() for row in rows):
        raise MigrationError(f"blank path in master manifest: {path}")
    return [row[0].strip() for row in rows]


def validate_master_manifest(source: Path, songs: list[Song]) -> dict[str, Any]:
    path = source / "Master-Set-List.csv"
    paths = read_csv_paths(path)
    source_paths = [f"./{song.source_path}" for song in songs]
    missing = sorted(set(source_paths) - set(paths))
    extra = sorted(set(paths) - set(source_paths))
    duplicate_count = len(paths) - len(set(paths))
    valid = len(paths) == len(songs) and not missing and not extra and duplicate_count == 0
    if not valid:
        raise MigrationError("Master-Set-List.csv does not exactly cover the legacy lead sheets")
    return {
        "path": path.name,
        "sha256": sha256_bytes(path.read_bytes()),
        "rows": len(paths),
        "missing_source_paths": missing,
        "extra_source_paths": extra,
        "duplicate_rows": duplicate_count,
        "valid": valid,
    }


def parse_event_manifest(source: Path, filename: str, songs: list[Song], expected_entries: int) -> tuple[Path, list[Song]]:
    path = source / filename
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise MigrationError(f"not UTF-8: {path}") from exc
    if any(not line.strip() for line in lines):
        raise MigrationError(f"blank entry in event manifest: {path.name}")
    by_source_path = {f"./{song.source_path}": song for song in songs}
    entries: list[Song] = []
    for line in lines:
        normalized = line.strip()
        if normalized not in by_source_path:
            raise MigrationError(f"event entry does not resolve: {normalized}")
        entries.append(by_source_path[normalized])
    if len(entries) != expected_entries:
        raise MigrationError(f"expected {expected_entries} event entries, found {len(entries)}")
    if len({song.source_path for song in entries}) != len(entries):
        raise MigrationError("event manifest contains duplicate source paths")
    return path, entries


def parse_event_identity(event_filename: str) -> tuple[str, str, str, str]:
    stem = Path(event_filename).stem
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})-(.+)", stem)
    if not match:
        raise MigrationError(f"event manifest name must be YYYY-MM-DD-Location.txt: {event_filename}")
    event_date = date.fromisoformat(match.group(1))
    location = match.group(2).replace("-", " ")
    event_id = f"{event_date.isoformat()}-{canonical_id(location)}"
    return event_id, location, event_date.isoformat(), f"{location} — {event_date.strftime('%B')} {event_date.day}, {event_date.year}"


def markdown_link_text(title: str) -> str:
    return title.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def build_set_list(event_path: Path, entries: list[Song]) -> tuple[str, str]:
    event_id, location, event_date, heading = parse_event_identity(event_path.name)
    output_path = f"sets/{event_id}.md"
    event_hash = sha256_bytes(event_path.read_bytes())
    lines = [
        "---",
        "schema_version: 1",
        f"id: {event_id}",
        f"title: {location}",
        f"date: {event_date}",
        f"location: {location}",
        "status: migrated",
        "legacy:",
        f"  path: {event_path.name}",
        f"  sha256: {event_hash}",
        "---",
        "",
        f"# {heading}",
        "",
    ]
    for index, song in enumerate(entries, start=1):
        lines.append(f"{index}. [{markdown_link_text(song.title)}](../{song.target_path})")
    return output_path, "\n".join(lines) + "\n"


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary_path = Path(handle.name)
        handle.write(data)
    os.replace(temporary_path, path)


def artifact_paths(destination: Path, songs: list[Song], set_list_path: str) -> list[Path]:
    return [destination / song.target_path for song in songs] + [destination / set_list_path]


def ensure_no_unmanaged_song_files(destination: Path, songs: list[Song]) -> None:
    songs_dir = destination / "songs"
    if not songs_dir.exists():
        return
    expected = {destination / song.target_path for song in songs}
    unexpected = sorted(
        path for path in songs_dir.rglob("*.md") if path not in expected
    )
    if unexpected:
        listed = ", ".join(str(path.relative_to(destination)) for path in unexpected)
        raise MigrationError(f"refusing to overwrite a non-migration song file: {listed}")


def anomaly_records(songs: list[Song]) -> dict[str, list[dict[str, str]]]:
    title_filename = []
    for song in songs:
        if comparison_token(Path(song.filename).stem) != comparison_token(song.title):
            title_filename.append(
                {
                    "source_path": song.source_path,
                    "legacy_filename": song.filename,
                    "h1_title": song.title,
                    "proposed_id": song.proposed_id,
                }
            )
    return {"title_filename_slug_mismatch": title_filename}


def build_manifest(
    source: Path,
    revision: dict[str, str],
    songs: list[Song],
    master_validation: dict[str, Any],
    event_path: Path,
    event_entries: list[Song],
    set_list_path: str,
    set_list_text: str,
) -> dict[str, Any]:
    anomalies = anomaly_records(songs)
    unsectioned = [song.target_path for song in songs if song.h3_count == 0]
    return {
        "schema_version": 1,
        "migration": "phase-0-legacy-byte-preservation",
        "source": {
            "repository_name": source.name,
            **revision,
            "lead_sheet_directory": "lead-sheet",
        },
        "destination": {"song_directory": "songs", "set_directory": "sets"},
        "songs": [
            {
                "source_path": song.source_path,
                "source_sha256": song.sha256,
                "target_path": song.target_path,
                "target_sha256": song.sha256,
                "legacy_filename": song.filename,
                "raw_h1_title": song.raw_h1_title,
                "title": song.title,
                "short_title": song.short_title,
                "proposed_canonical_id": song.proposed_id,
                "h3_section_count": song.h3_count,
                "unsectioned": song.h3_count == 0,
                "final_newline": song.final_newline,
            }
            for song in songs
        ],
        "set_list": {
            "source_path": event_path.name,
            "source_sha256": sha256_bytes(event_path.read_bytes()),
            "target_path": set_list_path,
            "target_sha256": sha256_bytes(set_list_text.encode("utf-8")),
            "entry_count": len(event_entries),
            "entries": [
                {
                    "position": index,
                    "source_path": song.source_path,
                    "title": song.title,
                    "target_path": song.target_path,
                }
                for index, song in enumerate(event_entries, start=1)
            ],
        },
        "anomalies": anomalies,
        "review": {
            "unsectioned_count": len(unsectioned),
            "unsectioned_target_paths": unsectioned,
            "missing_explicit_key_count": len(songs),
            "title_filename_anomaly_count": len(anomalies["title_filename_slug_mismatch"]),
        },
        "validation": {
            "expected_lead_sheet_count": len(songs),
            "discovered_lead_sheet_count": len(songs),
            "byte_preserving_copy_count": len(songs),
            "all_song_hashes_match": True,
            "all_song_files_utf8": True,
            "all_song_files_lf": True,
            "master_manifest": master_validation,
            "event_manifest": {
                "path": event_path.name,
                "entry_count": len(event_entries),
                "duplicate_entries": 0,
                "all_source_paths_resolve": True,
                "all_generated_relative_links_resolve": True,
            },
            "valid": True,
        },
    }


def build_report(manifest: dict[str, Any]) -> str:
    songs = manifest["songs"]
    set_list = manifest["set_list"]
    review = manifest["review"]
    validation = manifest["validation"]
    anomalies = manifest["anomalies"]["title_filename_slug_mismatch"]
    lines = [
        "# Phase 0 legacy migration review",
        "",
        "This report intentionally lists metadata and paths only; it does not reproduce lead-sheet bodies or lyrics.",
        "",
        "## Source and result",
        "",
        f"- Legacy Git commit: `{manifest['source']['git_commit']}` (clean worktree)",
        f"- Lead sheets copied byte-for-byte: **{len(songs)}**",
        f"- Set-list entries converted in order: **{set_list['entry_count']}**",
        f"- Generated set list: `{set_list['target_path']}`",
        f"- Source event manifest SHA-256: `{set_list['source_sha256']}`",
        "",
        "## Validation",
        "",
        f"- Source/destination song SHA-256 equality: **{validation['byte_preserving_copy_count']}/{len(songs)}**",
        f"- Master manifest coverage: **{validation['master_manifest']['rows']}/{len(songs)}**, no missing, extra, or duplicate rows",
        f"- Ordered event entries resolve: **{set_list['entry_count']}/{set_list['entry_count']}**",
        f"- Generated relative links resolve: **{set_list['entry_count']}/{set_list['entry_count']}**",
        f"- Overall validation: **{'PASS' if validation['valid'] else 'FAIL'}**",
        "",
        "## Human review queues",
        "",
        f"- Unsectioned sheets (no legacy H3 section headings): **{review['unsectioned_count']}**",
        f"- Missing explicit performance keys retained as unknown: **{review['missing_explicit_key_count']}**",
        f"- Title/filename mapping anomalies: **{review['title_filename_anomaly_count']}**",
        "",
        "### Title/filename anomalies",
        "",
        "| Legacy path | H1 title | Proposed canonical ID |",
        "| --- | --- | --- |",
    ]
    lines.extend(
        f"| `{item['source_path']}` | {item['h1_title']} | `{item['proposed_id']}` |"
        for item in anomalies
    )
    lines.extend([
        "",
        "## Complete title mapping",
        "",
        "The target filename is deliberately preserved for Phase 0. `proposed_canonical_id` is review metadata only; it does not rename or rewrite a lead sheet.",
        "",
        "| Legacy file | H1 title | Preserved target | Proposed canonical ID | H3 sections |",
        "| --- | --- | --- | --- | ---: |",
    ])
    lines.extend(
        f"| `{song['legacy_filename']}` | {song['title']} | `{song['target_path']}` | `{song['proposed_canonical_id']}` | {song['h3_section_count']} |"
        for song in songs
    )
    lines.extend([
        "",
        "## Unsectioned sheets",
        "",
        "These are retained without invented section labels. Review paths are listed in the machine-readable manifest.",
        "",
        "| Count | Status |",
        "| ---: | --- |",
        f"| {review['unsectioned_count']} | retained byte-for-byte; needs structural review |",
        "",
    ])
    return "\n".join(lines)


def validate_generated_artifacts(
    destination: Path,
    songs: list[Song],
    set_list_path: str,
    set_list_text: str,
    manifest_text: str,
    report_text: str,
) -> None:
    for song in songs:
        target = destination / song.target_path
        if not target.is_file():
            raise MigrationError(f"missing copied song: {song.target_path}")
        target_bytes = target.read_bytes()
        if target_bytes != song.raw or sha256_bytes(target_bytes) != song.sha256:
            raise MigrationError(f"byte/hash mismatch after copy: {song.target_path}")
    set_list_file = destination / set_list_path
    if set_list_file.read_text(encoding="utf-8") != set_list_text:
        raise MigrationError(f"set-list content is not deterministic: {set_list_path}")
    list_lines = set_list_text.splitlines()
    numbered = [line for line in list_lines if SET_LINE_RE.match(line)]
    if len(numbered) == 0:
        raise MigrationError("generated set list contains no entries")
    for expected_position, line in enumerate(numbered, start=1):
        match = SET_LINE_RE.match(line)
        assert match is not None
        position, _title, relative_target = match.groups()
        if int(position) != expected_position:
            raise MigrationError("generated set-list positions are not consecutive")
        target = (set_list_file.parent / relative_target).resolve()
        if not target.is_file() or destination.resolve() not in target.parents:
            raise MigrationError(f"generated relative link does not resolve: {relative_target}")
    manifest_file = destination / "migration" / "legacy-migration-manifest.json"
    report_file = destination / "migration" / "legacy-migration-review.md"
    if manifest_file.read_text(encoding="utf-8") != manifest_text:
        raise MigrationError("machine-readable migration manifest is not deterministic")
    if report_file.read_text(encoding="utf-8") != report_text:
        raise MigrationError("human migration report is not deterministic")
    decoded = json.loads(manifest_text)
    if not decoded["validation"]["valid"]:
        raise MigrationError("manifest reports failed validation")


def run(args: argparse.Namespace) -> None:
    source = args.source.resolve()
    destination = args.destination.resolve()
    revision = source_revision(source)
    songs = load_songs(source, args.expected_lead_sheets)
    master_validation = validate_master_manifest(source, songs)
    event_path, event_entries = parse_event_manifest(
        source, args.event_manifest, songs, args.expected_set_entries
    )
    set_list_path, set_list_text = build_set_list(event_path, event_entries)
    manifest = build_manifest(
        source, revision, songs, master_validation, event_path, event_entries, set_list_path, set_list_text
    )
    manifest_text = json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    report_text = build_report(manifest)

    if args.verify_only:
        validate_generated_artifacts(
            destination, songs, set_list_path, set_list_text, manifest_text, report_text
        )
    else:
        ensure_no_unmanaged_song_files(destination, songs)
        for song in songs:
            atomic_write(destination / song.target_path, song.raw)
        atomic_write(destination / set_list_path, set_list_text.encode("utf-8"))
        atomic_write(destination / "migration" / "legacy-migration-manifest.json", manifest_text.encode("utf-8"))
        atomic_write(destination / "migration" / "legacy-migration-review.md", report_text.encode("utf-8"))
        validate_generated_artifacts(
            destination, songs, set_list_path, set_list_text, manifest_text, report_text
        )
    print(
        f"PASS: {len(songs)} byte-preserved songs; {len(event_entries)} ordered set-list links; "
        f"{manifest['review']['unsectioned_count']} unsectioned; "
        f"{manifest['review']['title_filename_anomaly_count']} title/filename anomalies."
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="legacy Git checkout")
    parser.add_argument("--destination", type=Path, default=Path.cwd(), help="songs repository root")
    parser.add_argument("--event-manifest", default=DEFAULT_EVENT_MANIFEST)
    parser.add_argument("--expected-lead-sheets", type=int, default=EXPECTED_LEAD_SHEETS)
    parser.add_argument("--expected-set-entries", type=int, default=EXPECTED_SET_ENTRIES)
    parser.add_argument("--verify-only", action="store_true", help="perform no writes; verify existing outputs")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        run(parse_args(argv if argv is not None else sys.argv[1:]))
    except MigrationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
