#!/usr/bin/env python3
"""Apply audited, body-preserving metadata decisions to imported Set List drafts.

Only files under sets/ with a draft_id present in the decision file are eligible.
The script validates the one-to-one draft mapping, date grammar, and a SHA-256
hash of every line after the H1 before it writes anything.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

DATE_RE = re.compile(r"^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2})?$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
H1_RE = re.compile(r"^# ([^\r\n]*)", re.MULTILINE)
H1_LINE_RE = re.compile(r"^# [^\r\n]*(?:\r?\n|$)", re.MULTILINE)
REPORT_PATH = Path("migration/set-list-research/reports/set-metadata-normalization.md")
TARGET_FIELDS = (
    "title",
    "gig_name",
    "date",
    "date_precision",
    "location",
    "band",
    "band_review",
    "metadata_review",
    "review_note",
)
REQUIRED_FIELDS = ("draft_id", "path", *TARGET_FIELDS, "body_after_h1_sha256")


def sha256_after_h1(body: str) -> str:
    """Hash all body bytes except the one allowed-to-change H1 line."""
    changed, count = H1_LINE_RE.subn("", body, count=1)
    if count != 1:
        raise ValueError("expected exactly one H1")
    if len(H1_RE.findall(body)) != 1:
        raise ValueError("expected exactly one H1")
    return hashlib.sha256(changed.encode("utf-8")).hexdigest()


def split_document(text: str, path: Path) -> tuple[str, str, str]:
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        raise ValueError(f"{path}: missing opening front-matter delimiter")
    parts = text.split("---", 2)
    if len(parts) != 3:
        raise ValueError(f"{path}: malformed front matter")
    prefix, front_matter, body = parts
    if not front_matter.endswith("\n") and not front_matter.endswith("\r\n"):
        raise ValueError(f"{path}: missing closing front-matter delimiter")
    return prefix, front_matter, body


def front_matter_values(front_matter: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in front_matter.splitlines():
        if ": " not in line:
            continue
        key, value = line.split(": ", 1)
        values[key] = value.strip().strip('"')
    return values


def scalar(value: str) -> str:
    if not isinstance(value, str) or "\n" in value or "\r" in value:
        raise ValueError("metadata values must be single-line strings")
    return json.dumps(value, ensure_ascii=False)


def normalized_front_matter(front_matter: str, decision: dict[str, Any]) -> str:
    """Replace only target metadata lines, retaining every other FM line verbatim."""
    newline = "\r\n" if "\r\n" in front_matter else "\n"
    retained: list[str] = []
    target_prefixes = tuple(f"{key}:" for key in TARGET_FIELDS)
    for line in front_matter.splitlines(keepends=True):
        if line.rstrip("\r\n").startswith(target_prefixes):
            continue
        retained.append(line)

    block = [f"{key}: {scalar(decision[key])}{newline}" for key in TARGET_FIELDS]
    # Keep the conventional schema/id prelude untouched, then place the
    # normalized metadata together immediately after id if it is present.
    insert_at = next(
        (index + 1 for index, line in enumerate(retained) if line.rstrip("\r\n").startswith("id:")),
        len(retained),
    )
    retained[insert_at:insert_at] = block
    result = "".join(retained)
    if not result.startswith(newline):
        result = newline + result
    if not result.endswith(newline):
        result += newline
    return result


def validate_decision(decision: dict[str, Any]) -> None:
    missing = [field for field in REQUIRED_FIELDS if field not in decision]
    if missing:
        raise ValueError(f"{decision.get('draft_id', '<unknown>')}: missing {', '.join(missing)}")
    if not DATE_RE.fullmatch(decision["date"]):
        raise ValueError(f"{decision['draft_id']}: invalid date {decision['date']!r}")
    precision = decision["date_precision"]
    if precision == "day" and not DAY_RE.fullmatch(decision["date"]):
        raise ValueError(f"{decision['draft_id']}: day precision requires YYYY-MM-DD")
    if precision == "month" and not MONTH_RE.fullmatch(decision["date"]):
        raise ValueError(f"{decision['draft_id']}: month precision requires YYYY-MM")
    if precision == "unknown" and decision["date"]:
        raise ValueError(f"{decision['draft_id']}: unknown precision requires an empty date")
    if precision not in {"day", "month", "unknown"}:
        raise ValueError(f"{decision['draft_id']}: invalid date_precision {precision!r}")
    if decision["band_review"] not in {"", "confirmed", "proposed"}:
        raise ValueError(f"{decision['draft_id']}: invalid band_review")
    if decision["metadata_review"] not in {"confirmed", "proposed"}:
        raise ValueError(f"{decision['draft_id']}: invalid metadata_review")
    for field in TARGET_FIELDS:
        scalar(decision[field])


def load_decisions(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    decisions = data.get("decisions")
    if not isinstance(decisions, list):
        raise ValueError("decision file must contain a decisions array")
    ids = [item.get("draft_id") for item in decisions]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate draft IDs in decision file")
    for decision in decisions:
        validate_decision(decision)
    return decisions


def imported_sets(root: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in sorted((root / "sets").glob("*.md")):
        _, front_matter, _ = split_document(path.read_text(encoding="utf-8"), path)
        draft_id = front_matter_values(front_matter).get("draft_id")
        if not draft_id:
            continue
        if draft_id in found:
            raise ValueError(f"duplicate draft_id {draft_id}: {found[draft_id]} and {path}")
        found[draft_id] = path
    return found


def render(path: Path, decision: dict[str, Any]) -> str:
    source = path.read_text(encoding="utf-8")
    prefix, front_matter, body = split_document(source, path)
    current_hash = sha256_after_h1(body)
    if current_hash != decision["body_after_h1_sha256"]:
        raise ValueError(f"{path}: non-H1 body hash differs from audited decision")
    def replace_h1(match: re.Match[str]) -> str:
        ending = "\r\n" if match.group(0).endswith("\r\n") else "\n" if match.group(0).endswith("\n") else ""
        return f"# {decision['title']}" + ending

    new_body, count = H1_LINE_RE.subn(replace_h1, body, count=1)
    if count != 1 or sha256_after_h1(new_body) != current_hash:
        raise ValueError(f"{path}: attempted body change outside the H1")
    return prefix + "---" + normalized_front_matter(front_matter, decision) + "---" + new_body


def render_report(decisions: list[dict[str, Any]]) -> str:
    def cell(value: str) -> str:
        return (value or "—").replace("|", "\\|").replace("\n", " ")

    confirmed = sum(item["metadata_review"] == "confirmed" for item in decisions)
    proposed = len(decisions) - confirmed
    lines = [
        "# Imported Set List metadata normalization",
        "",
        "## Scope and method",
        "",
        "This normalization applies only to the 59 imported `sets/*.md` files that carry a `draft_id`. It changes audited front matter, the H1 title, and the derived review note; ordered Set List items and all remaining body lines are hash-validated and preserved.",
        "",
        "The decisions in [`set-metadata-decisions.json`](../set-metadata-decisions.json) are explicit per `draft_id`. User-confirmed aliases override source inconsistencies; evidence-based inferences remain marked `proposed`.",
        "",
        "## Validation",
        "",
        f"- {len(decisions)} decisions: {confirmed} confirmed and {proposed} proposed.",
        "- Dates are empty, `YYYY-MM`, or `YYYY-MM-DD`, with matching precision.",
        "- Every line after the H1 is protected by a recorded SHA-256 hash.",
        "- `python3 scripts/normalize_setlist_metadata.py --check` verifies a deterministic no-op.",
        "",
        "## Decisions",
        "",
        "| File | Title | Gig name | Date | Location | Band / review | Metadata review | Rationale |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for item in sorted(decisions, key=lambda row: row["path"]):
        band = cell(item["band"])
        if item["band_review"]:
            band += f" ({item['band_review']})"
        date = cell(item["date"])
        if item["date"]:
            date += f" ({item['date_precision']})"
        lines.append(
            "| " + " | ".join([
                f"`{Path(item['path']).name}`",
                cell(item["title"]),
                cell(item["gig_name"]),
                date,
                cell(item["location"]),
                band,
                item["metadata_review"],
                cell(item["rationale"]),
            ]) + " |"
        )
    lines += [
        "",
        "## Key user-confirmed mappings",
        "",
        "- `LC`, `LC Acou`, `LC Elec`, and `LCA` map to **Loosely Covered**.",
        "- `JLL` and imported Jack London references normalize to **Jack London Lodge**.",
        "- `Berry Bros` maps to **Berry Brothers**; `SleaZZy Tom`/`SZ` map to **Sleazzy Top**; `9Tease Stripped` is both title and band.",
        "- `LC Acou: JLL - 9/22/22` is `LC Acoustic`, Loosely Covered, Jack London Lodge, dated `2022-09-22`.",
        "- Explicit `FF` pages map to **Funk Fatale**; repertoire-based assignments remain proposed.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--decisions",
        type=Path,
        default=None,
        help="defaults to migration/set-list-research/set-metadata-decisions.json under --root",
    )
    parser.add_argument("--check", action="store_true", help="fail if normalization would change a file")
    args = parser.parse_args()
    root = args.root.resolve()
    decisions_path = (args.decisions or root / "migration/set-list-research/set-metadata-decisions.json").resolve()

    try:
        decisions = load_decisions(decisions_path)
        sets_by_id = imported_sets(root)
        decision_ids = {item["draft_id"] for item in decisions}
        set_ids = set(sets_by_id)
        if decision_ids != set_ids:
            missing = sorted(set_ids - decision_ids)
            extra = sorted(decision_ids - set_ids)
            raise ValueError(f"decisions/imported sets are not one-to-one; missing={missing}, extra={extra}")

        changes: list[tuple[Path, str]] = []
        for decision in decisions:
            path = sets_by_id[decision["draft_id"]]
            expected_path = (root / decision["path"]).resolve()
            if path.resolve() != expected_path:
                raise ValueError(f"{decision['draft_id']}: path does not match decision record")
            output = render(path, decision)
            if output != path.read_text(encoding="utf-8"):
                changes.append((path, output))

        report_path = root / REPORT_PATH
        report_output = render_report(decisions)
        report_changed = not report_path.exists() or report_path.read_text(encoding="utf-8") != report_output

        if args.check:
            if changes or report_changed:
                print(f"normalization would change {len(changes)} imported draft set(s); report_changed={report_changed}", file=sys.stderr)
                return 1
            print(f"validated {len(decisions)} decisions; normalization is a deterministic no-op")
            return 0

        for path, output in changes:
            path.write_text(output, encoding="utf-8")
        if report_changed:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(report_output, encoding="utf-8")
        print(f"validated {len(decisions)} decisions; normalized {len(changes)} imported draft set(s); report_changed={report_changed}")
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
