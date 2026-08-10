#!/usr/bin/env python3
"""Serve the frozen v1 app and a synthetic V2 origin for isolation probes."""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from v2_current_config import CURRENT_COMMIT, CURRENT_REF, CURRENT_ROOT, load_script


class ObservationHandler(BaseHTTPRequestHandler):
    role: str
    output: Path

    def save_observation(self) -> None:
        if self.path != "/__observation.json":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if length < 0 or length > 1_000_000:
                raise ValueError("invalid Content-Length")
            raw = self.rfile.read(length)
            value = json.loads(raw.decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("observation must be an object")
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_bytes(raw)
        response = json.dumps({"stored": self.output.name}, separators=(",", ":")).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_POST(self) -> None:
        self.save_observation()

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.role}: {fmt % args}", flush=True)


def v1_proxy(app_url: str, output: Path):
    class V1Handler(ObservationHandler):
        role = "v1"

        def do_GET(self) -> None:
            try:
                response = urlopen(Request(app_url + self.path, method="GET"), timeout=30)
                status, headers, raw = response.status, response.headers, response.read()
            except HTTPError as exc:
                status, headers, raw = exc.code, exc.headers, exc.read()
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

    V1Handler.output = output
    return V1Handler


def v2_probe(output: Path):
    cache_name = "songs-v2-shell-coexistence-v1"
    database_name = "songs-v2"

    class V2Handler(ObservationHandler):
        role = "v2"

        def do_GET(self) -> None:
            if self.path.startswith("/sw.js"):
                raw = (
                    f"const CACHE={cache_name!r};"
                    "self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.put('/worker-marker',new Response('ok'))).then(()=>self.skipWaiting())));"
                    "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"
                    "self.addEventListener('fetch',()=>{});"
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Service-Worker-Allowed", "/")
            else:
                config = json.dumps({"role": "v2", "cache": cache_name, "database": database_name})
                raw = f"""<!doctype html><meta charset=utf-8><title>v2 coexistence reservation probe</title>
<script>
const config={config};
function openDB(){{return new Promise((resolve,reject)=>{{const r=indexedDB.open(config.database,1);r.onupgradeneeded=()=>r.result.createObjectStore('markers');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}})}}
async function run(){{
 const registration=await navigator.serviceWorker.register('/sw.js',{{scope:'/'}});await navigator.serviceWorker.ready;
 await new Promise(resolve=>{{if(navigator.serviceWorker.controller)return resolve();const timer=setTimeout(resolve,1500);navigator.serviceWorker.addEventListener('controllerchange',()=>{{clearTimeout(timer);resolve();}},{{once:true}});}});
 const cache=await caches.open(config.cache);await cache.put('/page-marker',new Response(config.role));
 const db=await openDB();const tx=db.transaction('markers','readwrite');tx.objectStore('markers').put(config.role,'role');await new Promise((resolve,reject)=>{{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);}});db.close();
 const databases=indexedDB.databases?await indexedDB.databases():[];
 return {{role:config.role,origin:location.origin,implementation:'synthetic-v2-reservation',service_worker:{{scope:registration.scope,script_url:registration.active?.scriptURL||null,controlled:Boolean(navigator.serviceWorker.controller)}},cache_names:(await caches.keys()).sort(),database_names:databases.map(x=>x.name).filter(Boolean).sort(),expected:{{cache:config.cache,database:config.database}}}};
}}
window.OriginProbe={{run}};
</script><h1>V2 coexistence reservation probe</h1>""".encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    V2Handler.output = output
    return V2Handler


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
    raise RuntimeError("frozen v1 app readiness timeout")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v1-app-port", type=int, default=8769)
    parser.add_argument("--v1-port", type=int, default=8770)
    parser.add_argument("--v2-port", type=int, default=8771)
    parser.add_argument("--output-dir", type=Path, default=CURRENT_ROOT / "coexistence/browser-observations")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = (repo / args.output_dir).resolve() if not args.output_dir.is_absolute() else args.output_dir.resolve()

    exporter = load_script(repo, "build_v2_route_baseline.py", "v2_coexistence_export")
    exporter.BASELINE_REF = CURRENT_REF
    exporter.BASELINE_COMMIT = CURRENT_COMMIT
    exporter.verify_ref(repo)
    temporary, source_root = exporter.export_git_tree(repo)
    process: subprocess.Popen[bytes] | None = None
    servers: list[ThreadingHTTPServer] = []
    try:
        work = Path(temporary.name) / ".coexistence-runtime"
        work.mkdir()
        binary = work / "songs-current"
        environment = os.environ.copy()
        environment["GOPROXY"] = "off"
        build = subprocess.run(["go", "build", "-o", str(binary), "./cmd/srv"], cwd=source_root, env=environment, capture_output=True)
        if build.returncode:
            raise RuntimeError((build.stdout + build.stderr).decode(errors="replace"))
        process = subprocess.Popen(
            [str(binary), "-listen", f"127.0.0.1:{args.v1_app_port}", "-repo", str(source_root), "-db", str(work / "songs.sqlite3")],
            cwd=source_root,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        app_url = f"http://127.0.0.1:{args.v1_app_port}"
        wait_ready(app_url + "/api/catalog", process)
        servers = [
            ThreadingHTTPServer(("127.0.0.1", args.v1_port), v1_proxy(app_url, output / "v1.json")),
            ThreadingHTTPServer(("127.0.0.1", args.v2_port), v2_probe(output / "v2.json")),
        ]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        print(f"v1=http://127.0.0.1:{args.v1_port}/ (actual frozen app/worker)", flush=True)
        print(f"v2=http://127.0.0.1:{args.v2_port}/ (synthetic namespace reservation)", flush=True)
        for thread in threads:
            thread.join()
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
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
