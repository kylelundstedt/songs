from __future__ import annotations
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/build_v2_bootstrap_browser_summary.py'
spec = importlib.util.spec_from_file_location('summary', SCRIPT)
summary = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(summary)

def inspection(generation: str, *, active: str, transitions: int, old_state: str = 'retained') -> dict:
    snapshots = [{'generation': 'old-v1', 'state': old_state, 'document_count': 1}, {'generation': generation, 'state': 'active', 'document_count': 351}]
    if active == 'old-v1': snapshots[0]['state'] = 'active'; snapshots[1]['state'] = 'staging'
    return {
        'active_generation': active, 'pointer_transitions': transitions, 'snapshots': snapshots,
        'documents_by_generation': {'old-v1': 1, generation: 351},
        'legacy_document': {'path': 'legacy/active.md', 'bytes': 11, 'sha256': 'a' * 64, 'content_sha256': 'a' * 64, 'content_matches_record': True},
    }

def capture(name: str, width: int, height: int, form: str, generation: str) -> dict:
    after_interrupted = inspection(generation, active='old-v1', transitions=0)
    after_corrupt = inspection(generation, active='old-v1', transitions=0)
    after_success = inspection(generation, active=generation, transitions=1)
    after_retry = inspection(generation, active=generation, transitions=1)
    return {
        'schema_version': '1', 'baseline': {'ref': 'v1', 'commit': summary.BASELINE_COMMIT}, 'generation': generation,
        'profile': {'name': name, 'requested': {'width': width, 'height': height, 'device_scale_factor': 1, 'mobile': name == 'phone', 'touch': True}, 'observed': {'inner_width': width, 'inner_height': height, 'device_pixel_ratio': 1, 'form_factor': form, 'max_touch_points': 5}},
        'browser_engine': {'name': 'Chromium', 'user_agent': 'test', 'platform': 'test'},
        'scenario_proof': {key: True for key in summary.REQUIRED_PROOFS},
        'scenario': {
            'schema': {'seeded': {'version': 1, 'stores': summary.BASE_STORES}, 'upgraded': {'version': 2, 'stores': summary.V2_STORES}},
            'stages': {'interrupted': {'failure': 'interrupted'}, 'corrupt': {'failure': 'chunk-checksum'}, 'success': {'activated': True}, 'idempotent_retry': {'idempotent': True, 'activated': True}, 'after_interrupted': after_interrupted, 'after_corrupt': after_corrupt, 'after_success': after_success, 'after_idempotent_retry': after_retry},
            'document_verification': {'count': 351, 'hashes_valid': True, 'snapshot_digest': 'digest', 'expected_snapshot_digest': 'digest'},
        },
        'documents': 351, 'source_bytes': summary.SOURCE_BYTES,
        'durations_ms': {'interrupted': 1, 'corrupt': 2, 'success': 3, 'idempotent_retry': 0},
        'storage': {'before': {'usage': 1, 'quota': 20_000_000, 'persisted': False, 'persist_result': False}, 'after': {'usage': 2, 'quota': 20_000_000, 'persisted': False, 'persist_result': False}},
        'service_worker': {'supported': True, 'registered': True, 'expected_cache_name': 'v2-bootstrap-shell-3', 'cache_name': 'v2-bootstrap-shell-3', 'cache_matches_expected': True},
    }

class BrowserSummaryTests(unittest.TestCase):
    def test_synthetic_summary_new_proofs_and_storage_fields(self) -> None:
        baseline = json.loads((ROOT / 'migration/v2/bootstrap/bootstrap-baseline.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            for name, width, height, form in summary.PROFILES:
                (raw / f'{name}.json').write_text(json.dumps(capture(name, width, height, form, baseline['generation'])))
            output = json.loads(summary.build(ROOT, raw))
            self.assertEqual(len(output['captures']), 3)
            self.assertEqual(output['physical_safari_ipad']['status'], 'pending')
            self.assertIn('origin-wide', output['storage_note'])
            phone = output['storage_quota']['phone']
            self.assertEqual(phone['usage_delta'], 1)
            self.assertGreaterEqual(phone['after_headroom_source_bytes_ratio'], 10)
            self.assertTrue(output['profiles'][0]['logical_outcome']['idempotent_retry'])
            self.assertEqual(output['profiles'][0]['service_worker']['expected_cache_name'], 'v2-bootstrap-shell-3')

    def test_validator_rejects_missing_proof_dpr_cache_and_headroom(self) -> None:
        baseline = json.loads((ROOT / 'migration/v2/bootstrap/bootstrap-baseline.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            for name, width, height, form in summary.PROFILES:
                (raw / f'{name}.json').write_text(json.dumps(capture(name, width, height, form, baseline['generation'])))
            bad = capture('phone', 390, 844, 'phone', baseline['generation'])
            bad['scenario_proof']['idempotent_retry'] = False
            (raw / 'phone.json').write_text(json.dumps(bad))
            with self.assertRaises(ValueError): summary.build(ROOT, raw)
            bad = capture('phone', 390, 844, 'phone', baseline['generation'])
            bad['profile']['observed']['device_pixel_ratio'] = 2
            (raw / 'phone.json').write_text(json.dumps(bad))
            with self.assertRaises(ValueError): summary.build(ROOT, raw)
            bad = capture('phone', 390, 844, 'phone', baseline['generation'])
            bad['service_worker']['cache_name'] = 'v2-bootstrap-shell-1'
            (raw / 'phone.json').write_text(json.dumps(bad))
            with self.assertRaises(ValueError): summary.build(ROOT, raw)
            bad = capture('phone', 390, 844, 'phone', baseline['generation'])
            bad['storage']['after']['quota'] = summary.SOURCE_BYTES + 2
            (raw / 'phone.json').write_text(json.dumps(bad))
            with self.assertRaises(ValueError): summary.build(ROOT, raw)

    def test_recorded_observations_match_checked_summary(self) -> None:
        raw = ROOT / summary.RAW
        expected = summary.build(ROOT, raw)
        self.assertEqual(expected, (ROOT / summary.OUTPUT).read_bytes())
        result = subprocess.run([sys.executable, str(SCRIPT), '--check'], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_observations_fail_clearly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'missing recorded observation'):
                summary.build(ROOT, Path(directory))

if __name__ == '__main__':
    unittest.main()
