from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURRENT_REF = "v2-phase1-content-2026-08-10"
CURRENT_COMMIT = "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5"
EVIDENCE_REF = "v2-phase1-evidence-2026-08-10"
EVIDENCE_COMMIT = "5ea535b53b94445084586828389f44c1a5136877"
CURRENT = ROOT / "migration/v2/current"
SUMMARY_SCRIPT = ROOT / "scripts/build_v2_current_bootstrap_browser_summary.py"
sys.path.insert(0, str(ROOT / "scripts"))
SUMMARY_SPEC = importlib.util.spec_from_file_location("v2_current_bootstrap_summary", SUMMARY_SCRIPT)
assert SUMMARY_SPEC and SUMMARY_SPEC.loader
current_bootstrap_summary = importlib.util.module_from_spec(SUMMARY_SPEC)
SUMMARY_SPEC.loader.exec_module(current_bootstrap_summary)
FIT_SCRIPT = ROOT / "scripts/build_v2_current_browser_fit_baseline.py"
FIT_SPEC = importlib.util.spec_from_file_location("v2_current_fit_summary", FIT_SCRIPT)
assert FIT_SPEC and FIT_SPEC.loader
current_fit_summary = importlib.util.module_from_spec(FIT_SPEC)
FIT_SPEC.loader.exec_module(current_fit_summary)


