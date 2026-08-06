#!/usr/bin/env python3
"""Export read-only Notion Lead Sheets into review-only Markdown candidates.

The script intentionally discovers and queries only the "Lead Sheets" database. It
never retrieves Member pages or writes to Notion. Generated files are confined to
migration/notion-candidates (unless --output is explicitly supplied).
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

DEFAULT_API_BASE = "https://notion-songs.int.exe.xyz/v1"
DEFAULT_NOTION_VERSION = "2022-06-28"
DEFAULT_OUTPUT = Path("migration/notion-candidates")
SUPPORTED_TYPES = {
    "heading_1",
    "heading_2",
    "heading_3",
    "paragraph",
    "column_list",
    "column",
    "bulleted_list_item",
    "numbered_list_item",
    "divider",
}
MUSIC_KEY_QUALIFIER = re.compile(
    r"\s*\((?:[A-G](?:#|b)?(?:m|maj|min|minor)?|acoustic|electric)\)\s*$",
    re.IGNORECASE,
)


class NotionClient:
    def __init__(self, api_base: str, notion_version: str) -> None:
        self.api_base = api_base.rstrip("/")
        self.notion_version = notion_version
        self.calls: list[str] = []

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.api_base}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Notion-Version": self.notion_version,
            },
        )
        self.calls.append(f"{method} {path}")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Notion API {method} {path} failed ({error.code}): {detail}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Notion API {method} {path} failed: {error.reason}") from error


def plain_text(rich_text: Iterable[dict[str, Any]]) -> str:
    """Return visible text only; URLs and mention metadata are deliberately excluded."""
    return "".join(str(part.get("plain_text", "")) for part in rich_text)


def database_title(item: dict[str, Any]) -> str:
    return plain_text(item.get("title", []))


def discover_lead_sheets_database(client: NotionClient) -> str:
    """Search database objects only, then select the exact Lead Sheets database."""
    cursor: str | None = None
    matches: list[dict[str, Any]] = []
    while True:
        payload: dict[str, Any] = {
            "filter": {"property": "object", "value": "database"},
            "page_size": 100,
        }
        if cursor:
            payload["start_cursor"] = cursor
        page = client.request("POST", "/search", payload)
        matches.extend(item for item in page.get("results", []) if database_title(item) == "Lead Sheets")
        if not page.get("has_more"):
            break
        cursor = page.get("next_cursor")
        if not cursor:
            raise RuntimeError("Notion search reported more results without next_cursor")
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one Lead Sheets database, found {len(matches)}")
    return str(matches[0]["id"])


def query_database_pages(client: NotionClient, database_id: str) -> list[dict[str, Any]]:
    cursor: str | None = None
    pages: list[dict[str, Any]] = []
    while True:
        payload: dict[str, Any] = {"page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor
        result = client.request("POST", f"/databases/{database_id}/query", payload)
        pages.extend(result.get("results", []))
        if not result.get("has_more"):
            break
        cursor = result.get("next_cursor")
        if not cursor:
            raise RuntimeError("Notion database query reported more results without next_cursor")
    return pages


def page_title(page: dict[str, Any]) -> str:
    title_properties = [value for value in page.get("properties", {}).values() if value.get("type") == "title"]
    if len(title_properties) != 1:
        raise RuntimeError(f"Page {page.get('id')} has {len(title_properties)} title properties")
    title = plain_text(title_properties[0].get("title", [])).strip()
    return title or "Untitled"


def slugify(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_value).strip("-")
    return slug or "untitled"


def normalized_title(value: str) -> str:
    without_key = MUSIC_KEY_QUALIFIER.sub("", value).casefold()
    decomposed = unicodedata.normalize("NFKD", without_key)
    return "".join(char for char in decomposed if char.isalnum()) or "untitled"


def yaml_string(value: str) -> str:
    # JSON quoted strings are valid YAML scalar strings and make output unambiguous.
    return json.dumps(value, ensure_ascii=False)


def escape_inline(value: str) -> str:
    """Keep imported text literal enough to avoid accidental Markdown syntax."""
    return re.sub(r"([\\`*_[\]<>])", r"\\\1", value)


def rich_text_to_markdown(rich_text: Iterable[dict[str, Any]]) -> str:
    """Render visible text and basic non-link annotations; do not import URLs."""
    pieces: list[str] = []
    for part in rich_text:
        text = escape_inline(str(part.get("plain_text", "")))
        annotations = part.get("annotations", {})
        if annotations.get("code"):
            # Escaping inside code spans is confusing, so preserve literal visible text instead.
            text = escape_inline(str(part.get("plain_text", "")))
        else:
            if annotations.get("bold"):
                text = f"**{text}**"
            if annotations.get("italic"):
                text = f"*{text}*"
            if annotations.get("strikethrough"):
                text = f"~~{text}~~"
        pieces.append(text)
    return "".join(pieces)


def escape_line_start(value: str) -> str:
    """Prevent a paragraph's first line from becoming an unintended Markdown block."""
    if re.match(r"^\s*(?:#{1,6}\s|[-+*]\s|>\s|\d+[.)]\s|[|])", value):
        leading = len(value) - len(value.lstrip())
        return value[:leading] + "\\" + value[leading:]
    return value


