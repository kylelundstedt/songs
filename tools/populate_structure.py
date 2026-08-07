#!/usr/bin/env python3
"""Add reviewed section headings without rewriting canonical lead-sheet text."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import populate_keys
import populate_metadata as metadata

ROOT = Path(__file__).resolve().parents[1]
HEADING_RE = re.compile(r"^#{2,6}\s+(.+?)\s*$")
VALID_HEADING_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 &'()\[\]+,./:;?!#=-]{0,79}$")


def tokens(value: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", metadata.ascii_text(value).lower())


def clean_heading(value: str) -> str:
    value = metadata.ascii_text(value).replace("\u00a0", " ").replace("**", "").replace("__", "")
    value = re.sub(r"[^A-Za-z0-9 &'()\[\]+,./:;?!#=-]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" #*_")
    value = re.sub(r"(?i)^prechorus", "Pre-Chorus", value)
    return value[:80].strip()


def has_structure(text: str) -> bool:
    _, body = metadata.split_front_matter(text)
    return bool(re.search(r"^#{2,6}\s+\S", body, re.M))


def content_lines(text: str) -> list[dict]:
    _, body = metadata.split_front_matter(text)
    result = []
    for physical_index, line in enumerate(body.splitlines()):
        if not line.strip() or re.match(r"^#\s+", line) or HEADING_RE.match(line):
            continue
        result.append({"number": len(result) + 1, "physical_index": physical_index, "text": line})
    return result


def notion_sections(text: str) -> list[dict]:
    _, body = metadata.split_front_matter(text)
    sections = []
    current = None
    for line in body.splitlines():
        match = HEADING_RE.match(line)
        if match:
            if current:
                sections.append(current)
            current = {"heading": clean_heading(match.group(1)), "tokens": []}
        elif current is not None and line.strip() and not re.match(r"^#\s+", line):
            current["tokens"].extend(tokens(line))
    if current:
        sections.append(current)
    return [section for section in sections if section["heading"]]


def prefix_similarity(left: list[str], right: list[str]) -> float:
    if not left or not right:
        return 0.0
    left = left[: min(18, len(left))]
    right = right[: max(18, len(left) + 5)]
    sequence = difflib.SequenceMatcher(None, " ".join(left), " ".join(right), autojunk=False).ratio()
    containment = len(set(left) & set(right)) / max(1, len(set(left)))
    return 0.65 * sequence + 0.35 * containment


def align_notion(text: str, notion_text: str) -> list[dict] | None:
    lines = content_lines(text)
    sections = notion_sections(notion_text)
    if len(lines) < 2 or len(sections) < 2:
        return None
    plan = []
    start = 0
    for index, section in enumerate(sections):
        if not section["tokens"]:
            if index == 0:
                plan.append({"heading": section["heading"], "before_line": 1, "confidence": 1.0})
            continue
        best_score, best_index = -1.0, -1
        for candidate in range(start, len(lines)):
            window = []
            for line in lines[candidate : candidate + 5]:
                window.extend(tokens(line["text"]))
            score = prefix_similarity(section["tokens"], window)
            if score > best_score:
                best_score, best_index = score, candidate
        if best_score < 0.52:
            return None
        plan.append({"heading": section["heading"], "before_line": best_index + 1, "confidence": round(best_score, 4)})
        start = best_index + 1
    distinct = {item["before_line"] for item in plan}
    if len(plan) < 2 or len(distinct) < 2:
        return None
    return plan


def validate_plan(plan: list[dict], line_count: int) -> list[dict]:
    if not 2 <= len(plan) <= 40:
        raise ValueError("plan must contain 2–40 headings")
    cleaned = []
    previous = 0
    for item in plan:
        heading = clean_heading(str(item.get("heading", "")))
        before = int(item.get("before_line", 0))
        if not VALID_HEADING_RE.match(heading):
            raise ValueError(f"invalid heading {heading!r}")
        if before < 1 or before > line_count or before < previous:
            raise ValueError(f"invalid heading position {before}")
        previous = before
        cleaned.append({"heading": heading, "before_line": before,
                        "confidence": round(float(item.get("confidence", 0.7)), 4)})
    return cleaned


def build_proposals(root: Path = ROOT) -> dict:
    notion = metadata.read_notion(root)
    proposals = []
    for song in metadata.read_catalog(root):
        path = root / song["path"]
        text = path.read_text()
        if has_structure(text):
            continue
        lines = content_lines(text)
        record = metadata.match_notion(song["title"], notion)
        plan = None
        notion_info = None
        if record:
            candidate = root / "migration/notion-candidates" / record["candidate_path"]
            if candidate.exists():
                notion_info = {"title": record["title"], "path": str(candidate.relative_to(root)),
                               "headings": [section["heading"] for section in notion_sections(candidate.read_text())]}
                plan = align_notion(text, candidate.read_text())
        validated_plan = None
        if plan:
            try:
                validated_plan = validate_plan(plan, len(lines))
            except ValueError:
                validated_plan = None
        proposal = {
            "id": song["id"], "path": song["path"], "title": song["title"],
            "body_sha256": hashlib.sha256(metadata.split_front_matter(text)[1].encode()).hexdigest(),
            "content_line_count": len(lines), "content_lines": [{"number": x["number"], "text": x["text"]} for x in lines],
            "notion": notion_info, "source": "notion-aligned" if validated_plan else "model-needed",
            "plan": validated_plan,
        }
        proposals.append(proposal)
    return {"song_count": len(proposals), "songs": proposals}


def merge_decisions(proposals_path: Path, decisions_paths: list[Path], output: Path):
    document = json.loads(proposals_path.read_text())
    decisions = {}
    for path in decisions_paths:
        for decision in json.loads(path.read_text()).get("decisions", []):
            decisions[decision["id"]] = decision
    for proposal in document["songs"]:
        decision = decisions.get(proposal["id"])
        if decision:
            proposal["plan"] = validate_plan(decision["plan"], proposal["content_line_count"])
            proposal["source"] = decision.get("source", "model-estimated")
            proposal["review_note"] = decision.get("review_note", "")
    output.write_text(json.dumps(document, indent=2) + "\n")


def apply_proposals(path: Path, root: Path = ROOT) -> list[str]:
    document = json.loads(path.read_text())
    changed = []
    for proposal in document["songs"]:
        if not proposal.get("plan"):
            continue
        source = root / proposal["path"]
        text = source.read_text()
        front, body = metadata.split_front_matter(text)
        if has_structure(text):
            continue
        if hashlib.sha256(body.encode()).hexdigest() != proposal["body_sha256"]:
            raise RuntimeError(f"body changed since proposal: {proposal['path']}")
        numbered = content_lines(text)
        plan = validate_plan(proposal["plan"], len(numbered))
        insertions = {}
        for item in plan:
            physical = numbered[item["before_line"] - 1]["physical_index"]
            insertions.setdefault(physical, []).append(item["heading"])
        original_lines = body.splitlines()
        output_lines = []
        for index, line in enumerate(original_lines):
            if index in insertions:
                if output_lines and output_lines[-1] != "":
                    output_lines.append("")
                for heading in insertions[index]:
                    output_lines.append("### " + heading)
                output_lines.append("")
            output_lines.append(line)
        new_body = "\n".join(output_lines)
        if body.endswith("\n"):
            new_body += "\n"
        values = metadata.parse_front_matter(text)
        values["structure_status"] = "estimated"
        values["structure_source"] = proposal["source"]
        populate_keys.write_metadata(source, values, new_body)
        changed.append(proposal["path"])
    return changed


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    propose = sub.add_parser("propose")
    propose.add_argument("--output", type=Path, default=ROOT / "metadata/structure-proposals.json")
    merge = sub.add_parser("merge")
    merge.add_argument("--proposals", type=Path, required=True)
    merge.add_argument("--decisions", type=Path, nargs="+", required=True)
    merge.add_argument("--output", type=Path, default=ROOT / "metadata/structure-proposals.json")
    apply_cmd = sub.add_parser("apply")
    apply_cmd.add_argument("--proposals", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "propose":
        result = build_proposals()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    elif args.command == "merge":
        merge_decisions(args.proposals, args.decisions, args.output)
    else:
        for changed in apply_proposals(args.proposals):
            print(changed)


if __name__ == "__main__":
    main()
