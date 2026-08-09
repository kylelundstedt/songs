from __future__ import annotations
import hashlib, importlib.util, json, subprocess, sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; SCRIPT=ROOT/'scripts/build_v2_bootstrap_baseline.py'
spec=importlib.util.spec_from_file_location('bootstrap',SCRIPT); bootstrap=importlib.util.module_from_spec(spec); assert spec.loader;spec.loader.exec_module(bootstrap)
class BootstrapBaselineTests(unittest.TestCase):
 def test_payload_exact_tagged_corpus_and_chunk_hashes(self):
  baseline=json.loads((ROOT/'migration/v2/bootstrap/bootstrap-baseline.json').read_text()); manifest=json.loads((ROOT/'migration/v2/bootstrap/payload/manifest.json').read_text())
  self.assertEqual(baseline['baseline'],{'ref':'v1','commit':bootstrap.BASELINE_COMMIT});self.assertEqual(manifest['corpus']['documents'],351);self.assertEqual(manifest['corpus']['bytes'],743078)
  expected_chunks={chunk['path'] for chunk in manifest['chunks']};actual_chunks={path.name for path in (ROOT/'migration/v2/bootstrap/payload').glob('chunk-*.json')};self.assertEqual(actual_chunks,expected_chunks)
  docs=[]
  for chunk in manifest['chunks']:
   raw=(ROOT/'migration/v2/bootstrap/payload'/chunk['path']).read_bytes();self.assertEqual(hashlib.sha256(raw).hexdigest(),chunk['sha256']);payload=json.loads(raw);self.assertEqual(payload['index'],chunk['index']);docs+=payload['documents'];self.assertEqual(sum(x['bytes'] for x in payload['documents']),chunk['source_bytes'])
  self.assertEqual(len(docs),351);self.assertEqual([x['path'] for x in docs],sorted(x['path'] for x in docs));tagged=bootstrap.archive_docs(ROOT)
  self.assertEqual([(x['path'],x['bytes'],x['sha256']) for x in docs],[(p,len(b),hashlib.sha256(b).hexdigest()) for p,b in tagged.items()]);self.assertEqual(bootstrap.sha256(bootstrap.identity_bytes(tagged)),manifest['snapshot_digest'])
 def test_harness_asset_hashes(self):
  baseline=json.loads((ROOT/'migration/v2/bootstrap/bootstrap-baseline.json').read_text())
  for name, record in baseline['assets'].items():
   raw=(ROOT/'migration/v2/bootstrap'/name).read_bytes();self.assertEqual(record,{'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
  self.assertIn('v2-bootstrap-shell-',(ROOT/'migration/v2/bootstrap/harness/sw.js').read_text())
 def test_deterministic_and_no_machine_metadata(self):
  generated=bootstrap.build(ROOT);self.assertEqual(generated[str(bootstrap.BASELINE_PATH)],(ROOT/bootstrap.BASELINE_PATH).read_bytes())
  for raw in generated.values():self.assertNotIn(str(ROOT).encode(),raw);self.assertNotIn(b'"timestamp"',raw)
 def test_generator_check(self):self.assertEqual(subprocess.run([sys.executable,str(SCRIPT),'--check'],cwd=ROOT).returncode,0)
if __name__=='__main__':unittest.main()
