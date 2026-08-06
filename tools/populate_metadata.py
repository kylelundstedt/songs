#!/usr/bin/env python3
"""Build and apply auditable metadata proposals for canonical lead sheets."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = "KGLSongsMetadata/0.1 (klundstedt@industryvault.com)"
LEGACY_COMMIT = "6cfbda8e4d8a99e8fbe2762d7e4a5add89b5f659"
PILOT_IDS = [
    "1979", "billie-jean", "brown-eyed-girl", "crazy", "crash",
    "feels-sheriff", "home", "home-live", "i-shot-the-sheriff", "jolene",
    "juice", "love-shack", "melt-with-you", "redemption-song-live",
    "ring-of-fire", "song-2", "superstition-single-version", "walk",
    "white-wedding", "you-oughta-know",
]
KEY_RE = re.compile(r"(?:\(|\s)([A-G](?:#|b)?m?)\)?(?:\s*(?:-|/|\+).*)?$", re.I)
FRONT_MATTER_RE = re.compile(r"\A---\n(.*?)\n---\n+", re.S)


def ascii_text(value: str) -> str:
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()


def identity(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", ascii_text(value).lower().replace("&", "and"))


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", ascii_text(value).lower()).strip("-")


def title_from_markdown(text: str, fallback: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", split_front_matter(text)[1], re.M)
    return match.group(1).strip() if match else fallback


def split_front_matter(text: str) -> tuple[str, str]:
    match = FRONT_MATTER_RE.match(text)
    return (match.group(1), text[match.end():]) if match else ("", text)


def parse_front_matter(text: str) -> dict[str, str]:
    raw, _ = split_front_matter(text)
    values: dict[str, str] = {}
    for line in raw.splitlines():
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$", line)
        if match:
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[match.group(1)] = value
    return values


def lyric_tokens(markdown: str) -> list[str]:
    _, body = split_front_matter(markdown)
    lines = []
    for line in body.splitlines():
        if re.match(r"^#{1,6}\s", line):
            continue
        line = re.sub(r"\([^)]*(?:solo|break|repeat|bars?|times?|x)[^)]*\)", " ", line, flags=re.I)
        line = re.sub(r"\b\d+\s*x\b", " ", line, flags=re.I)
        lines.append(line)
    words = re.findall(r"[a-z0-9']+", ascii_text("\n".join(lines)).lower())
    stop = {"intro", "verse", "chorus", "bridge", "outro", "prechorus", "break", "solo"}
    return [word.strip("'") for word in words if len(word.strip("'")) > 1 and word not in stop]


def lyric_similarity(left: list[str], right_text: str) -> float:
    right = re.findall(r"[a-z0-9']+", ascii_text(right_text).lower())
    if not left or not right:
        return 0.0
    left_set, right_set = set(left), set(right)
    containment = len(left_set & right_set) / max(1, min(len(left_set), len(right_set)))
    left_sample = " ".join(left[:900])
    right_sample = " ".join(right[:900])
    sequence = difflib.SequenceMatcher(None, left_sample, right_sample, autojunk=False).ratio()
    return round(0.72 * containment + 0.28 * sequence, 4)


def ratio(left: str, right: str) -> float:
    return difflib.SequenceMatcher(None, identity(left), identity(right), autojunk=False).ratio()


def read_catalog(root: Path = ROOT) -> list[dict]:
    songs = []
    for path in sorted((root / "songs").glob("*.md")):
        text = path.read_text(encoding="utf-8")
        song_id = slug(path.stem)
        songs.append({
            "id": song_id,
            "path": str(path.relative_to(root)),
            "title": title_from_markdown(text, path.stem),
            "body_sha256": hashlib.sha256(split_front_matter(text)[1].encode()).hexdigest(),
            "tokens": lyric_tokens(text),
            "metadata": parse_front_matter(text),
        })
    return songs


def read_notion(root: Path = ROOT) -> dict[str, dict]:
    manifest = json.loads((root / "migration/notion-candidates/manifest.json").read_text())
    return {identity(record["normalized_title"]): record for record in manifest["records"]}


class Client:
    def __init__(self, cache_dir: Path, timeout: int = 25):
        self.cache_dir = cache_dir
        self.timeout = timeout
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.last_musicbrainz = 0.0

    def json(self, url: str, namespace: str, delay: float = 0.0):
        key = hashlib.sha256(url.encode()).hexdigest()
        path = self.cache_dir / namespace / f"{key}.json"
        if path.exists():
            return json.loads(path.read_text())
        if delay:
            time.sleep(delay)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    data = json.load(response)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(data, ensure_ascii=False))
                return data
            except urllib.error.HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise
                time.sleep(2 ** attempt)
            except urllib.error.URLError:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("unreachable")

    def lrclib(self, title: str):
        url = "https://lrclib.net/api/search?" + urllib.parse.urlencode({"track_name": title})
        return self.json(url, "lrclib", 0.25), url

    def musicbrainz(self, title: str, artist: str):
        elapsed = time.monotonic() - self.last_musicbrainz
        if elapsed < 1.05:
            time.sleep(1.05 - elapsed)
        query = f'recording:"{title}" AND artist:"{artist}"'
        url = "https://musicbrainz.org/ws/2/recording?" + urllib.parse.urlencode({"query": query, "fmt": "json", "limit": 8})
        data = self.json(url, "musicbrainz")
        self.last_musicbrainz = time.monotonic()
        return data, url

    def deezer(self, title: str, artist: str):
        query = f'artist:"{artist}" track:"{title}"'
        url = "https://api.deezer.com/search?" + urllib.parse.urlencode({"q": query, "limit": 8})
        return self.json(url, "deezer"), url

    def deezer_track(self, track_id: int):
        url = f"https://api.deezer.com/track/{track_id}"
        return self.json(url, "deezer"), url


def rank_lrclib(song: dict, records: list[dict]) -> list[dict]:
    ranked = []
    for record in records:
        title_score = ratio(song["title"], record.get("trackName") or record.get("name") or "")
        lyrics_score = lyric_similarity(song["tokens"], record.get("plainLyrics") or "")
        score = round(0.30 * title_score + 0.70 * lyrics_score, 4)
        ranked.append({
            "id": record.get("id"), "title": record.get("trackName") or record.get("name"),
            "artist": record.get("artistName"), "album": record.get("albumName"),
            "duration_seconds": record.get("duration"), "title_score": round(title_score, 4),
            "lyrics_score": lyrics_score, "score": score,
            "lyrics_sha256": hashlib.sha256((record.get("plainLyrics") or "").encode()).hexdigest(),
        })
    return sorted(ranked, key=lambda item: item["score"], reverse=True)[:8]


def ambiguity(ranked: list[dict]) -> bool:
    if len(ranked) < 2:
        return False
    best = ranked[0]
    for other in ranked[1:4]:
        if identity(other.get("artist") or "") != identity(best.get("artist") or "") and best["score"] - other["score"] < 0.07:
            return True
    return False


def best_musicbrainz(data: dict, title: str, artist: str, duration) -> dict:
    choices = []
    for recording in data.get("recordings", []):
        credits = "".join(part.get("name", "") for part in recording.get("artist-credit", []))
        title_score, artist_score = ratio(title, recording.get("title", "")), ratio(artist, credits)
        length = (recording.get("length") or 0) / 1000
        duration_score = 1.0 if not duration or not length else max(0.0, 1 - abs(float(duration) - length) / 90)
        score = 0.45 * title_score + 0.40 * artist_score + 0.15 * duration_score
        releases = recording.get("releases") or []
        choices.append({"recording_mbid": recording.get("id"), "title": recording.get("title"), "artist": credits,
                        "duration_seconds": round(length) if length else None,
                        "release": releases[0].get("title") if releases else None, "score": round(score, 4)})
    return max(choices, key=lambda item: item["score"], default={})


def best_deezer(data: dict, title: str, artist: str, duration) -> dict:
    choices = []
    for track in data.get("data", []):
        track_artist = (track.get("artist") or {}).get("name", "")
        track_duration = track.get("duration") or 0
        duration_score = 1.0 if not duration or not track_duration else max(0.0, 1 - abs(float(duration) - track_duration) / 90)
        score = 0.45 * ratio(title, track.get("title_short") or track.get("title", "")) + 0.40 * ratio(artist, track_artist) + 0.15 * duration_score
        choices.append({"track_id": track.get("id"), "title": track.get("title"), "artist": track_artist,
                        "duration_seconds": track_duration, "isrc": track.get("isrc"), "score": round(score, 4)})
    return max(choices, key=lambda item: item["score"], default={})


def harvest_song(song: dict, notion: dict[str, dict], client: Client) -> dict:
    records, search_url = client.lrclib(song["title"])
    ranked = rank_lrclib(song, records)
    best = ranked[0] if ranked else {}
    proposal = {
        "id": song["id"], "path": song["path"], "title": song["title"],
        "body_sha256": song["body_sha256"], "existing_metadata": song["metadata"],
        "notion": None, "lrclib_search_url": search_url, "lrclib_candidates": ranked,
        "suggested": {}, "tier": "C", "reasons": [],
    }
    notion_record = notion.get(identity(song["title"]))
    if notion_record:
        key_match = KEY_RE.search(notion_record["title"])
        proposal["notion"] = {"title": notion_record["title"], "source_id": notion_record["source_id"],
                              "candidate_path": notion_record["candidate_path"],
                              "performance_key_candidate": key_match.group(1) if key_match else None}
    if not best:
        proposal["reasons"].append("no LRCLIB candidate")
        return proposal

    proposal["suggested"].update({
        "artist": best["artist"], "reference_title": best["title"], "reference_artist": best["artist"],
        "reference_album": best["album"], "reference_duration_seconds": best["duration_seconds"],
        "lyrics_reference_provider": "LRCLIB", "lyrics_reference_id": str(best["id"]),
        "lyrics_reference_url": f"https://lrclib.net/api/get/{best['id']}",
        "metadata_confidence": best["score"],
    })
    if proposal["notion"] and proposal["notion"]["performance_key_candidate"]:
        proposal["suggested"]["performance_key"] = proposal["notion"]["performance_key_candidate"]

    try:
        mb_data, _ = client.musicbrainz(best["title"], best["artist"])
        mb = best_musicbrainz(mb_data, best["title"], best["artist"], best["duration_seconds"])
        if mb.get("score", 0) >= 0.80:
            proposal["musicbrainz"] = mb
            proposal["suggested"]["recording_mbid"] = mb["recording_mbid"]
    except Exception as error:  # retain a usable partial proposal
        proposal["reasons"].append(f"MusicBrainz lookup failed: {error}")

    try:
        dz_data, _ = client.deezer(best["title"], best["artist"])
        dz = best_deezer(dz_data, best["title"], best["artist"], best["duration_seconds"])
        if dz.get("score", 0) >= 0.80 and dz.get("track_id"):
            track, _ = client.deezer_track(dz["track_id"])
            dz.update({"bpm": track.get("bpm"), "isrc": track.get("isrc") or dz.get("isrc")})
            proposal["deezer"] = dz
            if track.get("bpm") and float(track["bpm"]) > 0:
                proposal["suggested"]["original_bpm"] = str(track["bpm"])
                proposal["suggested"]["deezer_track_id"] = str(dz["track_id"])
    except Exception as error:
        proposal["reasons"].append(f"Deezer lookup failed: {error}")

    ambiguous = ambiguity(ranked)
    if best["title_score"] >= 0.92 and best["lyrics_score"] >= 0.68 and not ambiguous:
        proposal["tier"] = "A"
        proposal["reasons"].append("strong title and lyric match with no close cross-artist candidate")
    elif best["title_score"] >= 0.88 and best["lyrics_score"] >= 0.48:
        proposal["tier"] = "B"
        proposal["reasons"].append("plausible match requiring recording/artist review")
    else:
        proposal["reasons"].append("weak or incomplete deterministic match")
    if ambiguous:
        proposal["tier"] = "B" if proposal["tier"] == "A" else proposal["tier"]
        proposal["reasons"].append("close candidate from a different artist")
    return proposal


def quote_yaml(value) -> str:
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def apply_decisions(root: Path, proposals_path: Path, decisions_path: Path):
    proposals = {item["id"]: item for item in json.loads(proposals_path.read_text())["songs"]}
    decisions = json.loads(decisions_path.read_text())["decisions"]
    changed = []
    for decision in decisions:
        if decision.get("decision") != "accept":
            continue
        proposal = proposals[decision["id"]]
        path = root / proposal["path"]
        text = path.read_text(encoding="utf-8")
        front, body = split_front_matter(text)
        body_hash = hashlib.sha256(body.encode()).hexdigest()
        if body_hash != proposal["body_sha256"]:
            raise SystemExit(f"body changed since harvest: {proposal['path']}")
        existing = parse_front_matter(text)
        selected = dict(proposal["suggested"])
        selected.update(decision.get("overrides", {}))
        allowed = ["artist", "performance_key", "bpm", "reference_title", "reference_artist", "reference_album",
                   "reference_duration_seconds", "recording_mbid", "original_key", "original_key_kind", "original_bpm",
                   "deezer_track_id", "lyrics_reference_provider", "lyrics_reference_id", "lyrics_reference_url",
                   "metadata_confidence"]
        merged = dict(existing)
        for key in allowed:
            if key in selected and selected[key] not in (None, "") and key not in existing:
                merged[key] = selected[key]
        merged.update({"provenance_status": existing.get("provenance_status", "legacy-imported"),
                       "legacy_source_commit": existing.get("legacy_source_commit", LEGACY_COMMIT),
                       "legacy_source_path": existing.get("legacy_source_path", proposal["path"].replace("songs/", "lead-sheet/")),
                       "metadata_review_status": "reviewed"})
        ordered = allowed + ["provenance_status", "legacy_source_commit", "legacy_source_path", "metadata_review_status"]
        lines = [f"{key}: {quote_yaml(merged[key])}" for key in ordered if key in merged]
        extras = [key for key in merged if key not in ordered]
        lines.extend(f"{key}: {quote_yaml(merged[key])}" for key in extras)
        path.write_text("---\n" + "\n".join(lines) + "\n---\n\n" + body, encoding="utf-8")
        changed.append(proposal["path"])
    return changed


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    inventory = sub.add_parser("inventory")
    inventory.add_argument("--output", type=Path, default=ROOT / "metadata/inventory.json")
    harvest = sub.add_parser("harvest")
    harvest.add_argument("--pilot", action="store_true")
    harvest.add_argument("--ids", nargs="*")
    harvest.add_argument("--output", type=Path, default=ROOT / "metadata/proposals.json")
    harvest.add_argument("--cache", type=Path, default=ROOT / ".metadata-cache")
    apply_cmd = sub.add_parser("apply")
    apply_cmd.add_argument("--proposals", type=Path, required=True)
    apply_cmd.add_argument("--decisions", type=Path, required=True)
    args = parser.parse_args()

    catalog = read_catalog()
    notion = read_notion()
    if args.command == "inventory":
        rows = []
        for song in catalog:
            record = notion.get(identity(song["title"]))
            match = KEY_RE.search(record["title"]) if record else None
            rows.append({key: value for key, value in song.items() if key != "tokens"} | {
                "notion_title": record["title"] if record else None,
                "notion_performance_key_candidate": match.group(1) if match else None,
            })
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({"song_count": len(rows), "songs": rows}, indent=2) + "\n")
        return
    if args.command == "harvest":
        ids = set(PILOT_IDS if args.pilot else (args.ids or [song["id"] for song in catalog]))
        selected = [song for song in catalog if song["id"] in ids]
        missing = ids - {song["id"] for song in selected}
        if missing:
            raise SystemExit("unknown song ids: " + ", ".join(sorted(missing)))
        client = Client(args.cache)
        proposals = []
        for index, song in enumerate(selected, 1):
            print(f"[{index}/{len(selected)}] {song['title']}", flush=True)
            proposals.append(harvest_song(song, notion, client))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({"song_count": len(proposals), "songs": proposals}, indent=2) + "\n")
        return
    if args.command == "apply":
        for changed in apply_decisions(ROOT, args.proposals, args.decisions):
            print(changed)


if __name__ == "__main__":
    main()
