#!/usr/bin/env python3
"""List or publish one server-accepted V2 Set List revision."""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "var" / "writable"
RELEASE = ROOT / "var" / "releases" / "writable-compact-16cc93bd99a78dac"
OWNER = "klundstedt@industryvault.com"
PUBLISHER_DEVICE = "device-v2-publisher"
BRANCH = "refs/heads/v2-published"
REMOTE = "https://github.int.exe.xyz/kylelundstedt/songs.git"


def pending_set_lists() -> list[dict[str, str]]:
    connection = sqlite3.connect(f"file:{STATE / 'sync.sqlite3'}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT d.document_id,d.title,d.current_revision_id,
                   COALESCE(p.revision_id,''),r.payload
            FROM v2sync_documents AS d
            JOIN v2sync_revisions AS r
              ON r.owner_id=d.owner_id AND r.revision_id=d.current_revision_id
            LEFT JOIN v2sync_publications AS p
              ON p.owner_id=d.owner_id AND p.document_id=d.document_id
            WHERE d.owner_id=? AND d.current_revision_id<>COALESCE(p.revision_id,'')
            ORDER BY d.title,d.document_id
            """,
            (OWNER,),
        ).fetchall()
    finally:
        connection.close()

    result: list[dict[str, str]] = []
    for document_id, title, current_revision, published_revision, payload in rows:
        decoded = json.loads(payload)
        if decoded.get("kind") == "set-list":
            result.append(
                {
                    "document_id": document_id,
                    "title": title,
                    "current_revision": current_revision,
                    "published_revision": published_revision,
                }
            )
    return result


def publish(item: dict[str, str]) -> None:
    command = [
        str(RELEASE / "v2publisher"),
        "-enabled",
        "-mode=publish",
        f"-ledger={STATE / 'publication.sqlite3'}",
        f"-sync={STATE / 'sync.sqlite3'}",
        f"-repository={REMOTE}",
        f"-branch={BRANCH}",
        f"-work-root={STATE / 'git-work'}",
        f"-owner={OWNER}",
        f"-device={PUBLISHER_DEVICE}",
        f"-document={item['document_id']}",
        f"-revision={item['current_revision']}",
        "-holder=manual-set-list-publisher",
        "-apex=/usr/local/bin/apex",
        f"-lock={STATE / 'publication.lock'}",
    ]
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", metavar="DOCUMENT_ID", help="publish exactly one pending Set List")
    args = parser.parse_args()

    pending = pending_set_lists()
    if args.publish is None:
        if not pending:
            print("No pending Set List publications.")
            return 0
        for item in pending:
            print(f"{item['document_id']}\t{item['current_revision']}\t{item['title']}")
        return 0

    matches = [item for item in pending if item["document_id"] == args.publish]
    if len(matches) != 1:
        parser.error(f"{args.publish!r} is not exactly one pending Set List document")
    publish(matches[0])
    print(f"Published {matches[0]['title']} ({matches[0]['document_id']}) at {matches[0]['current_revision']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
