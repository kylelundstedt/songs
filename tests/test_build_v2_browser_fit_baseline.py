from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_v2_browser_fit_baseline.py"
SPEC = importlib.util.spec_from_file_location("build_v2_browser_fit_baseline", SCRIPT)
assert SPEC and SPEC.loader
browser_fit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(browser_fit)
ARTIFACT = ROOT / "migration" / "v2" / "renderer" / "browser-fit-summary.json"


class BrowserFitBaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.summary = json.loads(ARTIFACT.read_text(encoding="utf-8"))

    def test_exact_baseline_profiles_and_measurement_identity(self) -> None:
        data = self.summary
        self.assertEqual(data["baseline"], {"ref": "v1", "commit": browser_fit.BASELINE_COMMIT})
        self.assertEqual(data["measurement_surface"], "v1 verifySetFits-compatible hidden lead-sheet panel")
        self.assertEqual([profile["name"] for profile in data["profiles"]], ["ipad-portrait", "ipad-landscape", "phone"])
        self.assertTrue(data["validation"]["exact_requested_profiles"])
        self.assertTrue(data["validation"]["consistent_profile_identity"])
        self.assertEqual(data["browser_engine"]["name"], "Chromium")
        self.assertIn("not Safari evidence", data["browser_engine"]["note"])

    def test_expected_outcomes_and_distributions(self) -> None:
        profiles = {profile["name"]: profile for profile in self.summary["profiles"]}
        self.assertEqual(profiles["ipad-portrait"]["status_distribution"], {"fit": 291})
        self.assertEqual(profiles["ipad-portrait"]["failure_ids"], [])
        self.assertEqual(profiles["ipad-landscape"]["status_distribution"], {"fit": 289, "needs-editing": 2})
        self.assertEqual(profiles["ipad-landscape"]["failure_ids"], ["can-t-stop", "paradise-city"])
        self.assertEqual(profiles["phone"]["status_distribution"], {"scrollable": 291})
        self.assertEqual(profiles["phone"]["failure_ids"], [])
        for profile in profiles.values():
            self.assertEqual((profile["result_count"], profile["unique_song_count"]), (291, 291))

    def test_capture_and_screenshot_records(self) -> None:
        self.assertEqual(len(self.summary["captures"]), 3)
        for capture in self.summary["captures"]:
            path = ROOT / capture["path"]
            self.assertTrue(path.is_file())
            self.assertEqual(capture["bytes"], path.stat().st_size)
        screenshots = {(item["profile"], item["song_id"]): item for item in self.summary["screenshots"]}
        self.assertEqual(set(screenshots), {("ipad-portrait", "paradise-city"), ("ipad-landscape", "paradise-city"), ("phone", "1979")})
        for item in screenshots.values():
            path = ROOT / item["path"]
            self.assertTrue(path.is_file())
            self.assertEqual(item["bytes"], path.stat().st_size)
            self.assertEqual(item["dimensions"]["width"], item["profile"] != "phone" and (1024 if item["profile"] == "ipad-portrait" else 1366) or 390)
            self.assertTrue(item["source_path"].startswith("songs/"))
            self.assertEqual(len(item["source_sha256"]), 64)
            self.assertIn("DOMContentLoaded fitAll", item["measurement_surface"])
        self.assertEqual(screenshots[("ipad-portrait", "paradise-city")]["observed_fit"], {"body_px": 19, "column_count": 2, "line_height": 1.12})
        self.assertEqual(screenshots[("ipad-landscape", "paradise-city")]["observed_fit"], {"body_px": 16, "column_count": 2, "line_height": 1.12})
        self.assertEqual(screenshots[("phone", "1979")]["observed_fit"], {"body_px": 20, "column_count": 1, "line_height": 1.24})

    def test_physical_ipad_is_pending(self) -> None:
        self.assertEqual(self.summary["physical_ipad"]["status"], "pending")

    def test_generator_check(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--check"], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
