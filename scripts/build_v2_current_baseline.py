#!/usr/bin/env python3
"""Build the frozen current corpus manifest and lossless identity sidecars."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable

from v2_current_config import (
    CURRENT_COMMIT,
    CURRENT_REF,
    CURRENT_ROOT,
    EXPECTED_DOCUMENTS,
    EXPECTED_SETS,
    EXPECTED_SONGS,
    EXPECTED_SOURCE_BYTES,
    load_script,
)

CORPUS_OUTPUT = CURRENT_ROOT / "corpus-manifest.json"
IDENTITY_OUTPUT = CURRENT_ROOT / "identity-sidecars.json"
IDENTITY_NAMESPACE = uuid.UUID("86a2868e-dd1b-56fe-92ab-a606baa3f9e8")
FRONT_MATTER_RE = re.compile(r"\A---(?:\r\n|\n|\r)(.*?)(?:\r\n|\n|\r)---(?:\r\n|\n|\r|\Z)", re.S)
FIELD_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$")
ENTRY_LINE_RE = re.compile(r"^\s*\d+\.\s+(.*?)\s*$")


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def with_hash(value: dict[str, Any]) -> bytes:
    value["verification"]["output_sha256"] = None
    value["verification"]["output_sha256"] = hashlib.sha256(canonical(value)).hexdigest()
    return canonical(value)


def front_matter_fields(raw: bytes, baseline: Any) -> dict[str, str]:
    text = raw.decode("utf-8")
    match = FRONT_MATTER_RE.match(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        field = FIELD_RE.match(line)
        if field:
            fields[field.group(1)] = baseline.parse_scalar(field.group(2))
    return fields


def sidecar_song_id(fields: dict[str, str]) -> tuple[str, str]:
    commit = fields.get("legacy_source_commit")
    path = fields.get("legacy_source_path")
    if not commit or not path:
        raise ValueError("song without declared ID lacks lossless legacy identity fields")
    seed = f"legacy-song:{commit}:{path}"
    return f"song-{uuid.uuid5(IDENTITY_NAMESPACE, seed)}", seed


def entry_fingerprint(content: str) -> str:
    """Fingerprint one imported entry independent of its list number/order."""
    normalized = " ".join(content.strip().split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def stable_entry_id(set_id: str, fingerprint: str, occurrence: int) -> tuple[str, str]:
    seed = f"set-entry:{set_id}:{fingerprint}:{occurrence}"
    return f"entry-{uuid.uuid5(IDENTITY_NAMESPACE, seed)}", seed


def build(repo: Path) -> dict[Path, bytes]:
    baseline = load_script(repo, "build_v2_baseline.py", "v2_current_baseline_base")
    baseline.verify_ref(repo, CURRENT_REF, CURRENT_COMMIT)
    temporary, source_root = baseline.export_git_tree(repo, CURRENT_REF)
    try:
        manifest = baseline.build_manifest(source_root, baseline_ref=CURRENT_REF, baseline_commit=CURRENT_COMMIT)
        counts = manifest["corpus"]["counts"]
        total_bytes = manifest["corpus"]["bytes"]["total"]
        if counts != {"files": EXPECTED_DOCUMENTS, "songs": EXPECTED_SONGS, "sets": EXPECTED_SETS}:
            raise ValueError(f"current corpus count drift: {counts}")
        if total_bytes != EXPECTED_SOURCE_BYTES:
            raise ValueError(f"current corpus bytes drift: {total_bytes}")
        manifest["generator"] = {
            "name": "scripts/build_v2_current_baseline.py",
            "version": "1",
            "command": "python3 scripts/build_v2_current_baseline.py",
        }
        corpus_bytes = baseline.render_with_verification(manifest).encode("utf-8")

        document_ids: dict[str, str] = {}
        documents: list[dict[str, Any]] = []
        records = {record["path"]: record for record in manifest["records"]}
        for path, record in records.items():
            raw = (source_root / path).read_bytes()
            fields = front_matter_fields(raw, baseline)
            declared_id = record["front_matter_id"]
            if declared_id:
                document_id = declared_id
                source = "front-matter"
                seed = None
            elif record["kind"] == "song":
                document_id, seed = sidecar_song_id(fields)
                source = "sidecar-legacy-source"
            else:
                raise ValueError(f"set lacks declared ID: {path}")
            if document_id in document_ids.values():
                raise ValueError(f"duplicate document ID: {document_id}")
            document_ids[path] = document_id
            item: dict[str, Any] = {
                "id": document_id,
                "kind": record["kind"],
                "path": path,
                "source": source,
                "source_sha256": record["sha256"],
            }
            if seed is not None:
                item["identity_seed"] = seed
            documents.append(item)

        canonical_paths = set(records)
        set_entries: list[dict[str, Any]] = []
        for set_record in (record for record in manifest["records"] if record["kind"] == "set"):
            set_id = document_ids[set_record["path"]]
            occurrences: dict[str, int] = {}
            ordinal = 0
            text = (source_root / set_record["path"]).read_text(encoding="utf-8")
            for line in text.splitlines():
                match = ENTRY_LINE_RE.match(line)
                if not match:
                    continue
                content = match.group(1)
                links = baseline.markdown_links(content)
                if len(links) != 1:
                    raise ValueError(f"Set Entry must contain exactly one Markdown link: {set_record['path']}: {line}")
                label, target = links[0]
                classification, resolved = baseline.classify_link(set_record["path"], target, canonical_paths)
                if classification not in {"resolved canonical file", "unresolved: reference"}:
                    raise ValueError(f"unsupported Set Entry target: {set_record['path']}: {target}")
                ordinal += 1
                fingerprint = entry_fingerprint(content)
                occurrence = occurrences.get(fingerprint, 0) + 1
                occurrences[fingerprint] = occurrence
                entry_id, seed = stable_entry_id(set_id, fingerprint, occurrence)
                entry: dict[str, Any] = {
                    "id": entry_id,
                    "set_id": set_id,
                    "set_path": set_record["path"],
                    "ordinal": ordinal,
                    "fingerprint": fingerprint,
                    "fingerprint_occurrence": occurrence,
                    "source_content": content,
                    "label": label,
                    "target": target,
                    "classification": classification,
                    "identity_seed": seed,
                }
                if resolved is not None:
                    entry["target_path"] = resolved
                    entry["target_document_id"] = document_ids[resolved]
                set_entries.append(entry)
            expected_entries = sum(
                link["classification"] in {"resolved canonical file", "unresolved: reference"}
                for link in set_record["links"]
            )
            if ordinal != expected_entries:
                raise ValueError(f"Set Entry count differs from manifest links: {set_record['path']}")

        slug_routes = [
            {
                "kind": record["kind"],
                "slug": record["legacy_slug"].lower(),
                "path": record["path"],
                "document_id": document_ids[record["path"]],
            }
            for record in manifest["records"]
        ]
        if len({(route["kind"], route["slug"]) for route in slug_routes}) != len(slug_routes):
            raise ValueError("duplicate legacy route slug")

        identity = {
            "schema_version": "1",
            "baseline": {"ref": CURRENT_REF, "commit": CURRENT_COMMIT},
            "namespace_uuid": str(IDENTITY_NAMESPACE),
            "policy": {
                "declared_document_ids": "preserved exactly",
                "legacy_song_ids": "UUIDv5 from legacy source commit and path; canonical Markdown is unchanged",
                "set_entry_ids": "UUIDv5 from stable set ID, order-independent entry fingerprint, and duplicate occurrence; ordinal is stored separately",
                "filenames": "routing slugs mapped explicitly to immutable IDs, never identity",
            },
            "counts": {
                "documents": len(documents),
                "declared_document_ids": sum(item["source"] == "front-matter" for item in documents),
                "sidecar_document_ids": sum(item["source"] != "front-matter" for item in documents),
                "slug_routes": len(slug_routes),
                "set_entries": len(set_entries),
                "resolved_set_entries": sum(item["classification"] == "resolved canonical file" for item in set_entries),
                "unresolved_set_entries": sum(item["classification"] == "unresolved: reference" for item in set_entries),
            },
            "documents": documents,
            "slug_routes": slug_routes,
            "set_entries": set_entries,
            "verification": {"output_sha256": None},
        }
        if identity["counts"] != {
            "documents": EXPECTED_DOCUMENTS,
            "declared_document_ids": 89,
            "sidecar_document_ids": 284,
            "slug_routes": 373,
            "set_entries": 1076,
            "resolved_set_entries": 1076,
            "unresolved_set_entries": 0,
        }:
            raise ValueError(f"current identity count drift: {identity['counts']}")
        return {CORPUS_OUTPUT: corpus_bytes, IDENTITY_OUTPUT: with_hash(identity)}
    finally:
        temporary.cleanup()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    expected = build(repo)
    changed = [repo / path for path, raw in expected.items() if not (repo / path).is_file() or (repo / path).read_bytes() != raw]
    if args.check:
        if changed:
            print("generated current baseline differs:\n" + "\n".join(map(str, changed)), file=sys.stderr)
            return 1
        print("current corpus and identity baseline: OK")
        return 0
    for relative, raw in expected.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_bytes() != raw:
            target.write_bytes(raw)
            print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
