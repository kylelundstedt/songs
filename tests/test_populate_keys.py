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

    def test_prefers_cross_source_consensus(self):
        preview = {"consensus_key": "G", "agreement": 2, "strength": 0.75}
        acousticbrainz = {"key": "G", "strength": 0.6}
        decision = keys.decide(acousticbrainz, preview)
        self.assertEqual(decision["kind"], "analysis-consensus")


if __name__ == "__main__":
    unittest.main()
