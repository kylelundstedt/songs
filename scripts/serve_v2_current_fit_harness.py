#!/usr/bin/env python3
"""Serve the exact current app plus a loopback recorder for fit captures."""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT, load_script


class Recorder(BaseHTTPRequestHandler):
    output: Path
    data: bytes
    app_url: str

    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/data.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(self.data)))
            self.cors()
            self.end_headers()
            self.wfile.write(self.data)
            return
        try:
            response = urlopen(Request(self.app_url + self.path, method="GET"), timeout=30)
            status = response.status
            headers = response.headers
            raw = response.read()
        except HTTPError as exc:
            status = exc.code
            headers = exc.headers
            raw = exc.read()
        except Exception as exc:
            self.send_error(502, str(exc))
            return
        self.send_response(status)
        for name in ("Content-Type", "Cache-Control", "Vary", "Service-Worker-Allowed"):
            value = headers.get(name)
            if value is not None:
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        prefix = "/__observations/"
        if not self.path.startswith(prefix) or not self.path.endswith(".json"):
            self.send_error(404)
            return
        profile = self.path[len(prefix):-5]
        if profile not in {"ipad-portrait", "ipad-landscape", "phone"}:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if length < 0 or length > 10_000_000:
                raise ValueError("invalid Content-Length")
            raw = self.rfile.read(length)
            value = json.loads(raw.decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("capture must be an object")
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        self.output.mkdir(parents=True, exist_ok=True)
        target = self.output / f"{profile}.json"
        target.write_bytes(raw)
        response = json.dumps({"stored": target.name}, separators=(",", ":")).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.cors()
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"recorder: {fmt % args}", flush=True)


def wait_ready(url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError((stdout + stderr).decode(errors="replace"))
        try:
            with urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("current app readiness timeout")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-port", type=int, default=8767)
    parser.add_argument("--recorder-port", type=int, default=8768)
    parser.add_argument("--output-dir", type=Path, default=CURRENT_ROOT / "renderer/browser-fit")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    corpus = json.loads((repo / CURRENT_ROOT / "corpus-manifest.json").read_text(encoding="utf-8"))
    songs = [
        {
            "id": record["legacy_slug"].lower(),
            "title": record["title"],
            "path": record["path"],
            "source_hash": record["sha256"],
        }
        for record in corpus["records"] if record["kind"] == "song"
    ]
    Recorder.data = (json.dumps({"baseline": corpus["baseline"], "songs": songs}, ensure_ascii=False) + "\n").encode("utf-8")
    Recorder.output = (repo / args.output_dir).resolve() if not args.output_dir.is_absolute() else args.output_dir.resolve()

    exporter = load_script(repo, "build_v2_route_baseline.py", "v2_current_fit_export")
    exporter.BASELINE_REF = CURRENT_REF
    exporter.BASELINE_COMMIT = CURRENT_COMMIT
    exporter.verify_ref(repo)
    temporary, source_root = exporter.export_git_tree(repo)
    process: subprocess.Popen[bytes] | None = None
    recorder: ThreadingHTTPServer | None = None
    try:
        work = Path(temporary.name) / ".fit-runtime"
        work.mkdir()
        binary = work / "songs-current"
        environment = os.environ.copy()
        environment["GOPROXY"] = "off"
        build = subprocess.run(["go", "build", "-o", str(binary), "./cmd/srv"], cwd=source_root, env=environment, capture_output=True)
        if build.returncode:
            raise RuntimeError((build.stdout + build.stderr).decode(errors="replace"))
        process = subprocess.Popen(
            [str(binary), "-listen", f"127.0.0.1:{args.app_port}", "-repo", str(source_root), "-db", str(work / "songs.sqlite3")],
            cwd=source_root,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        app_url = f"http://127.0.0.1:{args.app_port}"
        wait_ready(app_url + "/api/catalog", process)
        Recorder.app_url = app_url
        recorder = ThreadingHTTPServer(("127.0.0.1", args.recorder_port), Recorder)
        print(f"app={app_url}", flush=True)
        print(f"recorder=http://127.0.0.1:{args.recorder_port}", flush=True)
        recorder.serve_forever()
    finally:
        if recorder is not None:
            recorder.server_close()
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        temporary.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
