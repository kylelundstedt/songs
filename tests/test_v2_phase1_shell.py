from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class V2Phase1ShellTests(unittest.TestCase):
    def test_generated_shell_evidence_is_current(self) -> None:
        result = subprocess.run(
            ["python3", "scripts/build_v2_phase1_shell_evidence.py", "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_shell_release_and_browser_boundaries(self) -> None:
        summary = json.loads((ROOT / "migration/v2/phase1/shell/browser-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["shell"]["release"], "shell-72d3106d38dfec5cc2eaf403")
        self.assertEqual(summary["bootstrap"]["documents"], 373)
        self.assertEqual(summary["bootstrap"]["chunks"], 12)
        self.assertGreaterEqual(summary["accessibility"]["minimum_small_text_ratio"], 4.5)
        self.assertTrue(all(summary["proof"].values()))
        for profile in summary["browser"]["profiles"]:
            observation = profile["observation"]
            self.assertEqual(observation["observed"]["width"], observation["observed"]["scroll_width"])
            self.assertEqual(observation["cache_names"], ["songs-v2-shell-72d3106d38dfec5cc2eaf403"])
            self.assertEqual(observation["database_names"], [])
            self.assertEqual(observation["authoring_controls"], [])

    def test_origin_is_loopback_only_and_v1_is_not_modified(self) -> None:
        service = (ROOT / "songs-v2-api.service").read_text(encoding="utf-8")
        command = (ROOT / "cmd/v2api/main.go").read_text(encoding="utf-8")
        self.assertIn("-listen 127.0.0.1:8001", service)
        self.assertIn('"127.0.0.1:8001"', command)
        result = subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--exit-code", "v2-phase1-content-2026-08-10", "--", "songs", "sets", "srv"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