class CurrentBaselineTests(unittest.TestCase):
    def test_source_tag_and_reconciled_tree_are_exact(self) -> None:
        actual = subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", f"{CURRENT_REF}^{{commit}}"], text=True
        ).strip()
        self.assertEqual(actual, CURRENT_COMMIT)
        result = subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--exit-code", CURRENT_REF, "--", "songs", "sets", "srv"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "v1^{commit}"], text=True).strip(),
            "546f59b41d9e9bcf0e81b543c27900a31e26c9e6",
        )

    def test_evidence_tag_pins_task8_package(self) -> None:
        actual = subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", f"{EVIDENCE_REF}^{{commit}}"], text=True
        ).strip()
        self.assertEqual(actual, EVIDENCE_COMMIT)
        protected = [
            "migration/v2/current",
            "scripts/build_v2_current_backup_restore_baseline.py",
            "scripts/build_v2_current_baseline.py",
            "scripts/build_v2_current_bootstrap_baseline.py",
            "scripts/build_v2_current_bootstrap_browser_summary.py",
            "scripts/build_v2_current_browser_fit_baseline.py",
            "scripts/build_v2_current_coexistence_summary.py",
            "scripts/build_v2_current_contracts.py",
            "scripts/build_v2_current_renderer_baseline.py",
            "scripts/build_v2_current_route_baseline.py",
            "scripts/serve_v2_current_coexistence_harness.py",
            "scripts/serve_v2_current_fit_harness.py",
            "scripts/v2_current_config.py",
            "docs/v2/decisions/0007-phase1-baseline-origin.md",
            "docs/v2/tasks/TASK-008-current-content-baseline.md",
            "docs/v2/tasks/TASK-009-typed-read-model.md",
        ]
        result = subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--exit-code", EVIDENCE_REF, "--", *protected],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_corpus_and_identity_sidecars_cover_frozen_source(self) -> None:
        corpus = json.loads((CURRENT / "corpus-manifest.json").read_text(encoding="utf-8"))
        identity = json.loads((CURRENT / "identity-sidecars.json").read_text(encoding="utf-8"))
        self.assertEqual(corpus["baseline"], {"ref": CURRENT_REF, "commit": CURRENT_COMMIT})
        self.assertEqual(corpus["corpus"]["counts"], {"files": 373, "songs": 339, "sets": 34})
        self.assertEqual(corpus["corpus"]["bytes"]["total"], 748_034)
        self.assertEqual(
            identity["counts"],
            {
                "documents": 373,
                "declared_document_ids": 89,
                "sidecar_document_ids": 284,
                "slug_routes": 373,
                "set_entries": 1076,
                "resolved_set_entries": 1076,
                "unresolved_set_entries": 0,
            },
        )
        document_ids = [record["id"] for record in identity["documents"]]
        entry_ids = [record["id"] for record in identity["set_entries"]]
        self.assertEqual(len(document_ids), len(set(document_ids)))
        self.assertEqual(len(entry_ids), len(set(entry_ids)))
        self.assertEqual(len(identity["slug_routes"]), 373)
        for entry in identity["set_entries"]:
            self.assertNotIn(CURRENT_COMMIT, entry["identity_seed"])
            self.assertEqual(
                entry["identity_seed"],
                f"set-entry:{entry['set_id']}:{entry['fingerprint']}:{entry['fingerprint_occurrence']}",
            )
        by_path = {record["path"]: record for record in corpus["records"]}
        for record in identity["documents"]:
            self.assertEqual(record["source_sha256"], by_path[record["path"]]["sha256"])
        representative = by_path["songs/1979.md"]
        raw = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{CURRENT_REF}:songs/1979.md"])
        self.assertEqual(representative["sha256"], hashlib.sha256(raw).hexdigest())

    def test_current_evidence_agrees(self) -> None:
        renderer = json.loads((CURRENT / "renderer/renderer-baseline.json").read_text(encoding="utf-8"))
        fit = json.loads((CURRENT / "renderer/browser-fit-summary.json").read_text(encoding="utf-8"))
        routes = json.loads((CURRENT / "routes/route-baseline.json").read_text(encoding="utf-8"))
        route_policy = json.loads((CURRENT / "routes/route-policy.json").read_text(encoding="utf-8"))
        recovery = json.loads((CURRENT / "backup-restore/backup-restore-baseline.json").read_text(encoding="utf-8"))
        bootstrap = json.loads((CURRENT / "bootstrap/bootstrap-baseline.json").read_text(encoding="utf-8"))
        bootstrap_browser = json.loads((CURRENT / "bootstrap/browser-summary.json").read_text(encoding="utf-8"))
        coexistence = json.loads((CURRENT / "coexistence/browser-summary.json").read_text(encoding="utf-8"))
        for artifact in (renderer, fit, routes, route_policy, recovery, bootstrap, bootstrap_browser, coexistence):
            self.assertEqual(artifact["baseline"], {"ref": CURRENT_REF, "commit": CURRENT_COMMIT})
        self.assertEqual(renderer["corpus"]["success_count"], 339)
        self.assertEqual(renderer["apex"]["executable_path"], "resolved-from-PATH:apex")
        profiles = {profile["name"]: profile for profile in fit["profiles"]}
        self.assertEqual(profiles["ipad-portrait"]["status_distribution"], {"fit": 339})
        self.assertEqual(profiles["ipad-landscape"]["status_distribution"], {"fit": 334, "needs-editing": 5})
        self.assertEqual(
            profiles["ipad-landscape"]["failure_ids"],
            ["can-t-stop", "father-of-mine", "love-shack", "paradise-city", "troublemaker"],
        )
        self.assertEqual(profiles["phone"]["status_distribution"], {"scrollable": 339})
        self.assertEqual(routes["summary"]["request_case_count"], 1198)
        self.assertEqual(routes["summary"]["canonical_request_count"], 1153)
        self.assertEqual(route_policy["counts"], {"registered_routes": 27, "preserve": 12, "redirect": 1, "retire": 1, "defer": 13})
        self.assertTrue(all(recovery["failure_evidence"].values()))
        self.assertEqual(bootstrap["verification"]["documents"], 373)
        self.assertTrue(all(all(profile["logical_outcome"].values()) for profile in bootstrap_browser["profiles"]))
        self.assertTrue(all(coexistence["proof"].values()))
        self.assertEqual(coexistence["limitations"]["production_v2_shell"], "pending P1-004")

    def test_current_screenshot_metrics_are_bound_to_capture(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            captures = root / "browser-fit"
            screenshots = root / "screenshots"
            shutil.copytree(CURRENT / "renderer/browser-fit", captures)
            shutil.copytree(CURRENT / "renderer/screenshots", screenshots)
            path = captures / "ipad-portrait.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            result = next(item for item in data["results"] if item["id"] == "father-of-mine")
            result["body_px"] = 20
            path.write_text(json.dumps(data), encoding="utf-8")
            fit = current_fit_summary.configured(ROOT)
            with self.assertRaisesRegex(ValueError, "screenshot fit metrics"):
                fit.build(ROOT, CURRENT / "renderer/renderer-baseline.json", captures, screenshots)

    def test_stale_bootstrap_observation_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "browser-observations"
            shutil.copytree(CURRENT / "bootstrap/browser-observations", raw)
            path = raw / "ipad-portrait.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            data["evidence_binding"]["bootstrap_baseline_output_sha256"] = "0" * 64
            path.write_text(json.dumps(data), encoding="utf-8")
            summary = current_bootstrap_summary.configured(ROOT)
            with self.assertRaisesRegex(ValueError, "not bound to the exact bootstrap baseline"):
                summary.build(ROOT, raw)

    def test_current_generators_check_cleanly(self) -> None:
        scripts = (
            "build_v2_current_baseline.py",
            "build_v2_current_renderer_baseline.py",
            "build_v2_current_browser_fit_baseline.py",
            "build_v2_current_route_baseline.py",
            "build_v2_current_backup_restore_baseline.py",
            "build_v2_current_bootstrap_baseline.py",
            "build_v2_current_bootstrap_browser_summary.py",
            "build_v2_current_contracts.py",
            "build_v2_current_coexistence_summary.py",
        )
        for script in scripts:
            with self.subTest(script=script):
                result = subprocess.run([sys.executable, str(ROOT / "scripts" / script), "--check"], cwd=ROOT)
                self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
