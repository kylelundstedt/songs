from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class V2Phase1StorageTests(unittest.TestCase):
    def test_generated_storage_evidence_is_current(self) -> None:
        result = subprocess.run(
            ["python3", "scripts/build_v2_phase1_storage_evidence.py", "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_atomic_storage_and_offline_proofs_are_complete(self) -> None:
        summary = json.loads((ROOT / "migration/v2/phase1/storage/storage-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["task"], "TASK-012")
        self.assertEqual(summary["indexeddb"]["name"], "songs-v2")
        self.assertEqual(summary["indexeddb"]["version"], 2)
        self.assertEqual(summary["bootstrap"]["documents"], 373)
        self.assertEqual(summary["corruption_repair_network"]["api_requests"], 13)
        self.assertTrue(all(summary["proof"].values()))
        self.assertEqual(summary["limitations"]["physical_safari_ipad"].split()[0], "pending")

    def test_v1_and_frozen_evidence_remain_unchanged(self) -> None:
        content = subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--exit-code", "v2-phase1-content-2026-08-10", "--", "songs", "sets", "srv"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(content.returncode, 0, content.stdout + content.stderr)
        frozen = subprocess.run(
            [
                "git", "-C", str(ROOT), "diff", "--exit-code", "v2-phase1-evidence-2026-08-10", "--",
                "migration/v2/current", "scripts/build_v2_current_backup_restore_baseline.py",
                "scripts/build_v2_current_baseline.py", "scripts/build_v2_current_bootstrap_baseline.py",
                "scripts/build_v2_current_bootstrap_browser_summary.py", "scripts/build_v2_current_browser_fit_baseline.py",
                "scripts/build_v2_current_coexistence_summary.py", "scripts/build_v2_current_contracts.py",
                "scripts/build_v2_current_renderer_baseline.py", "scripts/build_v2_current_route_baseline.py",
                "scripts/serve_v2_current_coexistence_harness.py", "scripts/serve_v2_current_fit_harness.py",
                "scripts/v2_current_config.py", "docs/v2/decisions/0007-phase1-baseline-origin.md",
                "docs/v2/tasks/TASK-008-current-content-baseline.md",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(frozen.returncode, 0, frozen.stdout + frozen.stderr)


if __name__ == "__main__":
    unittest.main()
