from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_v2_backup_restore_baseline.py"
spec = importlib.util.spec_from_file_location("backup_restore_baseline", SCRIPT)
assert spec and spec.loader
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BackupRestoreBaselineTests(unittest.TestCase):
    def test_canonical_json_and_verification(self) -> None:
        value = {"schema_version": "1", "verification": {"output_sha256": None}, "name": "é"}
        rendered = builder.render_with_verification(value)
        parsed = json.loads(rendered)
        saved = parsed["verification"]["output_sha256"]
        parsed["verification"]["output_sha256"] = None
        self.assertEqual(saved, hashlib.sha256(builder.canonical_json(parsed).encode()).hexdigest())
        self.assertTrue(rendered.endswith("\n"))

    def test_component_manifest_validation_and_failure_helpers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / "v1.bundle"
            database = root / "backup.sqlite3"
            bundle.write_bytes(b"bundle")
            database.write_bytes(b"database")
            paths = {"git_bundle": bundle, "sqlite_online_backup": database}
            manifest = builder.component_manifest(paths, {"ref": "v1", "commit": builder.BASELINE_COMMIT}, "schema", "projection")
            builder.validate_component_manifest(manifest, paths, {"ref": "v1", "commit": builder.BASELINE_COMMIT})
            database.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                builder.validate_component_manifest(manifest, paths, {"ref": "v1", "commit": builder.BASELINE_COMMIT})
            database.write_bytes(b"database")
            wrong = dict(manifest)
            wrong["baseline"] = {"ref": "v1", "commit": "0" * 40}
            self.assertTrue(builder.detect_wrong_baseline(wrong, paths))
            missing = {"baseline": manifest["baseline"], "components": {"git_bundle": manifest["components"]["git_bundle"]}}
            self.assertTrue(builder.detect_missing_component(missing, paths))

    def test_corpus_mismatch_detection(self) -> None:
        manifest = json.loads((ROOT / builder.CORPUS_PATH).read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "songs").mkdir(parents=True)
            (root / "sets").mkdir()
            (root / "songs" / "1979.md").write_bytes(b"bad")
            self.assertFalse(builder.compare_corpus(root, manifest))

    def test_semantic_projection_excludes_operational_timestamps(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            connection = sqlite3.connect(path)
            connection.executescript("""
                CREATE TABLE migrations (migration_number INTEGER, migration_name TEXT, executed_at TEXT);
                CREATE TABLE song_index (id TEXT, path TEXT, title TEXT, normalized_title TEXT, source_hash TEXT, rendered_html TEXT, indexed_at TEXT);
                CREATE TABLE set_index (id TEXT, path TEXT, title TEXT, event_date TEXT, location TEXT, source_hash TEXT, indexed_at TEXT);
                INSERT INTO migrations VALUES (1, '001-base', 'first');
                INSERT INTO song_index VALUES ('song', 'songs/song.md', 'Song', 'song', 'source', '<p>Song</p>', 'first');
                INSERT INTO set_index VALUES ('set', 'sets/set.md', 'Set', '', '', 'set-source', 'first');
            """)
            first = builder.projection_hash(builder.semantic_projection(connection))
            connection.execute("UPDATE migrations SET executed_at='second'")
            connection.execute("UPDATE song_index SET indexed_at='second'")
            connection.execute("UPDATE set_index SET indexed_at='second'")
            connection.commit()
            second = builder.projection_hash(builder.semantic_projection(connection))
            self.assertEqual(first, second)
            connection.close()

    def test_actual_artifact_counts_hashes_and_routes(self) -> None:
        artifact = json.loads((ROOT / builder.DEFAULT_OUTPUT).read_text(encoding="utf-8"))
        self.assertEqual(artifact["baseline"]["commit"], builder.BASELINE_COMMIT)
        self.assertEqual(artifact["corpus"]["files"], 351)
        self.assertEqual(artifact["corpus"]["songs"], 291)
        self.assertEqual(artifact["corpus"]["sets"], 60)
        self.assertEqual(artifact["schema"]["song_index_count"], 291)
        self.assertEqual(artifact["schema"]["set_index_count"], 60)
        self.assertEqual(artifact["schema"]["migration_count"], 1)
        self.assertEqual(artifact["schema"]["page_size"], 4096)
        self.assertTrue(artifact["drill"]["online_backup"]["source_server_running_during_backup"])
        self.assertFalse(artifact["drill"]["online_backup"]["raw_live_db_copy_used_as_backup"])
        self.assertEqual(len(artifact["focused_routes"]["records"]), 5)
        self.assertTrue(all(record["status"] == 200 and record["matches_baseline"] for record in artifact["focused_routes"]["records"]))
        self.assertTrue(all(artifact["failure_evidence"].values()))

    def test_failure_evidence_helpers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.sqlite3"
            path.write_bytes(b"not sqlite")
            self.assertTrue(builder.detect_corrupt_sqlite_backup(path))

    def test_checked_in_output_has_no_machine_specific_values(self) -> None:
        output = (ROOT / builder.DEFAULT_OUTPUT).read_text(encoding="utf-8")
        self.assertNotIn("/home/", output)
        self.assertNotIn("/tmp/", output)
        self.assertNotRegex(output, r"127\\.0\\.0\\.1:\\d+")
        self.assertNotRegex(output, r"202[0-9]-[0-9]{2}-[0-9]{2}T[0-9]{2}:")
        self.assertNotIn('"sha256":', output)
        self.assertIn("ephemeral_manifest_sha256_values_verified", output)

    def test_deterministic_output_and_check(self) -> None:
        first = builder.generate(ROOT)
        second = builder.generate(ROOT)
        self.assertEqual(first, second)
        result = __import__("subprocess").run(["python3", str(SCRIPT), "--check"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
