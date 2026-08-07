import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import populate_keys as keys


class KeyMetadataTests(unittest.TestCase):
    def test_normalizes_enharmonic_minor_key(self):
        self.assertEqual(keys.normalize_key("G#", "minor"), "Abm")
        self.assertEqual(keys.normalize_key("F#", "major"), "F#")

    def test_accepts_unanimous_preview_analysis(self):
        preview = {"consensus_key": "Eb", "agreement": 3, "strength": 0.82}
        decision = keys.decide(None, preview)
        self.assertEqual(decision["decision"], "accept")
        self.assertEqual(decision["key"], "Eb")
        self.assertEqual(decision["kind"], "preview-analysis-estimate")

    def test_requires_strength_for_two_profile_vote(self):
        weak = {"consensus_key": "Am", "agreement": 2, "strength": 0.5}
        self.assertEqual(keys.decide(None, weak)["decision"], "review")

    def test_seeds_missing_performance_values_without_changing_body(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "songs").mkdir()
            body = "# Song\n\nWords\n"
            path = root / "songs/song.md"
            path.write_text('---\noriginal_key: "G"\noriginal_bpm: "120"\n---\n\n' + body)
            self.assertEqual(keys.seed_performance_values(root), ["songs/song.md"])
            values = keys.metadata.parse_front_matter(path.read_text())
            self.assertEqual(values["performance_key"], "G")
            self.assertEqual(values["bpm"], "120")
            self.assertEqual(keys.metadata.split_front_matter(path.read_text())[1], body)

    def test_prefers_cross_source_consensus(self):
        preview = {"consensus_key": "G", "agreement": 2, "strength": 0.75}
        acousticbrainz = {"key": "G", "strength": 0.6}
        decision = keys.decide(acousticbrainz, preview)
        self.assertEqual(decision["kind"], "analysis-consensus")


if __name__ == "__main__":
    unittest.main()
