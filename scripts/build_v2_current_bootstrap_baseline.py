#!/usr/bin/env python3
"""Build the chunked bootstrap payload for the frozen current-content baseline."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from v2_current_config import (
    CURRENT_COMMIT,
    CURRENT_REF,
    CURRENT_ROOT,
    EXPECTED_DOCUMENTS,
    EXPECTED_SETS,
    EXPECTED_SONGS,
    EXPECTED_SOURCE_BYTES,
)

SCHEMA_VERSION = "1"
CHUNK_TARGET_SOURCE_BYTES = 65_536
PAYLOAD_DIR = CURRENT_ROOT / "bootstrap/payload"
BASELINE_PATH = CURRENT_ROOT / "bootstrap/bootstrap-baseline.json"
CORPUS_PATH = CURRENT_ROOT / "corpus-manifest.json"
HARNESS_SOURCE_COMMIT = "10711bed6373b3d58f0ae2cfe1169e547fdf638a"
HARNESS_SOURCE = Path("migration/v2/bootstrap/harness")
HARNESS_TARGET = CURRENT_ROOT / "bootstrap/harness"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def archive_docs(repo: Path) -> dict[str, bytes]:
    actual = subprocess.check_output(["git", "-C", str(repo), "rev-parse", f"{CURRENT_REF}^{{commit}}"], text=True).strip()
    if actual != CURRENT_COMMIT:
        raise ValueError(f"{CURRENT_REF} resolves to {actual}, expected {CURRENT_COMMIT}")
    raw = subprocess.check_output(["git", "-C", str(repo), "archive", "--format=tar", CURRENT_REF])
    docs: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for item in archive:
            path = PurePosixPath(item.name)
            if not item.isfile() or len(path.parts) < 2 or path.parts[0] not in {"songs", "sets"} or path.suffix != ".md":
                continue
            source = archive.extractfile(item)
            if source is None:
                raise ValueError(f"cannot read {item.name}")
            docs[item.name] = source.read()
    return dict(sorted(docs.items()))


def manifest_records(repo: Path) -> dict[str, dict[str, Any]]:
    data = json.loads((repo / CORPUS_PATH).read_text(encoding="utf-8"))
    if data.get("baseline") != {"ref": CURRENT_REF, "commit": CURRENT_COMMIT}:
        raise ValueError("current corpus manifest baseline mismatch")
    return {record["path"]: record for record in data["records"]}


def identity_bytes(docs: dict[str, bytes]) -> bytes:
    output = bytearray()
    for path, raw in docs.items():
        for part in (path.encode("utf-8"), sha256(raw).encode("ascii"), raw):
            output.extend(len(part).to_bytes(8, "big"))
            output.extend(part)
    return bytes(output)


def chunk_docs(docs: dict[str, bytes]) -> list[list[tuple[str, bytes]]]:
    chunks: list[list[tuple[str, bytes]]] = []
    current: list[tuple[str, bytes]] = []
    size = 0
    for path, raw in docs.items():
        if current and size + len(raw) > CHUNK_TARGET_SOURCE_BYTES:
            chunks.append(current)
            current = []
            size = 0
        current.append((path, raw))
        size += len(raw)
    if current:
        chunks.append(current)
    return chunks


def build(repo: Path) -> dict[Path, bytes]:
    docs = archive_docs(repo)
    contract = manifest_records(repo)
    if set(docs) != set(contract):
        raise ValueError("current archive paths do not exactly match corpus manifest")
    for path, raw in docs.items():
        record = contract[path]
        if record["bytes"] != len(raw) or record["sha256"] != sha256(raw):
            raise ValueError(f"current corpus mismatch: {path}")
    if len(docs) != EXPECTED_DOCUMENTS or sum(map(len, docs.values())) != EXPECTED_SOURCE_BYTES:
        raise ValueError("unexpected current corpus cardinality")

    snapshot_digest = sha256(identity_bytes(docs))
    generation = "phase1-" + snapshot_digest[:24]
    outputs: dict[Path, bytes] = {}
    chunks: list[dict[str, Any]] = []
    for index, entries in enumerate(chunk_docs(docs)):
        chunk = {
            "documents": [
                {
                    "bytes": len(raw),
                    "content_base64": base64.b64encode(raw).decode("ascii"),
                    "path": path,
                    "sha256": sha256(raw),
                }
                for path, raw in entries
            ],
            "generation": generation,
            "index": index,
            "schema_version": SCHEMA_VERSION,
        }
        encoded = canonical(chunk)
        name = f"chunk-{index:03d}.json"
        outputs[PAYLOAD_DIR / name] = encoded
        chunks.append({
            "doc_count": len(entries),
            "file_bytes": len(encoded),
            "first_path": entries[0][0],
            "index": index,
            "last_path": entries[-1][0],
            "path": name,
            "sha256": sha256(encoded),
            "source_bytes": sum(len(raw) for _, raw in entries),
        })
    manifest = {
        "baseline": {"commit": CURRENT_COMMIT, "ref": CURRENT_REF},
        "chunks": chunks,
        "corpus": {
            "bytes": EXPECTED_SOURCE_BYTES,
            "documents": EXPECTED_DOCUMENTS,
            "sets": EXPECTED_SETS,
            "songs": EXPECTED_SONGS,
        },
        "generation": generation,
        "schema_version": SCHEMA_VERSION,
        "snapshot_digest": snapshot_digest,
    }
    manifest_bytes = canonical(manifest)
    outputs[PAYLOAD_DIR / "manifest.json"] = manifest_bytes

    assets: dict[str, dict[str, Any]] = {}
    for name in ("index.html", "app.js", "sw.js"):
        source_path = HARNESS_SOURCE / name
        raw = subprocess.check_output(["git", "-C", str(repo), "show", f"{HARNESS_SOURCE_COMMIT}:{source_path.as_posix()}"])
        outputs[HARNESS_TARGET / name] = raw
        assets[f"harness/{name}"] = {"bytes": len(raw), "sha256": sha256(raw)}
    baseline = {
        "assets": assets,
        "baseline": {"commit": CURRENT_COMMIT, "ref": CURRENT_REF},
        "generation": generation,
        "generator": {"name": "scripts/build_v2_current_bootstrap_baseline.py", "version": "1"},
        "harness_source": {"commit": HARNESS_SOURCE_COMMIT, "paths": [str(HARNESS_SOURCE / name) for name in ("index.html", "app.js", "sw.js")]},
        "payload": {
            "chunk_count": len(chunks),
            "manifest_path": "payload/manifest.json",
            "manifest_sha256": sha256(manifest_bytes),
            "source_chunk_target_bytes": CHUNK_TARGET_SOURCE_BYTES,
            "snapshot_digest": snapshot_digest,
        },
        "schema_version": SCHEMA_VERSION,
        "verification": {
            "documents": EXPECTED_DOCUMENTS,
            "source_bytes": EXPECTED_SOURCE_BYTES,
            "output_sha256": None,
        },
    }
    baseline["verification"]["output_sha256"] = sha256(canonical(baseline))
    outputs[BASELINE_PATH] = canonical(baseline)
    return outputs


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    expected = build(repo)
    chunk_root = repo / PAYLOAD_DIR
    expected_chunks = {path.name for path in expected if path.parent == PAYLOAD_DIR and path.name.startswith("chunk-")}
    actual_chunks = {path.name for path in chunk_root.glob("chunk-*.json") if path.is_file()}
    stale = sorted(actual_chunks - expected_chunks)
    changed = [repo / relative for relative, raw in expected.items() if not (repo / relative).is_file() or (repo / relative).read_bytes() != raw]
    changed.extend(chunk_root / name for name in stale)
    if args.check:
        if changed:
            print("generated current bootstrap artifacts differ:\n" + "\n".join(map(str, changed)), file=sys.stderr)
            return 1
        print("current bootstrap payload: OK")
        return 0
    for name in stale:
        (chunk_root / name).unlink()
    for relative, raw in expected.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_bytes() != raw:
            target.write_bytes(raw)
            print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
