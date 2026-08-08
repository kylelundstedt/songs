from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_v2_baseline.py"
SPEC = importlib.util.spec_from_file_location("build_v2_baseline", SCRIPT_PATH)
assert SPEC and SPEC.loader
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


class BaselineBuilderTests(unittest.TestCase):
    def test_metadata_extraction(self) -> None:
        text = '---\r\nid: "set-id"\r\ntitle: "Metadata title"\r\n---\r\n\r\n# Actual title\r\n'
        self.assertEqual(baseline.extract_metadata(text, "fallback"), ("Actual title", "set-id"))
        self.assertEqual(baseline.extract_metadata("# Song\n", "fallback"), ("Song", None))

    def test_newline_classification(self) -> None:
        self.assertEqual(baseline.classify_newlines(b"one\ntwo\n"), "LF")
        self.assertEqual(baseline.classify_newlines(b"one\r\ntwo\r\n"), "CRLF")
        self.assertEqual(baseline.classify_newlines(b"one\rtwo\r"), "CR")
        self.assertEqual(baseline.classify_newlines(b"one\r\ntwo\n"), "mixed")
        self.assertEqual(baseline.classify_newlines(b"one"), "none")

    def test_link_classification_preserves_targets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "songs").mkdir()
            (root / "sets").mkdir()
            (root / "songs" / "Target.md").write_text("# Target\n", encoding="utf-8")
            source = (root / "sets" / "set.md")
            source.write_text(
                "# Set\n"
                "[local](../songs/Target.md) [missing](../songs/Nope.md)\n"
                "[unresolved](unresolved:maybe) [url](https://example.test/x)\n"
                "[anchor](#part)\n",
                encoding="utf-8",
            )
            manifest = baseline.build_manifest(root)
            links = next(record for record in manifest["records"] if record["path"] == "sets/set.md")["links"]
            self.assertEqual(
                [(link["target"], link["classification"]) for link in links],
                [
                    ("../songs/Target.md", "resolved canonical file"),
                    ("../songs/Nope.md", "missing"),
                    ("unresolved:maybe", "unresolved: reference"),
                    ("https://example.test/x", "external URL"),
                    ("#part", "anchor"),
                ],
            )
            self.assertEqual(links[0]["resolved_path"], "songs/Target.md")

    def test_deterministic_rendering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "songs").mkdir()
            (root / "songs" / "Song.md").write_text("# Song\n", encoding="utf-8")
            first = baseline.render_with_verification(baseline.build_manifest(root))
            second = baseline.render_with_verification(baseline.build_manifest(root))
            self.assertEqual(first, second)
            self.assertEqual(first[-1], "\n")
            self.assertEqual(json.loads(first)["verification"]["record_count"], 1)

    def test_actual_repo_manifest_invariants(self) -> None:
        manifest_path = ROOT / "migration" / "v2" / "v1-corpus-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["baseline"], {"ref": "v1", "commit": baseline.BASELINE_COMMIT})
        self.assertEqual(manifest["corpus"]["counts"], {"files": 351, "songs": 291, "sets": 60})
        records = manifest["records"]
        self.assertEqual([record["path"] for record in records], sorted(record["path"] for record in records))
        self.assertEqual(len({record["path"] for record in records}), 351)
        self.assertTrue(all(record["sha256"] and record["bytes"] >= 0 for record in records))
        self.assertEqual(sum(record["bytes"] for record in records), manifest["corpus"]["bytes"]["total"])
        self.assertEqual(records[0]["path"], "sets/2005-03-26-easter-pageant.md")
        self.assertEqual(records[-1]["path"], "songs/you-re-so-bad.md")
        # Verify representative tagged blobs, rather than mutable worktree files.
        for path in ("songs/1979.md", "sets/2021-01-01-naz-pahtay.md"):
            raw = subprocess.check_output(["git", "-C", str(ROOT), "show", f"v1:{path}"])
            record = next(item for item in records if item["path"] == path)
            self.assertEqual(record["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(record["bytes"], len(raw))
        before = subprocess.check_output(["git", "-C", str(ROOT), "status", "--short", "--", "songs", "sets"])
        self.assertEqual(subprocess.run([sys.executable, str(SCRIPT_PATH), "--check"], cwd=ROOT).returncode, 0)
        after = subprocess.check_output(["git", "-C", str(ROOT), "status", "--short", "--", "songs", "sets"])
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
