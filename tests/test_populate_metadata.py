import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import populate_metadata as metadata


class MetadataTests(unittest.TestCase):
    def test_lyric_similarity_ignores_lead_sheet_headers(self):
        source = "# 1979\n\n### Verse 14x\nShakedown 1979  \nCool kids never have the time\n"
        tokens = metadata.lyric_tokens(source)
        score = metadata.lyric_similarity(tokens, "Shakedown 1979\nCool kids never have the time")
        self.assertGreater(score, 0.9)
        self.assertNotIn("verse", tokens)

    def test_key_suffix(self):
        self.assertEqual(metadata.KEY_RE.search("Billie Jean (F#m)").group(1), "F#m")
        self.assertIsNone(metadata.KEY_RE.search("American Idiot"))

    def test_rank_prefers_matching_lyrics(self):
        song = {"title": "Crazy", "tokens": metadata.lyric_tokens("# Crazy\nI remember when I remember when I lost my mind")}
        ranked = metadata.rank_lrclib(song, [
            {"id": 1, "trackName": "Crazy", "artistName": "Wrong", "plainLyrics": "Completely unrelated words here"},
            {"id": 2, "trackName": "Crazy", "artistName": "Gnarls Barkley", "plainLyrics": "I remember when I remember when I lost my mind"},
        ])
        self.assertEqual(ranked[0]["id"], 2)

    def test_apply_preserves_body_and_existing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "songs").mkdir()
            body = "# Test Song\n\n### Verse\nWords here\n"
            path = root / "songs/Test-Song.md"
            path.write_text("---\nartist: \"Existing Artist\"\n---\n\n" + body)
            proposal = {
                "id": "test-song", "path": "songs/Test-Song.md",
                "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
                "suggested": {"artist": "Suggested Artist", "original_bpm": "120", "lyrics_reference_id": "1"},
            }
            proposals = root / "proposals.json"
            decisions = root / "decisions.json"
            proposals.write_text(json.dumps({"songs": [proposal]}))
            decisions.write_text(json.dumps({"decisions": [{"id": "test-song", "decision": "accept"}]}))
            changed = metadata.apply_decisions(root, proposals, decisions)
            result = path.read_text()
            self.assertEqual(changed, ["songs/Test-Song.md"])
            self.assertIn('artist: "Existing Artist"', result)
            self.assertIn('original_bpm: "120"', result)
            self.assertEqual(metadata.split_front_matter(result)[1], body)


if __name__ == "__main__":
    unittest.main()
