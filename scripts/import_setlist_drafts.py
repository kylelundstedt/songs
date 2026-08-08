#!/usr/bin/env python3
"""Deterministically import admitted set-list draft candidates into ``sets/``.

This intentionally imports only the two admitted candidate collections.  It never
replaces a pre-existing set file; a known draft_id retains its existing filename
so re-running the importer is idempotent.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "migration/set-list-research/candidates/set-list-drafts.json"
SETS = ROOT / "sets"
REPORT = ROOT / "migration/set-list-research/reports/app-import.md"


def slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return re.sub(r"^-+|-+$", "", value) or "untitled"


def yaml_scalar(value: object) -> str:
    # JSON strings are valid YAML scalars and safely retain punctuation/newlines.
    return json.dumps(value, ensure_ascii=False)


def frontmatter_value(text: str, key: str) -> str | None:
    match = re.search(rf"^{re.escape(key)}:\s*(.+)$", text, flags=re.M)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return match.group(1).strip().strip('"')


def markdown_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def markdown_text(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").strip()


def date_prefix(metadata: dict) -> tuple[str, str, str | None]:
    date = metadata.get("date") or {}
    value = date.get("value")
    precision = date.get("precision") or "unknown"
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}(-\d{2})?", value):
        return value, precision, value
    return "undated", "unknown", None


def item_annotation(item: dict) -> str:
    annotations: list[str] = []
    if item.get("singer"):
        annotations.append(f"singer: {markdown_text(item['singer'])}")
    proposal = item.get("singer_proposal")
    if proposal:
        annotations.append(f"singer?: {markdown_text(proposal.get('value', 'unknown'))}")
    if item.get("note"):
        annotations.append(f"note: {markdown_text(item['note'])}")
    proposal = item.get("note_proposal")
    if proposal:
        annotations.append(f"note?: {markdown_text(proposal.get('value', 'unknown'))}")
    if item.get("resolution_status") != "exact":
        annotations.append(f"match: {item.get('resolution_status', 'unresolved')}?")
    return " — " + " — ".join(annotations) if annotations else ""


def render(draft: dict, set_id: str) -> str:
    metadata = draft["proposed_metadata"]
    _, precision, date_value = date_prefix(metadata)
    primary = draft["import_evidence"]["primary_source"]
    band_explicit = metadata.get("band_explicit")
    band_proposal = metadata.get("band_proposal") or {}
    band = band_explicit or band_proposal.get("value") or ""
    band_note = "" if band_explicit else ("proposed" if band else "unresolved")
    items = [item for section in draft["sections"] for item in section["items"]]
    unresolved = [item["item_id"] for item in items if item.get("resolution_status") not in {"exact", "normalized"}]
    review_required = draft["status"] == "review_required" or bool(unresolved) or not band_explicit
    review_bits = []
    if draft["status"] == "review_required":
        review_bits.append("candidate requires review")
    if unresolved:
        review_bits.append(f"{len(unresolved)} unresolved item(s)")
    if not band_explicit:
        review_bits.append("band " + ("proposed" if band_proposal else "unresolved"))
    review_note = "; ".join(review_bits) or "admitted publication-ready candidate"
    unresolved_lines = ["unresolved_items: []"] if not unresolved else [
        "unresolved_items:",
        *[f"  - {yaml_scalar(item_id)}" for item_id in unresolved],
    ]
    lines = [
        "---",
        "schema_version: 1",
        f"id: {yaml_scalar(set_id)}",
        f"title: {yaml_scalar(metadata.get('title') or metadata.get('title_proposal') or 'Untitled set')}",
        f"date: {yaml_scalar(date_value or '')}",
        f"date_precision: {yaml_scalar(precision)}",
        f"location: {yaml_scalar(metadata.get('location') or '')}",
        f"band: {yaml_scalar(band)}",
        f"band_review: {yaml_scalar(band_note)}",
        "status: draft",
        f"draft_id: {yaml_scalar(draft['draft_id'])}",
        f"review_required: {'true' if review_required else 'false'}",
        *unresolved_lines,
        f"review_note: {yaml_scalar(review_note)}",
        f"source_type: {yaml_scalar(primary.get('source_type'))}",
        f"source_id: {yaml_scalar(primary.get('source_id'))}",
        "---",
        "",
        f"# {markdown_text(metadata.get('title') or metadata.get('title_proposal') or 'Untitled set')}",
        "",
    ]
    for number, item in enumerate(items, 1):
        label = markdown_label(markdown_text(item.get("display_label") or item["item_id"]))
        resolved = item.get("resolved_canonical_song")
        if resolved:
            target = "../" + resolved["canonical_song_path"]
        else:
            target = "unresolved:" + slug(item.get("cleaned_title") or item["item_id"])
        lines.append(f"{number}. [{label}]({target}){item_annotation(item)}")
    return "\n".join(lines) + "\n"


def write_if_changed(path: Path, content: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate only; do not write")
    parser.add_argument("--refresh-existing-drafts", action="store_true", help="replace files carrying a matching draft_id; normally existing imported Set Lists are preserved")
    args = parser.parse_args()
    data = json.loads(INPUT.read_text(encoding="utf-8"))
    drafts = sorted(data["publication_ready"] + data["review_required"], key=lambda d: d["draft_id"])
    if len(drafts) != 59:
        raise SystemExit(f"expected 59 admitted drafts, got {len(drafts)}")

    existing = {path.name: path for path in SETS.glob("*.md")}
    known_paths = {}
    known_ids = set()
    for name, path in existing.items():
        text = path.read_text(encoding="utf-8")
        known_ids.add(frontmatter_value(text, "id"))
        draft_id = frontmatter_value(text, "draft_id")
        if draft_id:
            known_paths[draft_id] = name

    allocation: dict[str, str] = {}
    occupied = set(existing)
    collisions: list[str] = []
    for draft in drafts:
        did = draft["draft_id"]
        if did in known_paths:
            allocation[did] = known_paths[did]
            continue
        metadata = draft["proposed_metadata"]
        prefix, _, _ = date_prefix(metadata)
        base = f"{prefix}-{slug(metadata.get('title') or metadata.get('title_proposal') or 'untitled-set')}"
        name = base + ".md"
        if name in occupied:
            name = f"{base}-{did}.md"
            collisions.append(name)
        # Defensive deterministic fallback for a pre-existing suffix collision.
        n = 2
        while name in occupied:
            name = f"{base}-{did}-{n}.md"
            n += 1
        allocation[did] = name
        occupied.add(name)

    created = changed = 0
    for draft in drafts:
        name = allocation[draft["draft_id"]]
        path = SETS / name
        set_id = path.stem
        if set_id in known_ids and known_paths.get(draft["draft_id"]) != name:
            raise SystemExit(f"would duplicate existing set id: {set_id}")
        content = render(draft, set_id)
        if not path.exists():
            created += 1
            if not args.check:
                path.write_text(content, encoding="utf-8")
                changed += 1
        elif known_paths.get(draft["draft_id"]) == name and args.refresh_existing_drafts and not args.check:
            # Explicit refresh is limited to files carrying the same draft_id.
            # The default preserves later metadata cleanup and in-app edits.
            if write_if_changed(path, content):
                changed += 1

    # Verify generated content / repository state without relying on a YAML dependency.
    all_sets = list(SETS.glob("*.md"))
    ids = [frontmatter_value(p.read_text(encoding="utf-8"), "id") for p in all_sets]
    if len(all_sets) != 60 or len(ids) != len(set(ids)):
        raise SystemExit(f"verification failed: {len(all_sets)} set files; unique ids={len(set(ids))}")
    unresolved_targets = resolved_targets = 0
    for path in all_sets:
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\]\(([^)]+)\)", text):
            if target.startswith("unresolved:"):
                unresolved_targets += 1
            else:
                resolved_targets += 1
                if not (path.parent / target).resolve().is_file():
                    raise SystemExit(f"missing resolved link in {path}: {target}")
    report = "\n".join([
        "# App import report",
        "",
        "- Imported draft set files: 59 (8 publication-ready, 51 review-required)",
        "- Excluded: 6 unusable, 1 existing canonical",
        f"- Filename collisions requiring draft-id suffixes: {len(collisions)}",
        f"- Resolved song links verified: {resolved_targets}",
        f"- Reserved unresolved links verified: {unresolved_targets}",
        "- Verification: 60 total set files (59 imported drafts + Murphys), unique IDs/files, and all resolved links exist.",
        "",
    ])
    if not args.check:
        write_if_changed(REPORT, report)
    print(f"created={created} changed={changed if not args.check else 0} collisions={len(collisions)} resolved={resolved_targets} unresolved={unresolved_targets}")


if __name__ == "__main__":
    main()
