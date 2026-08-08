from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_v2_route_baseline.py"
SPEC = importlib.util.spec_from_file_location("build_v2_route_baseline", SCRIPT)
assert SPEC and SPEC.loader
routes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(routes)


class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class FakeResponse:
    status = 200
    headers = FakeHeaders({"Content-Type": "text/plain", "Date": "volatile"})

    def read(self):
        return b"built 2026-08-08T12:34:56Z"


class FakeOpener:
    def open(self, request, timeout=0):
        return FakeResponse()


class RouteBaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artifact = json.loads((ROOT / "migration/v2/routes/route-baseline.json").read_text(encoding="utf-8"))

    def test_normalizer_only_removes_known_volatile_values(self):
        raw = b"2026-08-08T12:34:56.123Z https://abc.shelley.exe.xyz/new 127.0.0.1:12345 meaningful"
        got = routes.normalized_body(raw)
        self.assertEqual(got, b"{RFC3339_BUILD_TIME} {SHELLEY_URL} {LOOPBACK_EPHEMERAL_PORT} meaningful")

    def test_route_inventory_parser_and_classification(self):
        source = subprocess.check_output(["git", "show", "v1:srv/server.go"], cwd=ROOT, text=True)
        inventory = routes.parse_route_inventory(source)
        self.assertEqual(len(inventory), 27)
        classified = [routes.classify_route(route) for route in inventory]
        self.assertTrue(all(item["classification"] and (item["fixture_ids"] or item["exclusion"]) for item in classified))
        self.assertEqual(classified[-1]["path"], "/static/")
        with self.assertRaises(RuntimeError):
            routes.classify_route({"method": "GET", "path": "/new-route", "line": 1})

    def test_response_capture_and_volatile_headers(self):
        captured = routes.capture_response(FakeOpener(), "http://example.test", "/x")
        self.assertEqual(captured["status"], 200)
        self.assertEqual(captured["headers"], {"Content-Type": "text/plain"})
        raw = b"built 2026-08-08T12:34:56Z"
        normalized = b"built {RFC3339_BUILD_TIME}"
        self.assertEqual(captured["body_bytes"], len(raw))
        self.assertEqual(captured["normalized_body_bytes"], len(normalized))
        self.assertEqual(captured["body_sha256"], hashlib.sha256(normalized).hexdigest())

    def test_actual_counts_and_canonical_families(self):
        self.assertEqual(self.artifact["baseline"]["commit"], routes.BASELINE_COMMIT)
        self.assertEqual(self.artifact["corpus"]["song_count"], 291)
        self.assertEqual(self.artifact["corpus"]["set_count"], 60)
        expected = {"song": 291, "song-json": 291, "song-markdown": 291, "set": 60, "live": 60, "set-markdown": 60, "offline": 60}
        self.assertEqual({key: value["record_count"] for key, value in self.artifact["families"].items()}, expected)
        self.assertTrue(all(value["status_distribution"] == {"200": value["record_count"]} for value in self.artifact["families"].values()))
        canonical = [record for record in self.artifact["records"] if record["id"].split("/", 1)[0] in {"song", "song-json", "song-markdown", "set", "live", "set-markdown", "offline"}]
        self.assertEqual(len(canonical), 1113)
        self.assertEqual(len({record["id"] for record in canonical}), 1113)
        self.assertTrue(all(record["response"]["status"] == 200 for record in canonical))
        self.assertTrue(all(len(record["response"]["body_sha256"]) == 64 for record in canonical))
        self.assertEqual(self.artifact["summary"]["request_case_count"], 1158)
        self.assertEqual(self.artifact["summary"]["canonical_request_count"], 1113)
        self.assertTrue(self.artifact["contract_validation"]["canonical_statuses_ok"])
        self.assertTrue(self.artifact["contract_validation"]["library_ids_match_tagged_corpus"])
        self.assertEqual(len(self.artifact["corpus"]["song_ids_sha256"]), 64)
        self.assertEqual(len(self.artifact["corpus"]["set_ids_sha256"]), 64)

    def test_every_route_covered_and_exclusions_are_safe(self):
        inventory = self.artifact["route_inventory"]
        self.assertEqual(self.artifact["coverage"]["registered_route_count"], len(inventory))
        self.assertFalse(self.artifact["coverage"]["unclassified_routes"])
        excluded = {item["id"] for item in self.artifact["exclusions"]}
        for route in inventory:
            self.assertTrue(route["fixture_ids"] or route["exclusion"])
        for mutation_id in ("mutation-create-song", "mutation-update-set-markdown", "mutation-update-song-markdown", "mutation-reindex"):
            self.assertIn(mutation_id, excluded)
        self.assertIn("provider-import", excluded)
        probes = {record["id"]: record["response"]["status"] for record in self.artifact["records"] if record["route"] == "safe-mutation-probe"}
        self.assertEqual(set(probes.values()), {401})

    def test_edge_cases_and_static_headers(self):
        records = {record["id"]: record for record in self.artifact["records"]}
        self.assertEqual(records["edge-duplicate-slash"]["response"]["status"], 307)
        self.assertEqual(records["edge-duplicate-slash"]["response"]["headers"]["Location"], "/song/1979")
        self.assertEqual(records["edge-case-sensitive-song"]["response"]["status"], 404)
        self.assertEqual(records["edge-encoded-song"]["response"]["status"], 200)
        self.assertEqual(records["edge-static-root"]["response"]["status"], 200)
        self.assertEqual(records["edge-unsupported"]["response"]["status"], 405)
        self.assertEqual(records["edge-unsupported"]["response"]["headers"]["Allow"], "GET, HEAD")
        for case_id in (
            "edge-song-markdown-unauthenticated",
            "edge-set-markdown-unauthenticated",
            "edge-shelley-job-unauthenticated",
            "edge-lyrics-search-unauthenticated",
        ):
            self.assertEqual(records[case_id]["response"]["status"], 401)
        self.assertEqual(records["provider-invalid-query"]["response"]["status"], 400)
        self.assertEqual(records["shelley-job-unknown"]["response"]["status"], 404)
        self.assertEqual(records["new-song-query"]["response"]["semantic"]["draft_title"], "Route Fixture")
        self.assertEqual(records["service-worker"]["response"]["headers"]["Service-Worker-Allowed"], "/")
        self.assertEqual(records["manifest"]["response"]["headers"]["Content-Type"], "application/manifest+json")
        self.assertIn("Content-Security-Policy", records["root"]["response"]["headers"])

    def test_representative_canonical_hashes_are_from_v1(self):
        records = {record["id"]: record for record in self.artifact["records"]}
        song = subprocess.check_output(["git", "show", "v1:songs/1979.md"], cwd=ROOT)
        song_hash = hashlib.sha256(song).hexdigest()
        self.assertEqual(records["song-json/1979"]["response"]["semantic"]["hash"], song_hash)
        self.assertEqual(records["song-markdown/1979"]["response"]["semantic"]["hash"], song_hash)
        set_path = "sets/2005-03-26-easter-pageant.md"
        set_body = subprocess.check_output(["git", "show", f"v1:{set_path}"], cwd=ROOT)
        set_hash = hashlib.sha256(set_body).hexdigest()
        self.assertEqual(records["set-markdown/2005-03-26-easter-pageant"]["response"]["semantic"]["hash"], set_hash)
        self.assertEqual(records["offline/2005-03-26-easter-pageant"]["response"]["semantic"]["hash"], set_hash)

    def test_deterministic_render_and_check(self):
        first = routes.generate(ROOT)
        second = routes.generate(ROOT)
        self.assertEqual(first, second)
        self.assertEqual(first[-1], "\n")
        self.assertEqual(subprocess.run([sys.executable, str(SCRIPT), "--check"], cwd=ROOT).returncode, 0)


if __name__ == "__main__":
    unittest.main()