def hard_break_paragraph(value: str) -> str:
    # A Notion newline belongs to one paragraph, so make it a Markdown hard line break.
    return "  \n".join(escape_line_start(line) for line in value.split("\n"))


class BlockRenderer:
    def __init__(self, client: NotionClient) -> None:
        self.client = client
        self.children_cache: dict[str, list[dict[str, Any]]] = {}
        self.block_types: collections.Counter[str] = collections.Counter()
        self.unsupported_types: collections.Counter[str] = collections.Counter()
        self.fetched_block_count = 0

    def children(self, block: dict[str, Any]) -> list[dict[str, Any]]:
        if not block.get("has_children"):
            return []
        block_id = str(block["id"])
        if block_id in self.children_cache:
            return self.children_cache[block_id]
        cursor: str | None = None
        results: list[dict[str, Any]] = []
        while True:
            suffix = f"?page_size=100" + (f"&start_cursor={cursor}" if cursor else "")
            response = self.client.request("GET", f"/blocks/{block_id}/children{suffix}")
            results.extend(response.get("results", []))
            if not response.get("has_more"):
                break
            cursor = response.get("next_cursor")
            if not cursor:
                raise RuntimeError(f"Block {block_id} reported more children without next_cursor")
        self.children_cache[block_id] = results
        return results

    def render_children(self, blocks: Iterable[dict[str, Any]], indent: str = "") -> list[str]:
        output: list[str] = []
        for block in blocks:
            output.extend(self.render_block(block, indent))
        return output

    def render_block(self, block: dict[str, Any], indent: str = "") -> list[str]:
        block_type = str(block.get("type", "unknown"))
        self.fetched_block_count += 1
        self.block_types[block_type] += 1
        payload = block.get(block_type, {})
        lines: list[str]
        child_indent = indent

        if block_type in {"heading_1", "heading_2", "heading_3"}:
            # Reserve the document H1 for the database title, retaining source hierarchy below it.
            source_level = int(block_type[-1])
            lines = [indent + "#" * (source_level + 1) + " " + rich_text_to_markdown(payload.get("rich_text", []))]
        elif block_type == "paragraph":
            lines = [indent + hard_break_paragraph(rich_text_to_markdown(payload.get("rich_text", [])))]
        elif block_type == "bulleted_list_item":
            lines = [indent + "- " + hard_break_paragraph(rich_text_to_markdown(payload.get("rich_text", [])))]
            child_indent = indent + "  "
        elif block_type == "numbered_list_item":
            # Markdown's 1. marker retains ordered-list semantics and is stable across pagination.
            lines = [indent + "1. " + hard_break_paragraph(rich_text_to_markdown(payload.get("rich_text", [])))]
            child_indent = indent + "   "
        elif block_type == "divider":
            lines = [indent + "---"]
        elif block_type in {"column_list", "column"}:
            # Children are fetched in Notion's declared array order: columns left-to-right,
            # then each column's top-to-bottom block order.
            lines = []
        else:
            self.unsupported_types[block_type] += 1
            lines = [
                indent
                + f"> **Migration review:** unsupported Notion block type `{block_type}` "
                + f"(source block `{block.get('id', 'unknown')}`) was not converted."
            ]

        nested = self.children(block)
        if nested:
            lines.extend(self.render_children(nested, child_indent))
        return lines


