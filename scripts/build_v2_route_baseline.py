#!/usr/bin/env python3
"""Generate the deterministic HTTP route contract for the pinned v1 server.

The server and all fixtures are built from a fresh ``git archive v1`` export.
No working-tree corpus or server assets are read.  The generated document stores
compact body evidence (byte counts and hashes) rather than repeating every
canonical response body.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from http.client import HTTPResponse
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

BASELINE_REF = "v1"
BASELINE_COMMIT = "546f59b41d9e9bcf0e81b543c27900a31e26c9e6"
DEFAULT_OUTPUT = Path("migration/v2/routes/route-baseline.json")
SCHEMA_VERSION = "1"
GENERATOR_VERSION = "1"
AUTH_HEADERS = {"X-ExeDev-UserID": "v2-route-baseline", "X-ExeDev-Email": "klundstedt@industryvault.com"}
SELECTED_HEADERS = ("Content-Type", "Cache-Control", "Vary", "Location", "Allow", "Service-Worker-Allowed", "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy")
RFC3339_RE = re.compile(rb"\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b")
SHELLEY_RE = re.compile(rb"https://[^\"' <]+\.shelley\.exe\.xyz/new")
PORT_RE = re.compile(rb"(?<![0-9])127\.0\.0\.1:\d+(?![0-9])")
ROUTE_RE = re.compile(r'mux\.HandleFunc\("([^" ]+)\s+([^" ]+)"\s*,\s*([^,)]+)')
STATIC_RE = re.compile(r'mux\.Handle\("([^" ]+)"\s*,\s*(.+?)\)')
EXPECTED_ROUTE_KEYS = {
    "GET /{$}", "GET /songs", "GET /songs/new", "POST /songs", "GET /set-lists", "GET /about",
    "GET /song/{id}", "GET /sets/{id}", "GET /api/sets/{id}/markdown", "PUT /api/sets/{id}/markdown",
    "PUT /api/sets/{id}/order", "POST /api/sets/{id}/items", "DELETE /api/sets/{id}/items/{position}",
    "GET /sets/{id}/live", "GET /api/lyrics/search", "POST /api/lyrics/import", "GET /api/catalog",
    "GET /api/songs/{id}", "GET /api/songs/{id}/markdown", "PUT /api/songs/{id}/markdown", "GET /api/offline/sets/{id}",
    "POST /api/shelley/edit", "GET /api/shelley/jobs/{id}", "POST /api/reindex", "GET /manifest.webmanifest", "GET /sw.js", "* /static/",
}



def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def render_with_verification(value: dict[str, Any]) -> str:
    value["verification"]["output_sha256"] = None
    value["verification"]["output_sha256"] = sha256_bytes(canonical_json(value).encode())
    return canonical_json(value)


def verify_ref(repo_root: Path, ref: str = BASELINE_REF) -> None:
    actual = subprocess.check_output(["git", "-C", str(repo_root), "rev-parse", f"{ref}^{{commit}}"], text=True, stderr=subprocess.PIPE).strip()
    if actual != BASELINE_COMMIT:
        raise RuntimeError(f"{ref} resolves to {actual}, expected {BASELINE_COMMIT}")


def export_git_tree(repo_root: Path, ref: str = BASELINE_REF) -> tuple[tempfile.TemporaryDirectory[str], Path]:
    archive = subprocess.check_output(["git", "-C", str(repo_root), "archive", "--format=tar", ref], stderr=subprocess.PIPE)
    temporary = tempfile.TemporaryDirectory(prefix="v2-route-baseline-")
    destination = Path(temporary.name)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise RuntimeError(f"unsafe path in git archive: {member.name}")
            if not name.parts or member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError(f"non-regular archive entry: {member.name}")
            source = tar.extractfile(member)
            if source is None:
                raise RuntimeError(f"unable to read archive entry: {member.name}")
            target = destination.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())
            os.utime(target, (member.mtime, member.mtime))
    return temporary, destination


def parse_route_inventory(server_source: str) -> list[dict[str, Any]]:
    """Parse every Serve registration, including the static prefix."""
    routes: list[dict[str, Any]] = []
    for line_number, line in enumerate(server_source.splitlines(), 1):
        match = ROUTE_RE.search(line)
        if match:
            method, path, handler = match.groups()
            routes.append({"method": method, "path": path, "registration": "HandleFunc", "handler": handler.strip(), "line": line_number})
            continue
        match = STATIC_RE.search(line)
        if match:
            routes.append({"method": "*", "path": match.group(1), "registration": "Handle", "handler": match.group(2).strip(), "line": line_number})
    return routes


def validate_route_inventory(routes: list[dict[str, Any]]) -> None:
    keys = [f'{route["method"]} {route["path"]}' for route in routes]
    if len(keys) != len(set(keys)):
        duplicates = sorted(key for key in set(keys) if keys.count(key) > 1)
        raise RuntimeError(f"duplicate route registrations: {duplicates}")
    actual = set(keys)
    if actual != EXPECTED_ROUTE_KEYS:
        missing = sorted(EXPECTED_ROUTE_KEYS - actual)
        additions = sorted(actual - EXPECTED_ROUTE_KEYS)
        raise RuntimeError(f"route inventory drift: missing={missing} additions={additions}")


def classify_route(route: dict[str, Any]) -> dict[str, Any]:
    method, path = route["method"], route["path"]
    key = f"{method} {path}"
    read = {
        "GET /{$}": ("read", ["root"]), "GET /songs": ("read", ["library"]), "GET /songs/new": ("read", ["new-song"]),
        "GET /set-lists": ("read", ["set-list"]), "GET /about": ("read", ["about"]), "GET /song/{id}": ("read", ["song"]),
        "GET /sets/{id}": ("read", ["set"]), "GET /sets/{id}/live": ("read", ["live"]),
        "GET /api/catalog": ("read", ["catalog"]), "GET /api/songs/{id}": ("read", ["song-json"]),
        "GET /api/songs/{id}/markdown": ("read-authenticated", ["song-markdown"]),
        "GET /api/sets/{id}/markdown": ("read-authenticated", ["set-markdown"]),
        "GET /api/offline/sets/{id}": ("read", ["offline"]),
        "GET /api/shelley/jobs/{id}": ("read-authenticated", ["shelley-job-unknown"]),
        "GET /api/lyrics/search": ("provider-boundary", ["provider-invalid-query"]),
        "GET /manifest.webmanifest": ("static", ["manifest"]), "GET /sw.js": ("static", ["service-worker"]),
        "* /static/": ("static", ["static-prefix"]),
    }
    excluded = {
        "POST /songs": ("mutation-excluded", "mutation-create-song", "probe-create-song"),
        "PUT /api/sets/{id}/markdown": ("mutation-excluded", "mutation-update-set-markdown", "probe-update-set-markdown"),
        "PUT /api/sets/{id}/order": ("mutation-excluded", "mutation-update-set-order", "probe-update-set-order"),
        "POST /api/sets/{id}/items": ("mutation-excluded", "mutation-add-set-item", "probe-add-set-item"),
        "DELETE /api/sets/{id}/items/{position}": ("mutation-excluded", "mutation-delete-set-item", "probe-delete-set-item"),
        "POST /api/lyrics/import": ("provider-excluded", "provider-import", "probe-lyrics-import"),
        "PUT /api/songs/{id}/markdown": ("mutation-excluded", "mutation-update-song-markdown", "probe-update-song-markdown"),
        "POST /api/shelley/edit": ("provider-excluded", "shelley-llm-edit", "probe-shelley-edit"),
        "POST /api/reindex": ("mutation-excluded", "mutation-reindex", "probe-reindex"),
    }
    if key in read:
        classification, fixtures = read[key]
        exclusion = None
        if key == "GET /api/lyrics/search":
            exclusion = {"id": "provider-valid-search", "reason": "valid query execution is excluded because it contacts a remote lyrics provider"}
        return {**route, "classification": classification, "fixture_ids": fixtures, "exclusion": exclusion}
    if key in excluded:
        classification, exclusion, safe_probe = excluded[key]
        return {**route, "classification": classification, "fixture_ids": [], "exclusion": {"id": exclusion, "reason": "not executed destructively or remotely", "safe_probe_id": safe_probe}}
    raise RuntimeError(f"unclassified route registration: {key}")


def normalized_body(body: bytes) -> bytes:
    """Normalize only build time, temporary endpoint, and generated Shelley URL."""
    body = RFC3339_RE.sub(b"{RFC3339_BUILD_TIME}", body)
    body = SHELLEY_RE.sub(b"{SHELLEY_URL}", body)
    body = PORT_RE.sub(b"{LOOPBACK_EPHEMERAL_PORT}", body)
    return body


def selected_headers(headers: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for name in SELECTED_HEADERS:
        value = headers.get(name)
        if value is not None:
            result[name] = " ".join(value.split())
    return result


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: HTTPResponse, code: int, msg: str, headers: Any) -> None:
        return None

    def http_error_302(self, req: Request, fp: HTTPResponse, code: int, msg: str, headers: Any) -> HTTPResponse:
        return fp
    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302
    http_error_308 = http_error_302


def capture_response(opener: Any, base_url: str, path: str, method: str = "GET", headers: dict[str, str] | None = None, body: bytes | None = None) -> dict[str, Any]:
    request = Request(base_url + path, data=body, method=method, headers=headers or {})
    try:
        response = opener.open(request, timeout=20)
        status = response.status
        response_headers = selected_headers(response.headers)
        raw = response.read()
    except Exception as exc:
        # urllib raises HTTPError for ordinary 4xx/5xx; preserve its response.
        if not hasattr(exc, "code") or not hasattr(exc, "read"):
            raise RuntimeError(f"request failed {method} {path}: {exc}") from exc
        status = int(exc.code)
        response_headers = selected_headers(exc.headers)
        raw = exc.read()
    normalized = normalized_body(raw)
    result: dict[str, Any] = {
        "method": method,
        "path": path,
        "status": status,
        "headers": response_headers,
        "body_bytes": len(raw),
        "normalized_body_bytes": len(normalized),
        "body_sha256": sha256_bytes(normalized),
    }
    semantic = semantic_fields(path, raw, status)
    if semantic:
        result["semantic"] = semantic
    return result


def semantic_fields(path: str, body: bytes, status: int) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    text = body.decode("utf-8", errors="replace")
    base_path = path.split("?", 1)[0]
    if base_path == "/api/catalog":
        try:
            value = json.loads(text)
            ids = sorted(item.get("id", "") for item in value)
            fields.update({"json_type": "array", "count": len(value), "ids_sha256": sha256_bytes("\n".join(ids).encode())})
        except json.JSONDecodeError:
            fields["json_type"] = "invalid"
    elif base_path.startswith("/api/") or base_path.endswith("/manifest.webmanifest"):
        try:
            value = json.loads(text)
            if isinstance(value, dict):
                for key in ("id", "set", "title", "hash", "urls", "ok"):
                    if key in value:
                        item = value[key]
                        fields[key] = len(item) if key == "urls" and isinstance(item, list) else item
                fields["json_keys"] = sorted(value)
            elif isinstance(value, list):
                fields["json_type"] = "array"
        except json.JSONDecodeError:
            pass
    if base_path == "/sw.js":
        cache_match = re.search(r"CACHE = '([^']+)'", text)
        fields.update({"has_install": "addEventListener('install'" in text, "has_fetch": "addEventListener('fetch'" in text, "cache_name": cache_match.group(1) if cache_match else None})
    if base_path.startswith(("/song/", "/sets/")) or base_path in ("/", "/songs", "/songs/new", "/set-lists", "/about"):
        title_match = re.search(r"<title>(.*?)</title>", text, re.S | re.I)
        if title_match:
            fields["html_title"] = re.sub(r"\s+", " ", title_match.group(1)).strip()
    if base_path in ("/", "/songs"):
        song_ids = sorted(re.findall(r'href="/song/([^"/?#]+)"', text))
        fields["song_link_count"] = len(song_ids)
        fields["song_ids_sha256"] = sha256_bytes("\n".join(song_ids).encode())
    if base_path == "/set-lists":
        set_ids = sorted(re.findall(r'href="/sets/([^"/?#]+)"', text))
        fields["set_link_count"] = len(set_ids)
        fields["set_ids_sha256"] = sha256_bytes("\n".join(set_ids).encode())
    if base_path == "/songs/new":
        draft_match = re.search(r'<input name="title" value="([^"]*)"', text)
        if draft_match:
            fields["draft_title"] = draft_match.group(1)
    if base_path.startswith("/static/"):
        fields["asset_path"] = base_path
    return fields


def slugify(value: str) -> str:
    out: list[str] = []
    dash = False
    for char in value.lower():
        if char.isalnum():
            out.append(char); dash = False
        elif not dash and out:
            out.append("-"); dash = True
    return "".join(out).strip("-")


def corpus_ids(root: Path) -> tuple[list[str], list[str]]:
    songs = sorted(slugify(p.stem) for p in (root / "songs").glob("*.md"))
    sets = sorted(slugify(p.stem) for p in (root / "sets").glob("*.md"))
    return songs, sets


def source_hashes(root: Path) -> dict[str, str]:
    paths = [p for p in root.rglob("*") if p.is_file() and (p.parts[-2:] in [("srv", "server.go"), ("srv", "server_test.go")] or p.as_posix().endswith(("cmd/srv/main.go", "db/db.go", "db/migrations/001-base.sql", "go.mod", "go.sum")))]
    # Include deterministic source files, but no operational output or paths.
    paths = sorted(paths, key=lambda p: p.relative_to(root).as_posix())
    return {p.relative_to(root).as_posix(): sha256_bytes(p.read_bytes()) for p in paths}


def asset_hashes(root: Path) -> dict[str, str]:
    paths = sorted([p for p in (root / "srv" / "static").iterdir() if p.is_file()], key=lambda p: p.name)
    paths += sorted([p for p in (root / "srv" / "templates").iterdir() if p.is_file()], key=lambda p: p.name)
    return {p.relative_to(root).as_posix(): sha256_bytes(p.read_bytes()) for p in paths}


def apex_identity() -> dict[str, str]:
    path = shutil.which("apex")
    if not path:
        raise RuntimeError("Apex executable not found on PATH")
    executable = Path(path).resolve()
    version = subprocess.run([str(executable), "--version"], capture_output=True, check=False)
    if version.returncode:
        raise RuntimeError(f"apex --version failed: {(version.stdout + version.stderr).decode(errors='replace').strip()}")
    return {"version": (version.stdout + version.stderr).decode(errors="replace").replace("\r", "").strip(), "sha256": sha256_bytes(executable.read_bytes())}


def build_and_start(root: Path, work: Path) -> tuple[subprocess.Popen[bytes], str, str]:
    binary = work / "songs-v1"
    env = os.environ.copy(); env["GOPROXY"] = "off"
    build = subprocess.run(["go", "build", "-o", str(binary), "./cmd/srv"], cwd=root, env=env, capture_output=True)
    if build.returncode:
        raise RuntimeError("tagged Go server build failed:\n" + (build.stdout + build.stderr).decode(errors="replace"))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
    db_path = work / "isolated.sqlite3"
    proc = subprocess.Popen([str(binary), "-listen", f"127.0.0.1:{port}", "-repo", str(root), "-db", str(db_path)], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    base = f"http://127.0.0.1:{port}"
    opener = build_opener(NoRedirect())
    deadline = time.monotonic() + 45
    logs = b""
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            out, err = proc.communicate(); logs = out + err
            raise RuntimeError("tagged server exited during startup:\n" + logs.decode(errors="replace"))
        try:
            capture_response(opener, base, "/api/catalog")
            return proc, base, f"{port}"
        except Exception:
            time.sleep(0.1)
    proc.terminate()
    out, err = proc.communicate(timeout=5)
    raise RuntimeError("tagged server readiness timeout:\n" + (out + err).decode(errors="replace"))


def stop_server(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(timeout=5)
    # Drain pipes so child resources are always released.
    try:
        proc.communicate(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill(); proc.communicate()


def request_cases(songs: list[str], sets: list[str]) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for song in songs:
        cases.extend([{"id": f"song/{song}", "route": "song", "method": "GET", "path": f"/song/{quote(song, safe='')}"}, {"id": f"song-json/{song}", "route": "song-json", "method": "GET", "path": f"/api/songs/{quote(song, safe='')}"}, {"id": f"song-markdown/{song}", "route": "song-markdown", "method": "GET", "path": f"/api/songs/{quote(song, safe='')}/markdown", "auth": True}])
    for set_id in sets:
        cases.extend([{"id": f"set/{set_id}", "route": "set", "method": "GET", "path": f"/sets/{quote(set_id, safe='')}"}, {"id": f"live/{set_id}", "route": "live", "method": "GET", "path": f"/sets/{quote(set_id, safe='')}/live"}, {"id": f"set-markdown/{set_id}", "route": "set-markdown", "method": "GET", "path": f"/api/sets/{quote(set_id, safe='')}/markdown", "auth": True}, {"id": f"offline/{set_id}", "route": "offline", "method": "GET", "path": f"/api/offline/sets/{quote(set_id, safe='')}"}])
    fixed = [
        ("root", "/"),
        ("library", "/songs"),
        ("new-song", "/songs/new"),
        ("new-song-query", "/songs/new?title=Route+Fixture"),
        ("set-list", "/set-lists"),
        ("about", "/about"),
        ("catalog", "/api/catalog"),
        ("manifest", "/manifest.webmanifest"),
        ("service-worker", "/sw.js"),
        ("static-app", "/static/app.js"),
        ("static-icon", "/static/icon.svg"),
        ("static-style", "/static/style.css"),
    ]
    cases.extend({"id": i, "route": i, "method": "GET", "path": p} for i, p in fixed)
    # Edge behavior is intentionally small and deterministic; the regular mux
    # cases above remain the source of truth for canonical counts.
    edges = [
        ("edge-missing-song", "/song/no-such-song"),
        ("edge-missing-set", "/sets/no-such-set"),
        ("edge-missing-asset", "/static/no-such-asset.css"),
        ("edge-case-sensitive-song", "/song/6TH-AVENUE-HEARTACHE"),
        ("edge-filename-song", "/song/1979.md"),
        ("edge-encoded-song", "/song/%31%39%37%39"),
        ("edge-trailing-root", "/songs/"),
        ("edge-trailing-song", "/song/1979/"),
        ("edge-trailing-set", "/sets/2005-03-26-easter-pageant/"),
        ("edge-query-song", "/song/1979?x=1"),
        ("edge-duplicate-slash", "//song//1979"),
        ("edge-static-no-slash", "/static"),
        ("edge-static-root", "/static/"),
        ("edge-alias-sets", "/sets"),
        ("edge-alias-live", "/live"),
        ("edge-alias-song", "/song"),
        ("edge-head", "/song/1979"),
        ("edge-unsupported", "/song/1979"),
    ]
    cases.extend({"id": i, "route": "edge", "method": "HEAD" if i == "edge-head" else ("POST" if i == "edge-unsupported" else "GET"), "path": p} for i, p in edges)
    cases.extend([
        {
            "id": "edge-song-markdown-unauthenticated",
            "route": "edge",
            "method": "GET",
            "path": "/api/songs/1979/markdown",
        },
        {
            "id": "edge-set-markdown-unauthenticated",
            "route": "edge",
            "method": "GET",
            "path": f"/api/sets/{quote(sets[0], safe='')}/markdown",
        },
        {
            "id": "edge-shelley-job-unauthenticated",
            "route": "edge",
            "method": "GET",
            "path": "/api/shelley/jobs/unknown-job",
        },
        {
            "id": "edge-lyrics-search-unauthenticated",
            "route": "edge",
            "method": "GET",
            "path": "/api/lyrics/search?q=x",
        },
    ])
    # Safe unauthenticated probes only: no mutation reaches its handler.
    cases.extend({"id": i, "route": "safe-mutation-probe", "method": method, "path": p} for i, method, p in [
        ("probe-create-song", "POST", "/songs"),
        ("probe-update-set-markdown", "PUT", "/api/sets/no-such-set/markdown"),
        ("probe-update-set-order", "PUT", "/api/sets/no-such-set/order"),
        ("probe-add-set-item", "POST", "/api/sets/no-such-set/items"),
        ("probe-delete-set-item", "DELETE", "/api/sets/no-such-set/items/1"),
        ("probe-lyrics-import", "POST", "/api/lyrics/import"),
        ("probe-update-song-markdown", "PUT", "/api/songs/no-such-song/markdown"),
        ("probe-shelley-edit", "POST", "/api/shelley/edit"),
        ("probe-reindex", "POST", "/api/reindex"),
    ])
    cases.append({"id": "provider-invalid-query", "route": "provider-boundary", "method": "GET", "path": "/api/lyrics/search?" + urlencode({"q": "x"}), "auth": True})
    cases.append({"id": "shelley-job-unknown", "route": "shelley-job-unknown", "method": "GET", "path": "/api/shelley/jobs/unknown-job", "auth": True})
    return cases


def validate_record_contract(records: list[dict[str, Any]], songs: list[str], sets: list[str]) -> dict[str, Any]:
    by_id = {record["id"]: record for record in records}
    if len(by_id) != len(records):
        raise RuntimeError("duplicate request case IDs")

    canonical_prefixes = ("song/", "song-json/", "song-markdown/", "set/", "live/", "set-markdown/", "offline/")
    canonical = [record for record in records if record["id"].startswith(canonical_prefixes)]
    failures = [f'{record["id"]}={record["response"]["status"]}' for record in canonical if record["response"]["status"] != 200]
    if failures:
        raise RuntimeError(f"canonical route failures: {failures[:10]}")

    song_ids_hash = sha256_bytes("\n".join(songs).encode())
    set_ids_hash = sha256_bytes("\n".join(sets).encode())
    for case_id in ("root", "library"):
        semantic = by_id[case_id]["response"].get("semantic", {})
        if semantic.get("song_link_count") != 291 or semantic.get("song_ids_sha256") != song_ids_hash:
            raise RuntimeError(f"{case_id} does not expose the exact canonical song library")
    set_semantic = by_id["set-list"]["response"].get("semantic", {})
    if set_semantic.get("set_link_count") != 60 or set_semantic.get("set_ids_sha256") != set_ids_hash:
        raise RuntimeError("set-list does not expose the exact canonical Set List library")
    catalog_semantic = by_id["catalog"]["response"].get("semantic", {})
    if catalog_semantic.get("count") != 291 or catalog_semantic.get("ids_sha256") != song_ids_hash:
        raise RuntimeError("catalog IDs differ from the canonical tagged song IDs")
    if by_id["new-song-query"]["response"].get("semantic", {}).get("draft_title") != "Route Fixture":
        raise RuntimeError("new-song query no longer seeds the draft title")

    fixed_200 = {
        "root", "library", "new-song", "new-song-query", "set-list", "about", "catalog",
        "manifest", "service-worker", "static-app", "static-icon", "static-style",
        "edge-encoded-song", "edge-query-song", "edge-head", "edge-static-root",
    }
    for case_id in fixed_200:
        if by_id[case_id]["response"]["status"] != 200:
            raise RuntimeError(f"{case_id} status drifted from 200")
    expected_statuses = {
        "edge-missing-song": 404,
        "edge-missing-set": 404,
        "edge-missing-asset": 404,
        "edge-case-sensitive-song": 404,
        "edge-filename-song": 404,
        "edge-trailing-root": 404,
        "edge-trailing-song": 404,
        "edge-trailing-set": 404,
        "edge-duplicate-slash": 307,
        "edge-static-no-slash": 307,
        "edge-alias-sets": 404,
        "edge-alias-live": 404,
        "edge-alias-song": 404,
        "edge-unsupported": 405,
        "edge-song-markdown-unauthenticated": 401,
        "edge-set-markdown-unauthenticated": 401,
        "edge-shelley-job-unauthenticated": 401,
        "edge-lyrics-search-unauthenticated": 401,
        "provider-invalid-query": 400,
        "shelley-job-unknown": 404,
    }
    for case_id, expected in expected_statuses.items():
        if by_id[case_id]["response"]["status"] != expected:
            raise RuntimeError(f"{case_id} status drifted from {expected}")
    if by_id["edge-duplicate-slash"]["response"]["headers"].get("Location") != "/song/1979":
        raise RuntimeError("duplicate-slash redirect target drifted")
    if by_id["edge-static-no-slash"]["response"]["headers"].get("Location") != "/static/":
        raise RuntimeError("static-prefix redirect target drifted")
    if by_id["edge-unsupported"]["response"]["headers"].get("Allow") != "GET, HEAD":
        raise RuntimeError("unsupported-method Allow header drifted")

    probes = [record for record in records if record["route"] == "safe-mutation-probe"]
    if len(probes) != 9 or any(record["response"]["status"] != 401 for record in probes):
        raise RuntimeError("safe mutation probes must remain nine unauthenticated 401 responses")
    for record in records:
        if record["route"] in {"song-markdown", "set-markdown"}:
            headers = record["response"]["headers"]
            if headers.get("Cache-Control") != "no-store" or headers.get("Vary") != "X-ExeDev-UserID":
                raise RuntimeError(f'{record["id"]} lost authenticated Markdown cache controls')
    if by_id["service-worker"]["response"]["headers"].get("Service-Worker-Allowed") != "/":
        raise RuntimeError("service-worker scope header drifted")

    return {
        "canonical_statuses_ok": True,
        "library_ids_match_tagged_corpus": True,
        "safe_mutation_probes": len(probes),
        "edge_case_count": sum(record["route"] == "edge" for record in records),
    }


def generate(repo_root: Path) -> str:
    verify_ref(repo_root)
    temporary, root = export_git_tree(repo_root)
    server_proc: subprocess.Popen[bytes] | None = None
    try:
        source = (root / "srv/server.go").read_text(encoding="utf-8")
        parsed_inventory = parse_route_inventory(source)
        validate_route_inventory(parsed_inventory)
        inventory = [classify_route(r) for r in parsed_inventory]
        if len(inventory) != len(EXPECTED_ROUTE_KEYS):
            raise RuntimeError(f"unexpected tagged route count: {len(inventory)}")
        songs, sets = corpus_ids(root)
        if (len(songs), len(sets)) != (291, 60):
            raise RuntimeError(f"unexpected tagged corpus counts: songs={len(songs)} sets={len(sets)}")
        work = Path(tempfile.mkdtemp(prefix="v2-route-runtime-"))
        try:
            server_proc, base, _port = build_and_start(root, work)
            opener = build_opener(NoRedirect())
            cases = request_cases(songs, sets)
            records: list[dict[str, Any]] = []
            for case in cases:
                headers = dict(AUTH_HEADERS) if case.get("auth") else {}
                captured = capture_response(opener, base, case["path"], case["method"], headers)
                records.append({**case, "response": captured})
            contract_validation = validate_record_contract(records, songs, sets)
            canonical = [r for r in records if r["id"].startswith(("song/", "song-json/", "song-markdown/", "set/", "live/", "set-markdown/", "offline/"))]
            families: dict[str, dict[str, Any]] = {}
            for route in sorted({r["route"] for r in canonical}):
                subset = [r for r in canonical if r["route"] == route]
                status_distribution = {
                    str(status): sum(record["response"]["status"] == status for record in subset)
                    for status in sorted({record["response"]["status"] for record in subset})
                }
                families[route] = {
                    "record_count": len(subset),
                    "status_distribution": status_distribution,
                    "aggregate_record_hash": sha256_bytes(canonical_json(subset).encode()),
                }
            for route, expected in {"song": 291, "song-json": 291, "song-markdown": 291, "set": 60, "live": 60, "set-markdown": 60, "offline": 60}.items():
                if families[route]["record_count"] != expected:
                    raise RuntimeError(f"family count mismatch for {route}")
            classifications = {f'{r["method"]} {r["path"]}': {"classification": r["classification"], "fixture_ids": r["fixture_ids"], "exclusion": r["exclusion"]} for r in inventory}
            coverage = {"registered_route_count": len(inventory), "classified_route_count": len(classifications), "routes_with_fixtures": sum(bool(r["fixture_ids"]) for r in inventory), "routes_with_exclusions": sum(r["exclusion"] is not None for r in inventory), "unclassified_routes": [], "canonical_request_count": len(canonical), "request_case_count": len(records)}
            output: dict[str, Any] = {
                "schema_version": SCHEMA_VERSION, "baseline": {"ref": BASELINE_REF, "commit": BASELINE_COMMIT},
                "generator": {"name": "scripts/build_v2_route_baseline.py", "version": GENERATOR_VERSION, "command": "python3 scripts/build_v2_route_baseline.py"},
                "server": {"go_version": subprocess.check_output(["go", "version"], text=True).strip(), "apex": apex_identity(), "startup": {"renders": True, "isolated_db": True, "loopback_only": True, "automatic_redirects": False}},
                "corpus": {"song_count": len(songs), "set_count": len(sets), "song_ids_sha256": sha256_bytes("\n".join(songs).encode()), "set_ids_sha256": sha256_bytes("\n".join(sets).encode())},
                "source_hashes": source_hashes(root), "asset_hashes": asset_hashes(root),
                "normalization": {
                    "replaced": [
                        "RFC3339 operational/build timestamps",
                        "temporary Shelley URL hostname",
                        "loopback ephemeral port",
                    ],
                    "archive_file_mtimes": "preserved from git archive for deterministic server metadata",
                    "ignored_headers": ["Date", "Content-Length", "Last-Modified"],
                },
                "request_profile": {
                    "loopback_only": True,
                    "automatic_redirects": False,
                    "authenticated_headers": AUTH_HEADERS,
                    "remote_provider_calls": False,
                },
                "route_inventory": inventory,
                "families": families,
                "coverage": coverage,
                "contract_validation": contract_validation,
                "summary": {
                    "request_case_count": len(records),
                    "canonical_request_count": len(canonical),
                    "edge_case_count": contract_validation["edge_case_count"],
                    "safe_mutation_probe_count": contract_validation["safe_mutation_probes"],
                    "exclusion_count": sum(r["exclusion"] is not None for r in inventory),
                },
                "exclusions": [r["exclusion"] | {"route": f'{r["method"]} {r["path"]}'} for r in inventory if r["exclusion"]],
                "edge_findings": {
                    "redirect_following": "disabled",
                    "tested": [
                        "trailing slashes",
                        "missing IDs/assets",
                        "filename-vs-ID",
                        "case sensitivity",
                        "encoded IDs",
                        "old aliases",
                        "query handling and new-song seeding",
                        "authenticated-route boundaries",
                        "HEAD",
                        "unsupported methods",
                        "static prefix and directory behavior",
                        "duplicate slashes",
                    ],
                    "notes": "Go ServeMux path cleaning and method behavior are retained as captured; no redirects are followed.",
                },
                "records": sorted(records, key=lambda r: r["id"]), "verification": {"record_count": len(records), "output_sha256": None},
            }
            return render_with_verification(output)
        finally:
            if server_proc is not None:
                stop_server(server_proc)
            shutil.rmtree(work, ignore_errors=True)
    finally:
        temporary.cleanup()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parents[1]
    output = (args.output or repo_root / DEFAULT_OUTPUT).resolve()
    try:
        rendered = generate(repo_root).encode("utf-8")
    except Exception as exc:
        print(f"route baseline generation failed: {exc}", file=sys.stderr)
        return 1
    if args.check:
        if not output.exists() or output.read_bytes() != rendered:
            print(f"{output}: generated output differs", file=sys.stderr); return 1
        print(f"{output}: OK"); return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.exists() or output.read_bytes() != rendered:
        output.write_bytes(rendered); print(f"wrote {output}")
    else:
        print(f"unchanged {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
