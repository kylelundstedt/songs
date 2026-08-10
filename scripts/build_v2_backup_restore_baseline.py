#!/usr/bin/env python3
"""Build the deterministic v1 backup/restore evidence baseline.

The drill is deliberately self-contained and ephemeral.  It creates a Git
bundle for ``refs/tags/v1``, restores two clean checkouts, starts the tagged
server twice with private SQLite files, takes the first database through the
SQLite online backup API, and verifies the second instance.  No network calls,
production paths, or mutable canonical files are used.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from urllib.parse import quote

BASELINE_REF = "v1"
BASELINE_COMMIT = "546f59b41d9e9bcf0e81b543c27900a31e26c9e6"
BUNDLE_REF = "refs/tags/v1"
GENERATOR_NAME = "scripts/build_v2_backup_restore_baseline.py"
GENERATOR_COMMAND = "python3 scripts/build_v2_backup_restore_baseline.py"
CORPUS_PATH = Path("migration/v2/v1-corpus-manifest.json")
RENDERER_PATH = Path("migration/v2/renderer/renderer-baseline.json")
ROUTE_PATH = Path("migration/v2/routes/route-baseline.json")
DEFAULT_OUTPUT = Path("migration/v2/backup-restore/backup-restore-baseline.json")
SCHEMA_VERSION = "1"
GENERATOR_VERSION = "1"
AUTH_HEADERS = {"X-ExeDev-UserID": "v2-route-baseline", "X-ExeDev-Email": "klundstedt@industryvault.com"}
RFC3339_RE = re.compile(rb"\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b")
SHELLEY_RE = re.compile(rb"https://[^\"' <]+\.shelley\.exe\.xyz/new")
PORT_RE = re.compile(rb"(?<![0-9])127\.0\.0\.1:\d+(?![0-9])")
REQUIRED_COMPONENTS = ("git_bundle", "sqlite_online_backup")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def render_with_verification(value: dict[str, Any]) -> str:
    value["verification"]["output_sha256"] = None
    value["verification"]["output_sha256"] = sha256_bytes(canonical_json(value).encode("utf-8"))
    return canonical_json(value)


def verify_ref(repo_root: Path, ref: str | None = None, expected: str | None = None) -> None:
    ref = ref or BASELINE_REF
    expected = expected or BASELINE_COMMIT
    actual = subprocess.check_output(["git", "-C", str(repo_root), "rev-parse", f"{ref}^{{commit}}"], text=True, stderr=subprocess.PIPE).strip()
    if actual != expected:
        raise RuntimeError(f"baseline ref {ref} does not match required commit")


def archive_tree_from_bundle(bundle: Path, destination: Path) -> None:
    """Clone the bundle, detach at the exact tag, and restore archive mtimes."""
    subprocess.run(["git", "clone", "--quiet", "--no-checkout", str(bundle), str(destination)], check=True, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(destination), "checkout", "--quiet", "--detach", BUNDLE_REF], check=True, capture_output=True, text=True)
    archive = subprocess.check_output(["git", "-C", str(destination), "archive", "--format=tar", BUNDLE_REF])
    with tempfile.TemporaryFile() as stream:
        stream.write(archive)
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode="r:") as tar:
            for member in tar.getmembers():
                member_path = PurePosixPath(member.name)
                if member_path.is_absolute() or ".." in member_path.parts:
                    raise RuntimeError(f"unsafe path in Git archive: {member.name}")
                if not member.isfile():
                    continue
                target = destination.joinpath(*member_path.parts)
                if target.is_file():
                    os.utime(target, (member.mtime, member.mtime))


def create_bundle(repo_root: Path, path: Path) -> None:
    subprocess.run(["git", "-C", str(repo_root), "bundle", "create", str(path), BUNDLE_REF], check=True, capture_output=True, text=True)
    verify_bundle(path, repo_root)


def verify_bundle(path: Path, repo_root: Path | None = None) -> None:
    if repo_root is not None:
        subprocess.run(["git", "-C", str(repo_root), "bundle", "verify", str(path)], check=True, capture_output=True, text=True)
        return
    with tempfile.TemporaryDirectory(prefix="bundle-verify-") as directory:
        bare = Path(directory) / "repo.git"
        subprocess.run(["git", "init", "--quiet", "--bare", str(bare)], check=True, capture_output=True, text=True)
        subprocess.run(["git", "-C", str(bare), "bundle", "verify", str(path)], check=True, capture_output=True, text=True)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def verify_prior_artifacts(repo_root: Path) -> dict[str, Any]:
    corpus = load_json(repo_root / CORPUS_PATH)
    renderer = load_json(repo_root / RENDERER_PATH)
    routes = load_json(repo_root / ROUTE_PATH)
    expected = {"ref": BASELINE_REF, "commit": BASELINE_COMMIT}
    if corpus.get("baseline") != expected or renderer.get("baseline") != expected or routes.get("baseline") != expected:
        raise RuntimeError("TASK-001/002/003 artifacts do not share the required baseline")
    for artifact in (corpus, renderer, routes):
        saved = artifact.get("verification", {}).get("output_sha256")
        artifact["verification"]["output_sha256"] = None
        if saved != sha256_bytes(canonical_json(artifact).encode("utf-8")):
            raise RuntimeError("a prior baseline artifact has invalid verification output")
    records = {record["path"]: record for record in corpus["records"]}
    renders = renderer["corpus"]["renders"]
    expected_files = corpus["corpus"]["counts"]["files"]
    expected_songs = corpus["corpus"]["counts"]["songs"]
    if len(records) != expected_files or len(renders) != expected_songs:
        raise RuntimeError("prior corpus or renderer artifact counts drifted")
    for render in renders:
        if records[render["path"]]["sha256"] != render["source_sha256"]:
            raise RuntimeError("renderer source hashes do not match TASK-001")
    for path, expected_hash in routes["source_hashes"].items():
        try:
            tagged_bytes = subprocess.check_output(["git", "-C", str(repo_root), "show", f"{BASELINE_REF}:{path}"], stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as exc:
            raise RuntimeError("TASK-003 source file is absent from the tagged baseline") from exc
        if sha256_bytes(tagged_bytes) != expected_hash:
            raise RuntimeError("TASK-003 source hash does not match the tagged baseline")
    return {
        "task_001": True,
        "task_002": True,
        "task_003": True,
        "corpus_files": corpus["corpus"]["counts"]["files"],
        "renderer_songs": renderer["corpus"]["song_count"],
        "route_records": routes["verification"]["record_count"],
    }


def corpus_records(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {record["path"]: record for record in manifest["records"]}


def verify_corpus(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    records = corpus_records(manifest)
    actual = sorted(path.relative_to(root).as_posix() for directory in ("songs", "sets") for path in (root / directory).rglob("*.md") if path.is_file())
    expected = sorted(records)
    if actual != expected:
        raise ValueError("missing or extra canonical file")
    for relative in expected:
        raw = (root / relative).read_bytes()
        record = records[relative]
        if len(raw) != record["bytes"] or sha256_bytes(raw) != record["sha256"]:
            raise ValueError("canonical corpus content mismatch")
    return {"files": len(actual), "songs": sum(p.startswith("songs/") for p in actual), "sets": sum(p.startswith("sets/") for p in actual), "byte_for_byte": True}


def compare_corpus(root: Path, manifest: dict[str, Any]) -> bool:
    try:
        verify_corpus(root, manifest)
        return True
    except (OSError, ValueError):
        return False




def component_manifest(paths: dict[str, Path], baseline: dict[str, str], schema_hash: str, projection_hash: str) -> dict[str, Any]:
    components = {name: {"sha256": sha256_bytes(path.read_bytes()), "bytes": path.stat().st_size} for name, path in sorted(paths.items())}
    return {"baseline": baseline, "components": components, "schema_hash": schema_hash, "projection_hash": projection_hash}


def validate_component_manifest(manifest: dict[str, Any], paths: dict[str, Path], expected_baseline: dict[str, str] | None = None) -> None:
    baseline = manifest.get("baseline")
    if expected_baseline is not None and baseline != expected_baseline:
        raise ValueError("wrong baseline commit")
    components = manifest.get("components")
    if not isinstance(components, dict):
        raise ValueError("missing backup component")
    for name in REQUIRED_COMPONENTS:
        if name not in components or name not in paths:
            raise ValueError("missing backup component")
        item = components[name]
        if not isinstance(item, dict) or item.get("bytes") != paths[name].stat().st_size or item.get("sha256") != sha256_bytes(paths[name].read_bytes()):
            raise ValueError("backup component hash mismatch")


def semantic_projection(connection: sqlite3.Connection) -> dict[str, Any]:
    def rows(sql: str) -> list[list[Any]]:
        return [list(row) for row in connection.execute(sql)]
    return {
        "migrations": rows("SELECT migration_number,migration_name FROM migrations ORDER BY migration_number"),
        "song_index": [row[:5] + [sha256_bytes(row[5].encode("utf-8"))] for row in rows("SELECT id,path,title,normalized_title,source_hash,rendered_html FROM song_index ORDER BY id")],
        "set_index": rows("SELECT id,path,title,event_date,location,source_hash FROM set_index ORDER BY id"),
    }




def projection_hash(projection: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(projection).encode("utf-8"))


def schema_hash(connection: sqlite3.Connection) -> str:
    rows = [list(row) for row in connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name")]
    return sha256_bytes(canonical_json(rows).encode("utf-8"))


def sqlite_evidence(path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(path)
    try:
        quick = connection.execute("PRAGMA quick_check").fetchone()[0]
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
        projection = semantic_projection(connection)
        return {
            "quick_check": quick == "ok", "integrity_check": integrity == "ok", "foreign_key_check": len(foreign) == 0,
            "schema_hash": schema_hash(connection), "projection": projection, "projection_hash": projection_hash(projection),
            "schema_object_count": connection.execute("SELECT count(*) FROM sqlite_master WHERE sql IS NOT NULL").fetchone()[0],
            "migration_count": connection.execute("SELECT count(*) FROM migrations").fetchone()[0],
            "song_index_count": connection.execute("SELECT count(*) FROM song_index").fetchone()[0],
            "set_index_count": connection.execute("SELECT count(*) FROM set_index").fetchone()[0],
            "page_size": connection.execute("PRAGMA page_size").fetchone()[0],
            "page_count": connection.execute("PRAGMA page_count").fetchone()[0],
        }
    finally:
        connection.close()


def online_backup(source: Path, destination: Path) -> None:
    source_connection = sqlite3.connect(source)
    destination_connection = sqlite3.connect(destination)
    try:
        source_connection.backup(destination_connection)
        destination_connection.commit()
    finally:
        destination_connection.close()
        source_connection.close()


def normalized_body(body: bytes) -> bytes:
    body = RFC3339_RE.sub(b"{RFC3339_BUILD_TIME}", body)
    body = SHELLEY_RE.sub(b"{SHELLEY_URL}", body)
    return PORT_RE.sub(b"{LOOPBACK_EPHEMERAL_PORT}", body)


def route_semantics(path: str, body: bytes) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace")
    base = path.split("?", 1)[0]
    result: dict[str, Any] = {}
    if base == "/api/catalog":
        value = json.loads(text)
        result = {"json_type": "array", "count": len(value), "ids_sha256": sha256_bytes("\n".join(sorted(item["id"] for item in value)).encode())}
    elif base.startswith("/api/offline/"):
        value = json.loads(text)
        result = {"set": value.get("set"), "hash": value.get("hash"), "urls": len(value.get("urls", [])), "json_keys": sorted(value)}
    elif base.startswith(("/song/", "/sets/")):
        match = re.search(r"<title>(.*?)</title>", text, re.S | re.I)
        if match:
            result["html_title"] = re.sub(r"\s+", " ", match.group(1)).strip()
    return result


def http_get(host: str, port: int, path: str) -> tuple[int, bytes]:
    connection = http.client.HTTPConnection(host, port, timeout=20)
    try:
        connection.request("GET", path, headers=AUTH_HEADERS)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def capture_focus(host: str, port: int, path: str) -> dict[str, Any]:
    status, raw = http_get(host, port, path)
    normalized = normalized_body(raw)
    return {"status": status, "body_sha256": sha256_bytes(normalized), "body_bytes": len(normalized), "semantic": route_semantics(path, normalized)}


def choose_route_record(routes: dict[str, Any], record_id: str) -> dict[str, Any]:
    for record in routes["records"]:
        if record["id"] == record_id:
            return record["response"]
    raise RuntimeError(f"route baseline fixture {record_id} is absent")


def compare_focus(routes: dict[str, Any], captured: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for route_id, value in captured.items():
        expected = choose_route_record(routes, route_id)
        expected_semantic = expected.get("semantic", {})
        matches = value["status"] == expected["status"] and value["body_sha256"] == expected["body_sha256"] and value["semantic"] == expected_semantic
        output.append({"id": route_id, "status": value["status"], "body_sha256": value["body_sha256"], "semantic": value["semantic"], "matches_baseline": matches})
        if not matches:
            raise RuntimeError(f"focused route {route_id} differs from route baseline")
    return output


def choose_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def build_server(root: Path, work: Path, db_path: Path) -> tuple[subprocess.Popen[bytes], int]:
    binary = work / "songs-v1"
    env = os.environ.copy()
    env["GOPROXY"] = "off"
    result = subprocess.run(["go", "build", "-o", str(binary), "./cmd/srv"], cwd=root, env=env, capture_output=True)
    if result.returncode:
        detail = (result.stdout + result.stderr).decode("utf-8", errors="replace").strip()
        raise RuntimeError("tagged Go server build failed" + (f": {detail}" if detail else ""))
    port = choose_port()
    process = subprocess.Popen([str(binary), "-listen", f"127.0.0.1:{port}", "-repo", str(root), "-db", str(db_path)], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if process.poll() is not None:
            output = b"".join(process.communicate())
            raise RuntimeError("tagged Go server exited during startup" + (f": {output.decode(errors='replace').strip()}" if output else ""))
        try:
            status, _ = http_get("127.0.0.1", port, "/api/catalog")
            if status == 200:
                return process, port
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.1)
    stop_server(process)
    raise RuntimeError("tagged Go server readiness timeout")


def stop_server(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    try:
        process.communicate(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()


def detect_missing_canonical_file(root: Path, manifest: dict[str, Any]) -> bool:
    return not compare_corpus(root, manifest)


def detect_corrupt_sqlite_backup(path: Path) -> bool:
    try:
        evidence = sqlite_evidence(path)
        return not all(evidence[key] for key in ("quick_check", "integrity_check", "foreign_key_check"))
    except (sqlite3.DatabaseError, OSError):
        return True


def detect_corrupt_git_bundle(path: Path) -> bool:
    try:
        verify_bundle(path)
        with tempfile.TemporaryDirectory(prefix="bundle-check-") as clone_dir:
            subprocess.run(["git", "clone", "--quiet", str(path), str(Path(clone_dir) / "checkout")], check=True, capture_output=True)
        return False
    except (subprocess.CalledProcessError, OSError):
        return True


def detect_wrong_baseline(manifest: dict[str, Any], paths: dict[str, Path]) -> bool:
    try:
        validate_component_manifest(manifest, paths, {"ref": BASELINE_REF, "commit": BASELINE_COMMIT})
        return False
    except ValueError as exc:
        return str(exc) == "wrong baseline commit"


def detect_missing_component(manifest: dict[str, Any], paths: dict[str, Path]) -> bool:
    try:
        validate_component_manifest(manifest, paths, {"ref": BASELINE_REF, "commit": BASELINE_COMMIT})
        return False
    except ValueError as exc:
        return str(exc) == "missing backup component"


def failure_evidence(bundle: Path, backup: Path, source_root: Path, corpus: dict[str, Any], component: dict[str, Any], component_paths: dict[str, Path]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    missing = source_root / "songs" / "1979.md"
    saved = missing.read_bytes()
    missing.unlink()
    try:
        result["missing_canonical_file"] = detect_missing_canonical_file(source_root, corpus)
    finally:
        missing.write_bytes(saved)
    with tempfile.TemporaryDirectory(prefix="failure-") as directory:
        root = Path(directory)
        corrupted_db = root / "corrupt.sqlite3"
        shutil.copyfile(backup, corrupted_db)
        data = corrupted_db.read_bytes()
        corrupted_db.write_bytes(data[: max(1, len(data) // 2)])
        result["corrupt_sqlite_backup"] = detect_corrupt_sqlite_backup(corrupted_db)
        corrupted_bundle = root / "corrupt.bundle"
        shutil.copyfile(bundle, corrupted_bundle)
        data = bytearray(corrupted_bundle.read_bytes())
        corrupted_bundle.write_bytes(bytes(data[: max(1, len(data) // 2)]))
        result["corrupt_git_bundle"] = detect_corrupt_git_bundle(corrupted_bundle)
    wrong = dict(component)
    wrong["baseline"] = {"ref": BASELINE_REF, "commit": "0" * 40}
    result["wrong_baseline_commit"] = detect_wrong_baseline(wrong, component_paths)
    missing_component = {k: v for k, v in component.items() if k != "components"}
    missing_component["components"] = {"git_bundle": component["components"]["git_bundle"]}
    result["missing_backup_component"] = detect_missing_component(missing_component, component_paths)
    return result


def generate(repo_root: Path) -> str:
    verify_ref(repo_root)
    prior = verify_prior_artifacts(repo_root)
    corpus = load_json(repo_root / CORPUS_PATH)
    renderer = load_json(repo_root / RENDERER_PATH)
    routes = load_json(repo_root / ROUTE_PATH)
    work_temp = tempfile.TemporaryDirectory(prefix="v2-backup-restore-")
    work = Path(work_temp.name)
    first = second = None
    try:
        bundle = work / "v1.bundle"
        create_bundle(repo_root, bundle)
        source = work / "source"
        restored = work / "restored"
        archive_tree_from_bundle(bundle, source)
        verify_ref(source)
        source_corpus = verify_corpus(source, corpus)
        first_db = work / "source.sqlite3"
        first, first_port = build_server(source, work / "build-source", first_db)
        source_sqlite = sqlite_evidence(first_db)
        if source_sqlite["quick_check"] is not True or source_sqlite["integrity_check"] is not True or source_sqlite["foreign_key_check"] is not True:
            raise RuntimeError("source SQLite integrity verification failed")
        with sqlite3.connect(first_db) as source_connection:
            source_journal_mode = source_connection.execute("PRAGMA journal_mode").fetchone()[0].lower()
        if source_journal_mode != "wal":
            raise RuntimeError("source SQLite did not remain in WAL mode")
        backup = work / "online-backup.sqlite3"
        online_backup(first_db, backup)
        component = component_manifest({"git_bundle": bundle, "sqlite_online_backup": backup}, {"ref": BASELINE_REF, "commit": BASELINE_COMMIT}, source_sqlite["schema_hash"], source_sqlite["projection_hash"])
        validate_component_manifest(component, {"git_bundle": bundle, "sqlite_online_backup": backup}, {"ref": BASELINE_REF, "commit": BASELINE_COMMIT})
        stop_server(first); first = None
        archive_tree_from_bundle(bundle, restored)
        verify_ref(restored)
        if not compare_corpus(restored, corpus):
            raise RuntimeError("restored corpus does not match v1 manifest")
        restored_db = work / "restored.sqlite3"
        validate_component_manifest(component, {"git_bundle": bundle, "sqlite_online_backup": backup}, {"ref": BASELINE_REF, "commit": BASELINE_COMMIT})
        shutil.copyfile(backup, restored_db)
        restored_sqlite = sqlite_evidence(restored_db)
        if restored_sqlite["schema_hash"] != component["schema_hash"] or restored_sqlite["projection_hash"] != component["projection_hash"]:
            raise RuntimeError("restored SQLite semantic projection differs from online backup")
        if source_sqlite["projection_hash"] != restored_sqlite["projection_hash"]:
            raise RuntimeError("source/restored semantic projections differ")
        render_by_path = {item["path"]: item for item in renderer["corpus"]["renders"]}
        for row in restored_sqlite["projection"]["song_index"]:
            path, source_hash, html_hash = row[1], row[4], row[5]
            if corpus_records(corpus)[path]["sha256"] != source_hash or render_by_path[path]["source_sha256"] != source_hash or render_by_path[path]["rendered_html_sha256"] != html_hash:
                raise RuntimeError("restored rendered/source hash does not match renderer baseline")
        second, second_port = build_server(restored, work / "build-restored", restored_db)
        set_id = "2005-03-26-easter-pageant"
        captured = {
            "catalog": capture_focus("127.0.0.1", second_port, "/api/catalog"),
            "song/1979": capture_focus("127.0.0.1", second_port, "/song/1979"),
            f"set/{set_id}": capture_focus("127.0.0.1", second_port, f"/sets/{quote(set_id)}"),
            f"live/{set_id}": capture_focus("127.0.0.1", second_port, f"/sets/{quote(set_id)}/live"),
            f"offline/{set_id}": capture_focus("127.0.0.1", second_port, f"/api/offline/sets/{quote(set_id)}"),
        }
        focus = compare_focus(routes, captured)
        failures = failure_evidence(bundle, backup, source, corpus, component, {"git_bundle": bundle, "sqlite_online_backup": backup})
        if not all(failures.values()):
            raise RuntimeError("one or more fail-closed backup detections did not trigger")
        final_sqlite = {k: v for k, v in restored_sqlite.items() if k != "projection"}
        final_sqlite["projection_hash"] = restored_sqlite["projection_hash"]
        output = {
            "schema_version": SCHEMA_VERSION,
            "baseline": {"ref": BASELINE_REF, "commit": BASELINE_COMMIT},
            "generator": {"name": GENERATOR_NAME, "version": GENERATOR_VERSION, "command": GENERATOR_COMMAND},
            "prior_artifacts": prior,
            "drill": {
                "git_bundle": {"source_ref": BUNDLE_REF, "verified": True, "clean_checkouts": 2, "exact_tag_commit": True, "archive_file_mtimes_preserved": True},
                "online_backup": {"sqlite_connection_backup_api": True, "source_server_running_during_backup": True, "source_was_wal": True, "separate_backup_database": True, "ephemeral_manifest_sha256_values_verified": True, "raw_live_db_copy_used_as_backup": False},
                "restore_order": ["verify Git bundle", "restore clean tagged checkout", "verify online-backup component hashes", "restore database copy", "verify SQLite and semantic projection", "start tagged server", "verify focused routes"],
                "safety_properties": ["canonical songs/sets were not modified", "deployed services were not stopped", "restored content was not pushed", "no external network/provider calls", "machine paths, ports, timestamps, and ephemeral binary hashes omitted"],
            },
            "corpus": {**source_corpus, "restored_files_byte_for_byte": True, "manifest": str(CORPUS_PATH)},
            "sqlite": final_sqlite,
            "schema": {"schema_hash": restored_sqlite["schema_hash"], "schema_object_count": restored_sqlite["schema_object_count"], "migration_count": restored_sqlite["migration_count"], "song_index_count": restored_sqlite["song_index_count"], "set_index_count": restored_sqlite["set_index_count"], "page_size": restored_sqlite["page_size"], "page_count": restored_sqlite["page_count"]},
            "deterministic_hashes": {"schema_hash": restored_sqlite["schema_hash"], "semantic_projection_hash": restored_sqlite["projection_hash"], "renderer_baseline_output_sha256": load_json(repo_root / RENDERER_PATH)["verification"]["output_sha256"], "route_baseline_output_sha256": load_json(repo_root / ROUTE_PATH)["verification"]["output_sha256"]},
            "focused_routes": {"normalization_contract": "TASK-003: RFC3339 operational/build timestamps, temporary Shelley URL, and loopback ephemeral port normalized; Date/Content-Length/Last-Modified ignored", "records": focus},
            "failure_evidence": failures,
            "v1_operational_state": {"sqlite_role": "rebuildable index/cache", "has_draft_outbox_conflict_ledger": False, "critical_backup": "Git canonical Markdown and exact tag", "v2_durable_ledger_requirement": "V2 must provide durable server-side ledger backups for drafts, outbox, conflicts, and revisions", "unsynced_indexeddb_drafts": "require client export/recovery until synchronized"},
            "verification": {"record_count": 5, "output_sha256": None},
        }
        return render_with_verification(output)
    finally:
        stop_server(first)
        stop_server(second)
        work_temp.cleanup()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    output = (args.output or root / DEFAULT_OUTPUT).resolve()
    try:
        rendered = generate(root).encode("utf-8")
    except Exception as exc:
        print(f"backup/restore baseline generation failed: {exc}", file=sys.stderr)
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
