from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "migrate_legacy.py"


class LegacyMigrationTests(unittest.TestCase):
    def test_byte_preserving_copy_and_relative_set_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            source = temporary_path / "legacy"
            destination = temporary_path / "destination"
            lead_sheets = source / "lead-sheet"
            lead_sheets.mkdir(parents=True)
            first = b"# Alpha\n\nline one  \n"
            second = b"# Beta {short=\"B\"}\n\n### Verse\nline two\n"
            (lead_sheets / "Alpha.md").write_bytes(first)
            (lead_sheets / "Beta.md").write_bytes(second)
            (source / "Master-Set-List.csv").write_text(
                "./lead-sheet/Alpha.md,\n./lead-sheet/Beta.md,\n", encoding="utf-8"
            )
            (source / "2021-02-20-Murphys.txt").write_text(
                "./lead-sheet/Beta.md\n./lead-sheet/Alpha.md\n", encoding="utf-8"
            )
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(
                [
                    "git", "-C", str(source), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                    "commit", "-qm", "fixture",
                ],
                check=True,
            )
            command = [
                sys.executable,
                str(SCRIPT),
                "--source", str(source),
                "--destination", str(destination),
                "--expected-lead-sheets", "2",
                "--expected-set-entries", "2",
            ]
            subprocess.run(command, check=True, text=True, capture_output=True)
            self.assertEqual((destination / "songs" / "Alpha.md").read_bytes(), first)
            self.assertEqual((destination / "songs" / "Beta.md").read_bytes(), second)
            set_list = (destination / "sets" / "2021-02-20-murphys.md").read_text(encoding="utf-8")
            self.assertIn("1. [Beta](../songs/Beta.md)", set_list)
            self.assertIn("2. [Alpha](../songs/Alpha.md)", set_list)
            manifest = json.loads((destination / "migration" / "legacy-migration-manifest.json").read_text())
            self.assertTrue(manifest["validation"]["valid"])
            self.assertEqual(manifest["review"]["unsectioned_count"], 1)
            review = (destination / "migration" / "legacy-migration-review.md").read_text(encoding="utf-8")
            self.assertNotIn("line one", review)
            subprocess.run(command + ["--verify-only"], check=True, text=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