def write_candidate(
    directory: Path,
    page: dict[str, Any],
    database_id: str,
    body_lines: list[str],
) -> tuple[Path, str]:
    title = page_title(page)
    source_id = str(page["id"])
    # The source UUID is always part of a candidate path. This gives duplicate normalized
    # titles stable, collision-free names without assigning any canonical song identity.
    filename = f"{slugify(title)}--{source_id.replace('-', '')}.md"
    path = directory / filename
    front_matter = "\n".join(
        [
            "---",
            f"title: {yaml_string(title)}",
            f"notion_source_id: {yaml_string(source_id)}",
            f"notion_created_time: {yaml_string(str(page.get('created_time', '')))}",
            f"notion_last_edited_time: {yaml_string(str(page.get('last_edited_time', '')))}",
            f"notion_database_id: {yaml_string(database_id)}",
            "migration_candidate: true",
            "---",
            "",
            "# " + title.replace("\n", " "),
            "",
        ]
    )
    body = "\n\n".join(line for line in body_lines if line != "")
    content = front_matter + (body + "\n" if body else "")
    path.write_text(content, encoding="utf-8")
    return path, hashlib.sha256(content.encode("utf-8")).hexdigest()


def validate_apex(paths: list[Path], apex_bin: str) -> list[dict[str, str]]:
    failures: list[dict[str, str]] = []
    for path in paths:
        command = [apex_bin, "--no-plugins", "--no-unsafe", "-m", "gfm", "-o", os.devnull, str(path)]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode:
            failures.append(
                {
                    "path": path.name,
                    "exit_code": str(result.returncode),
                    "stderr": result.stderr.strip()[-2000:],
                }
            )
    return failures


