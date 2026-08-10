from __future__ import annotations

import hashlib
import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class V2Phase0ExitReviewTests(unittest.TestCase):
    def test_status_backlog_and_task_agree(self) -> None:
        status = (ROOT / "docs/v2/STATUS.md").read_text(encoding="utf-8")
        backlog = (ROOT / "docs/v2/BACKLOG.md").read_text(encoding="utf-8")
        task = (ROOT / "docs/v2/tasks/TASK-007-phase-0-exit-review.md").read_text(encoding="utf-8")
        self.assertIn("Phase 1 — isolated read-only", status)
        self.assertIn("TASK-012", status)
        self.assertRegex(backlog, r"\| Done \| \[TASK-007")
        self.assertRegex(backlog, r"\| Done \| \[TASK-008")
        self.assertRegex(backlog, r"\| Done \| \[TASK-009")
        self.assertRegex(backlog, r"\| Done \| \[TASK-010")
        self.assertRegex(backlog, r"\| Done \| \[TASK-011")
        self.assertRegex(backlog, r"\| P0 \| \[TASK-012")
        self.assertIn("Status:** Done — conditional go", task)

    def test_exit_review_and_phase1_plan_record_gates(self) -> None:
        review = (ROOT / "docs/v2/PHASE-0-EXIT-REVIEW.md").read_text(encoding="utf-8")
        plan = (ROOT / "docs/v2/PHASE-1-PLAN.md").read_text(encoding="utf-8")
        architecture = (ROOT / "docs/v2/ARCHITECTURE.md").read_text(encoding="utf-8")
        for text in (review, architecture):
            self.assertIn("current-content baseline", text)
            self.assertIn("/v2/", text)
        self.assertIn("339", review)
        self.assertIn("34", review)
        self.assertIn("Conditional Phase 0 Exit", (ROOT / "docs/v2/decisions/0005-conditional-phase-0-exit.md").read_text(encoding="utf-8"))
        self.assertIn("23–39 focused engineering days", plan)
        self.assertIn("no mutation path is exposed", plan)
        self.assertIn("controller-handoff", plan)
        self.assertIn("TASK-008 artifact rather than hard-coded TASK-007 observations", plan)
        self.assertIn("Physical iPad validation", plan)

    def test_current_main_observation_is_pinned_and_self_verified(self) -> None:
        path = ROOT / "migration/v2/phase-0-exit-review.json"
        artifact = json.loads(path.read_text(encoding="utf-8"))
        review = artifact["review"]
        self.assertEqual(review["source_commit"], "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5")
        self.assertEqual(
            subprocess.check_output(
                ["git", "-C", str(ROOT), "rev-parse", f"{review['source_commit']}^{{tree}}"],
                text=True,
            ).strip(),
            review["source_tree"],
        )
        self.assertEqual(artifact["corpus"]["counts"], {"files": 373, "songs": 339, "sets": 34})
        self.assertEqual(artifact["corpus"]["bytes"]["total"], 748_034)
        self.assertEqual(artifact["corpus"]["set_link_classifications"], {"resolved canonical file": 1076})
        self.assertEqual(artifact["renderer"]["passed"], 339)
        expected_hash = artifact["verification"]["output_sha256"]
        artifact["verification"]["output_sha256"] = None
        rendered = (json.dumps(artifact, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self.assertEqual(hashlib.sha256(rendered).hexdigest(), expected_hash)

    def test_local_markdown_links_in_v2_docs_resolve(self) -> None:
        docs = ROOT / "docs/v2"
        link_pattern = re.compile(r"\[[^]]+\]\(([^)]+)\)")
        missing: list[str] = []
        for path in sorted(docs.rglob("*.md")):
            for target in link_pattern.findall(path.read_text(encoding="utf-8")):
                if target.startswith(("http://", "https://", "#")):
                    continue
                relative = target.split("#", 1)[0]
                if relative and not (path.parent / relative).resolve().exists():
                    missing.append(f"{path.relative_to(ROOT)} -> {target}")
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
