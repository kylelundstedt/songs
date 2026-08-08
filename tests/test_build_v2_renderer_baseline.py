from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_v2_renderer_baseline.py"
SPEC = importlib.util.spec_from_file_location("build_v2_renderer_baseline", SCRIPT)
assert SPEC and SPEC.loader
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)
ARTIFACT = ROOT / "migration" / "v2" / "renderer" / "renderer-baseline.json"


class RendererBaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.baseline = json.loads(ARTIFACT.read_text(encoding="utf-8"))

    def test_feature_detection_and_selection(self) -> None:
        raw = b"---\nannotations: []\n---\n\n# Song\n### Verse\n> note\nline  \n<!-- column-break -->\n"
        features = renderer.detect_features(raw)
        for name in ("h3", "column_break", "hard_break", "blockquote_or_annotation", "front_matter"):
            self.assertTrue(features[name], name)
        self.assertEqual(features["annotation_count"], 0)
        entries = [{"path": "songs/example.md", "raw": raw, "features": features}]
        selected = renderer.select_representatives(entries)
        self.assertEqual(selected[0]["path"], "songs/example.md")
        self.assertIn("h3", selected[0]["selection_reasons"])
        self.assertEqual(renderer.representative_coverage_gaps(entries), ["h2", "no_section_headings"])

    def test_representatives_never_use_readme_or_sets(self) -> None:
        raw = b"---\nannotations: []\n---\n# Song\n### Verse\nlyrics\n"
        features = renderer.detect_features(raw)
        entries = [
            {"path": "songs/example.md", "raw": raw, "features": features},
            {"path": "sets/example.md", "raw": raw, "features": features},
            {"path": "README.md", "raw": b"## H2\n", "features": renderer.detect_features(b"## H2\n")},
        ]
        selected = renderer.select_representatives(entries)
        self.assertTrue(selected)
        self.assertTrue(all(item["path"].startswith("songs/") for item in selected))
        self.assertIn("h2", renderer.representative_coverage_gaps(entries))

    def test_deterministic_json_rendering(self) -> None:
        first = renderer.render_with_verification({"verification": {"output_sha256": None}, "value": [1, "é"]})
        second = renderer.render_with_verification({"verification": {"output_sha256": None}, "value": [1, "é"]})
        self.assertEqual(first, second)
        self.assertTrue(first.endswith("\n"))
        self.assertEqual(json.loads(first)["value"], [1, "é"])

    def test_actual_291_song_invariants(self) -> None:
        data = self.baseline
        self.assertEqual(data["baseline"], {"ref": "v1", "commit": renderer.BASELINE_COMMIT})
        corpus = data["corpus"]
        self.assertEqual((corpus["song_count"], corpus["render_count"], corpus["success_count"], corpus["failure_count"]), (291, 291, 291, 0))
        records = corpus["renders"]
        self.assertEqual([record["path"] for record in records], sorted(record["path"] for record in records))
        self.assertEqual(len({record["path"] for record in records}), 291)
        self.assertTrue(all(record["success"] and record["error"] is None for record in records))
        self.assertTrue(all(record["source_bytes"] > 0 and record["rendered_html_bytes"] > 0 for record in records))
        for path in ("songs/1979.md", "songs/Paradise-City.md"):
            raw = subprocess.check_output(["git", "-C", str(ROOT), "show", f"v1:{path}"])
            record = next(item for item in records if item["path"] == path)
            self.assertEqual(record["source_sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(record["source_bytes"], len(raw))

    def test_fixture_hashes_and_representative_coverage(self) -> None:
        data = self.baseline
        reasons = {reason for item in data["representatives"] for reason in item["selection_reasons"]}
        self.assertTrue(set(renderer.FEATURE_ORDER) - set(data["representative_coverage_gaps"]) <= reasons)
        self.assertEqual(data["representative_coverage_gaps"], ["h2", "no_section_headings"])
        self.assertTrue(all(item["path"].startswith("songs/") and item["kind"] == "song" for item in data["representatives"]))
        for item in data["representatives"]:
            fixture = ROOT / "migration" / "v2" / "renderer" / item["fixture"]
            raw = fixture.read_bytes()
            self.assertEqual(item["rendered_html_sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(item["rendered_html_bytes"], len(raw))
            raw_source = subprocess.check_output(["git", "-C", str(ROOT), "show", f"v1:{item['path']}"])
            self.assertEqual(item["source_sha256"], hashlib.sha256(raw_source).hexdigest())
            self.assertEqual(item["source_bytes"], len(raw_source))
            raw.decode("utf-8")

    def test_asset_hashes_are_from_v1(self) -> None:
        for asset in self.baseline["assets"]:
            raw = subprocess.check_output(["git", "-C", str(ROOT), "show", f"v1:{asset['path']}"])
            self.assertEqual(asset["sha256"], hashlib.sha256(raw).hexdigest(), asset["path"])
            self.assertEqual(asset["bytes"], len(raw), asset["path"])
        self.assertEqual({asset["path"] for asset in self.baseline["assets"]}, set(renderer.ASSET_PATHS))

    def test_renderer_implementation_hash_is_from_v1(self) -> None:
        item = self.baseline["renderer_implementation"]
        raw = subprocess.check_output(["git", "-C", str(ROOT), "show", f"v1:{item['path']}"])
        self.assertEqual(item["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(item["bytes"], len(raw))

        apex = self.baseline["apex"]
        executable = Path(apex["executable_path"])
        self.assertTrue(executable.is_absolute())
        self.assertTrue(executable.is_file())
        self.assertTrue(apex["version_output"].startswith("Apex "))
        self.assertEqual(apex["sha256"], hashlib.sha256(executable.read_bytes()).hexdigest())
        self.assertEqual(tuple(apex["flags"]), renderer.APEX_FLAGS)

    def test_fitter_constants_and_pending_outcomes(self) -> None:
        constants = self.baseline["fitter"]["constants"]
        self.assertEqual(constants["min_px"], 16)
        self.assertEqual(constants["preferred_px"], 21)
        self.assertEqual(constants["manual_min_px"], 12)
        self.assertEqual(constants["manual_max_px"], 32)
        self.assertEqual(constants["line_height_candidates"], [1.24, 1.2, 1.16, 1.12])
        self.assertEqual([(p["width"], p["height"]) for p in self.baseline["fitter"]["viewport_profiles"]], [(1024, 1366), (1366, 1024), (390, 844)])
        self.assertEqual(self.baseline["fitter"]["browser_fit"]["status"], "recorded-separate-artifact")
        self.assertEqual(self.baseline["fitter"]["browser_fit"]["artifact"], "migration/v2/renderer/browser-fit-summary.json")
        self.assertEqual(self.baseline["fitter"]["physical_ipad"]["status"], "pending")

    def test_generator_check(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--check"], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