def write_manifest_and_review(
    directory: Path,
    api_base: str,
    notion_version: str,
    database_id: str,
    records: list[dict[str, Any]],
    duplicate_groups: dict[str, list[dict[str, Any]]],
    global_block_types: collections.Counter[str],
    global_unsupported: collections.Counter[str],
    apex_failures: list[dict[str, str]] | None,
) -> None:
    manifest = {
        "manifest_version": 1,
        "source": {
            "provider": "notion",
            "api_base": api_base,
            "notion_version": notion_version,
            "database_id": database_id,
            "database_title": "Lead Sheets",
            "scope": "Lead Sheets records only; Members records and properties were not queried or imported.",
        },
        "candidate_count": len(records),
        "block_types": dict(sorted(global_block_types.items())),
        "unsupported_block_types": dict(sorted(global_unsupported.items())),
        "records": records,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    empty_count = sum(1 for record in records if record["empty_body"])
    unsupported_count = sum(1 for record in records if record["unsupported_block_types"])
    report = [
        "# Notion Lead Sheets migration review",
        "",
        "## Scope and safeguards",
        "",
        "- Read-only Notion API export from the `Lead Sheets` database only.",
        "- No Members records or Member properties were queried or imported.",
        "- Files are review candidates only; no canonical song path is read, changed, or overwritten.",
        "- Candidate filenames are `<normalized-title>--<Notion-page-UUID>.md`, so collisions remain stable and distinct.",
        "",
        "## Counts",
        "",
        f"- Lead Sheets records exported: **{len(records)}**",
        f"- Candidate Markdown files: **{len(records)}**",
        f"- Empty converted bodies: **{empty_count}**",
        f"- Candidates with unsupported blocks noted inline: **{unsupported_count}**",
        f"- Duplicate normalized-title groups: **{len(duplicate_groups)}**",
        "",
        "## Converted block types",
        "",
    ]
    for block_type, count in sorted(global_block_types.items()):
        status = "converted" if block_type in SUPPORTED_TYPES else "not converted (inline review notice)"
        report.append(f"- `{block_type}`: {count} — {status}")
    report.extend(
        [
            "",
            "## Duplicate normalized titles",
            "",
        ]
    )
    if duplicate_groups:
        for identity, group in sorted(duplicate_groups.items()):
            titles = "; ".join(f"{record['title']} (`{record['candidate_path']}`)" for record in group)
            report.append(f"- `{identity}` ({len(group)}): {titles}")
    else:
        report.append("- None")
    report.extend(
        [
            "",
            "## Rendering validation",
            "",
        ]
    )
    if apex_failures is None:
        report.append("- Not run (invoke with `--validate-apex`).")
    elif apex_failures:
        report.append(f"- **Failed:** {len(apex_failures)} candidate(s). See `apex-validation-failures.json`.")
        (directory / "apex-validation-failures.json").write_text(
            json.dumps(apex_failures, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    else:
        report.append("- **Passed:** all candidate Markdown files rendered with Apex using `--no-plugins --no-unsafe -m gfm`.")
    report.extend(
        [
            "",
            "## Limitations requiring review",
            "",
            "- Notion page bodies are presentation-oriented; columns are flattened left-to-right, then top-to-bottom within each column.",
            "- Literal newlines inside a Notion paragraph become Markdown hard line breaks.",
            "- Visible rich text is retained, but source links/URLs and unsupported inline-only formatting are intentionally not imported.",
            "- Unsupported block types are not guessed; each is called out in its candidate and recorded in `manifest.json`.",
            "- This is an API-visible snapshot, not Notion history or a bidirectional synchronization mechanism.",
            "",
        ]
    )
    (directory / "REVIEW.md").write_text("\n".join(report), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--notion-version", default=DEFAULT_NOTION_VERSION)
    parser.add_argument("--database-id", help="Optional Lead Sheets database UUID; otherwise discover it by exact title.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--expected-count", type=int, default=293, help="Fail if the Lead Sheets query does not return this count (0 disables).")
    parser.add_argument("--validate-apex", action="store_true", help="Render every generated candidate through Apex before publishing output.")
    parser.add_argument("--apex-bin", default="apex")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = NotionClient(args.api_base, args.notion_version)
    database_id = args.database_id or discover_lead_sheets_database(client)
    pages = query_database_pages(client, database_id)
    if args.expected_count and len(pages) != args.expected_count:
        raise RuntimeError(
            f"Lead Sheets record count changed: expected {args.expected_count}, received {len(pages)}. "
            "Re-run with --expected-count 0 only after reviewing the source change."
        )

    # Stable data ordering means output bytes and duplicate reporting do not depend on API pagination order.
    pages.sort(key=lambda page: (normalized_title(page_title(page)), slugify(page_title(page)), str(page["id"])))
    output = args.output.resolve()
    repository_root = Path(__file__).resolve().parent.parent
    migration_root = (repository_root / "migration").resolve()
    if not output.is_relative_to(migration_root):
        raise RuntimeError(f"Refusing output outside the dedicated migration directory: {output}")
    output_parent = output.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.stage-", dir=output_parent))
    try:
        records: list[dict[str, Any]] = []
        global_block_types: collections.Counter[str] = collections.Counter()
        global_unsupported: collections.Counter[str] = collections.Counter()
        candidate_paths: list[Path] = []
        for page in pages:
            renderer = BlockRenderer(client)
            root = {"id": page["id"], "has_children": True}
            lines = renderer.render_children(renderer.children(root))
            path, content_sha256 = write_candidate(stage, page, database_id, lines)
            candidate_paths.append(path)
            global_block_types.update(renderer.block_types)
            global_unsupported.update(renderer.unsupported_types)
            records.append(
                {
                    "title": page_title(page),
                    "normalized_title": normalized_title(page_title(page)),
                    "source_id": str(page["id"]),
                    "source_created_time": str(page.get("created_time", "")),
                    "source_last_edited_time": str(page.get("last_edited_time", "")),
                    "candidate_path": path.name,
                    "content_sha256": content_sha256,
                    "fetched_block_count": renderer.fetched_block_count,
                    "block_types": dict(sorted(renderer.block_types.items())),
                    "unsupported_block_types": dict(sorted(renderer.unsupported_types.items())),
                    "empty_body": not any(line.strip() for line in lines),
                }
            )

        duplicate_groups = {
            identity: group
            for identity, group in itertools_groupby_records(records).items()
            if len(group) > 1
        }
        apex_failures = validate_apex(candidate_paths, args.apex_bin) if args.validate_apex else None
        write_manifest_and_review(
            stage,
            args.api_base,
            args.notion_version,
            database_id,
            records,
            duplicate_groups,
            global_block_types,
            global_unsupported,
            apex_failures,
        )
        if apex_failures:
            raise RuntimeError(f"Apex validation failed for {len(apex_failures)} candidate(s); staged output retained at {stage}")

        if output.exists():
            shutil.rmtree(output)
        stage.rename(output)
        print(
            json.dumps(
                {
                    "candidate_count": len(records),
                    "output": str(output),
                    "apex_validation": "passed" if args.validate_apex else "not_run",
                    "unsupported_block_types": dict(sorted(global_unsupported.items())),
                },
                sort_keys=True,
            )
        )
        return 0
    except Exception:
        # Preserve stages on failure so the reviewable diagnostics are available.
        print(f"Export failed; staged output retained at {stage}", file=sys.stderr)
        raise


def itertools_groupby_records(records: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for record in records:
        groups[str(record["normalized_title"])].append(record)
    return dict(groups)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
