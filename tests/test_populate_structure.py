import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import populate_structure as structure


class StructureTests(unittest.TestCase):
    def test_aligns_notion_headings_to_canonical_lines(self):
        canonical = "# Song\n\nFirst verse line  \nSecond verse line\n\nSing the chorus  \nAgain the chorus\n"
        notion = "# Song\n\n### Verse 1\nFirst verse line; Second verse line\n\n### Chorus\nSing the chorus; Again the chorus\n"
        plan = structure.align_notion(canonical, notion)
        self.assertEqual([(item["heading"], item["before_line"]) for item in plan], [("Verse 1", 1), ("Chorus", 3)])

    def test_rejects_invalid_plan_positions(self):
        with self.assertRaises(ValueError):
            structure.validate_plan([
                {"heading": "Chorus", "before_line": 3},
                {"heading": "Verse", "before_line": 2},
            ], 4)

    def test_apply_only_inserts_headings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "songs").mkdir()
            body = "# Song\n\nLine one  \nLine two\n\nChorus one  \nChorus two\n"
            path = root / "songs/song.md"
            path.write_text('---\nartist: "Artist"\n---\n\n' + body)
            proposal = {
                "song_count": 1,
                "songs": [{
                    "id": "song", "path": "songs/song.md", "title": "Song",
                    "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
                    "content_line_count": 4, "source": "model-estimated",
                    "plan": [
                        {"heading": "Verse 1", "before_line": 1, "confidence": 0.9},
                        {"heading": "Chorus", "before_line": 3, "confidence": 0.9},
                    ],
                }],
            }
            proposal_path = root / "proposal.json"
            proposal_path.write_text(json.dumps(proposal))
            self.assertEqual(structure.apply_proposals(proposal_path, root), ["songs/song.md"])
            result = path.read_text()
            self.assertIn("### Verse 1", result)
            self.assertIn("### Chorus", result)
            self.assertEqual([line for line in body.splitlines() if line.strip() and not line.startswith("#")],
                             [line for line in structure.metadata.split_front_matter(result)[1].splitlines()
                              if line.strip() and not line.startswith("#")])


if __name__ == "__main__":
    unittest.main()
