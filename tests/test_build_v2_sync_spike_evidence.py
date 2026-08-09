from __future__ import annotations
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_v2_sync_spike_evidence.py"
spec = importlib.util.spec_from_file_location("sync_spike_evidence", SCRIPT)
assert spec and spec.loader
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class SyncSpikeEvidenceTests(unittest.TestCase):
    def test_generate_is_deterministic_and_checked_in(self) -> None:
        first = builder.generate(ROOT)
        second = builder.generate(ROOT)
        self.assertEqual(first, second)
        self.assertEqual(first, (ROOT / builder.DEFAULT_OUTPUT).read_bytes())

    def test_evidence_has_required_semantic_proofs(self) -> None:
        artifact = json.loads((ROOT / builder.DEFAULT_OUTPUT).read_text(encoding="utf-8"))
        self.assertTrue(artifact["recommendation"]["feasible"])
        self.assertEqual(artifact["git"]["remote_commit_count"], 9)
        self.assertTrue(artifact["git"]["seed_body_byte_identical"])
        self.assertTrue(artifact["git"]["later_body_byte_identical"])
        self.assertTrue(artifact["git"]["safety_controls_verified"])
        self.assertTrue(artifact["database"]["integrity_check_ok"])
        self.assertTrue(artifact["database"]["foreign_key_check_ok"])
        self.assertEqual(artifact["scenario"]["pull"]["resumed_from_ack_sequences"], [3, 4, 5])
        self.assertEqual(artifact["external_reconciliation"]["direct_result"], "imported")
        self.assertTrue(artifact["external_reconciliation"]["sidecar_changed_but_body_imported"])
        self.assertEqual(artifact["external_reconciliation"]["published_pointer_immediately_after_reconciliation"], artifact["scenario"]["revisions"]["external_candidate"])
        self.assertEqual(artifact["external_reconciliation"]["audit_source_actor"], "External Editor")
        self.assertEqual(artifact["scenario"]["conflicts"]["open_after_proof"], 0)
        finalization = artifact["publication"]["finalization_loss_recovery"]
        self.assertEqual([attempt["state"] for attempt in finalization], ["commit_created", "finalization_lost", "pushed", "acknowledged"])
        self.assertEqual(artifact["publication"]["old_publication_acknowledgement"], "acknowledged")
        self.assertEqual(artifact["publication"]["finalization_remote_count_after_push"], artifact["publication"]["finalization_remote_count_before"] + 1)
        self.assertEqual(artifact["publication"]["finalization_remote_count_after_repair"], artifact["publication"]["finalization_remote_count_after_push"])
        self.assertTrue(all(artifact["proofs"].values()))
        rendered = (ROOT / builder.DEFAULT_OUTPUT).read_text(encoding="utf-8")
        self.assertNotRegex(rendered, r"20\d{2}-\d{2}-\d{2}T\d{2}:")
        self.assertNotIn("/tmp/", rendered)
        self.assertNotIn("@", rendered)

    def test_check(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--check"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

if __name__ == "__main__":
    unittest.main()
