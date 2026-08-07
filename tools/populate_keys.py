#!/usr/bin/env python3
"""Estimate original-recording keys from AcousticBrainz and Deezer previews."""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import populate_metadata as metadata

ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = metadata.USER_AGENT
PITCHES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
ENHARMONIC = {"Db": "C#", "D#": "Eb", "Gb": "F#", "G#": "Ab", "A#": "Bb"}
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def normalize_key(key: str, scale: str | None = None) -> str:
    key = ENHARMONIC.get(key, key)
    minor = (scale or "").lower().startswith("min") or key.lower().endswith("m")
    key = key[:-1] if key.lower().endswith("m") else key
    key = ENHARMONIC.get(key, key)
    return key + ("m" if minor else "")


def request_json(url: str, cache: Path):
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        return json.loads(cache.read_text())
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.load(response)
    cache.write_text(json.dumps(value, ensure_ascii=False))
    return value


def acousticbrainz(mbid: str, cache_root: Path) -> dict | None:
    url = f"https://acousticbrainz.org/api/v1/{mbid}/low-level"
    try:
        data = request_json(url, cache_root / "acousticbrainz" / f"{mbid}.json")
    except Exception:
        return None
    tonal = data.get("tonal") or {}
    key = tonal.get("key_key")
    scale = tonal.get("key_scale")
    if not key or not scale:
        return None
    return {"key": normalize_key(key, scale), "strength": round(float(tonal.get("key_strength") or 0), 4),
            "source_url": url, "bpm": (data.get("rhythm") or {}).get("bpm")}


def clean_title(title: str) -> str:
    return re.sub(r"\s*\{[^}]+\}\s*$", "", title).strip()


def deezer_track(song: dict, cache_root: Path) -> dict | None:
    fields = song["metadata"]
    track_id = fields.get("deezer_track_id")
    if track_id:
        try:
            return request_json(f"https://api.deezer.com/track/{track_id}", cache_root / "deezer" / f"track-{track_id}.json")
        except Exception:
            pass
    artist = fields.get("reference_artist") or fields.get("artist")
    title = fields.get("reference_title") or clean_title(song["title"])
    if not artist or not title:
        return None
    query = f'artist:"{artist}" track:"{title}"'
    url = "https://api.deezer.com/search?" + urllib.parse.urlencode({"q": query, "limit": 10})
    key = metadata.identity(artist + "-" + title)
    try:
        data = request_json(url, cache_root / "deezer-key-search" / f"{key}.json")
    except Exception:
        return None
    expected_duration = fields.get("reference_duration_seconds")
    try:
        expected_duration = float(expected_duration) if expected_duration else None
    except ValueError:
        expected_duration = None
    best = None
    for track in data.get("data", []):
        candidate_artist = (track.get("artist") or {}).get("name", "")
        title_score = metadata.ratio(title, track.get("title_short") or track.get("title") or "")
        artist_score = metadata.ratio(artist, candidate_artist)
        duration = track.get("duration") or 0
        duration_score = 1.0 if not expected_duration or not duration else max(0.0, 1 - abs(expected_duration - duration) / 90)
        score = 0.45 * title_score + 0.45 * artist_score + 0.10 * duration_score
        if best is None or score > best[0]:
            best = (score, track)
    if not best or best[0] < 0.80:
        return None
    track_id = best[1].get("id")
    try:
        track = request_json(f"https://api.deezer.com/track/{track_id}", cache_root / "deezer" / f"track-{track_id}.json")
    except Exception:
        return None
    track["_match_score"] = round(best[0], 4)
    return track


def correlation(left, right) -> float:
    import numpy as np
    return float(np.corrcoef(left, right)[0, 1])


def profile_key(chroma) -> dict:
    import numpy as np
    vector = np.asarray(chroma, dtype=float)
    if vector.ndim > 1:
        vector = np.median(vector, axis=1)
    scores = []
    for root in range(12):
        scores.append((correlation(vector, np.roll(MAJOR_PROFILE, root)), PITCHES[root]))
        scores.append((correlation(vector, np.roll(MINOR_PROFILE, root)), PITCHES[root] + "m"))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    return {"key": best[1], "correlation": round(best[0], 4), "margin": round(best[0] - second[0], 4),
            "runner_up": second[1]}


def analyze_preview(url: str, cache_root: Path, track_id: str) -> dict | None:
    try:
        import essentia.standard as es
    except ImportError as error:
        raise SystemExit("essentia is required; install tools/metadata-key-requirements.txt") from error
    audio = cache_root / "audio" / f"{track_id}.mp3"
    audio.parent.mkdir(parents=True, exist_ok=True)
    if not audio.exists():
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=45) as response:
            audio.write_bytes(response.read())
    try:
        samples = es.MonoLoader(filename=str(audio), sampleRate=44100)()
    except Exception:
        return None
    if len(samples) < 44100 * 8:
        return None
    profiles = {}
    votes = {}
    for profile in ("temperley", "krumhansl", "edma"):
        key, scale, strength = es.KeyExtractor(profileType=profile)(samples)
        normalized = normalize_key(key, scale)
        profiles[profile] = {"key": normalized, "strength": round(float(strength), 4)}
        votes[normalized] = votes.get(normalized, 0) + 1
    consensus_key, agreement = max(votes.items(), key=lambda item: item[1])
    matching_strengths = [value["strength"] for value in profiles.values() if value["key"] == consensus_key]
    return {"profiles": profiles, "consensus_key": consensus_key, "agreement": agreement,
            "strength": round(sum(matching_strengths) / len(matching_strengths), 4),
            "duration_seconds": round(len(samples) / 44100, 2)}


def decide(ab: dict | None, preview: dict | None) -> dict:
    if ab and preview and preview["consensus_key"] == ab["key"] and ab["strength"] >= 0.4:
        confidence = min(0.98, 0.60 + 0.08 * preview["agreement"] + 0.12 * preview["strength"] + 0.12 * ab["strength"])
        return {"decision": "accept", "key": ab["key"], "kind": "analysis-consensus",
                "confidence": round(confidence, 3)}
    if preview:
        if preview["agreement"] == 3 and preview["strength"] >= 0.52:
            confidence = min(0.94, 0.70 + 0.24 * preview["strength"])
            return {"decision": "accept", "key": preview["consensus_key"], "kind": "preview-analysis-estimate",
                    "confidence": round(confidence, 3)}
        if preview["agreement"] == 2 and preview["strength"] >= 0.68:
            confidence = min(0.88, 0.58 + 0.30 * preview["strength"])
            return {"decision": "accept", "key": preview["consensus_key"], "kind": "preview-analysis-estimate",
                    "confidence": round(confidence, 3)}
    if ab and ab["strength"] >= 0.68:
        return {"decision": "accept", "key": ab["key"], "kind": "acousticbrainz-estimate",
                "confidence": round(min(0.88, 0.52 + 0.45 * ab["strength"]), 3)}
    return {"decision": "review"}


def build_proposals(cache_root: Path, ids: set[str] | None = None) -> dict:
    songs = metadata.read_catalog(ROOT)
    if ids:
        songs = [song for song in songs if song["id"] in ids]
    output = []
    for index, song in enumerate(songs, 1):
        fields = song["metadata"]
        print(f"[{index}/{len(songs)}] {song['title']}", flush=True)
        ab = acousticbrainz(fields.get("recording_mbid", ""), cache_root) if fields.get("recording_mbid") else None
        track = deezer_track(song, cache_root)
        preview = None
        deezer = None
        if track:
            deezer = {"track_id": track.get("id"), "title": track.get("title"),
                      "artist": (track.get("artist") or {}).get("name"), "duration": track.get("duration"),
                      "match_score": track.get("_match_score"), "preview_available": bool(track.get("preview"))}
            if track.get("preview"):
                try:
                    preview = analyze_preview(track["preview"], cache_root, str(track.get("id")))
                except Exception as error:
                    deezer["analysis_error"] = str(error)
        decision = decide(ab, preview)
        output.append({"id": song["id"], "path": song["path"], "title": song["title"],
                       "artist": fields.get("artist"), "performance_key": fields.get("performance_key"),
                       "existing_original_key": fields.get("original_key"), "acousticbrainz": ab,
                       "deezer": deezer, "preview_analysis": preview, **decision})
    return {"song_count": len(output), "songs": output}


def apply_proposals(path: Path):
    proposals = json.loads(path.read_text())["songs"]
    by_id = {song["id"]: song for song in metadata.read_catalog(ROOT)}
    changed = []
    for proposal in proposals:
        if proposal.get("decision") != "accept" or proposal.get("existing_original_key"):
            continue
        song = by_id[proposal["id"]]
        source = ROOT / song["path"]
        text = source.read_text()
        front, body = metadata.split_front_matter(text)
        values = metadata.parse_front_matter(text)
        values["original_key"] = proposal["key"]
        values["original_key_kind"] = proposal["kind"]
        values["original_key_confidence"] = str(proposal["confidence"])
        if proposal.get("acousticbrainz"):
            values["original_key_source"] = proposal["acousticbrainz"]["source_url"]
        elif proposal.get("deezer", {}).get("track_id"):
            values["original_key_source"] = f"https://www.deezer.com/track/{proposal['deezer']['track_id']}"
        ordered = [
            "artist", "performance_key", "bpm", "original_key", "original_key_kind", "original_key_confidence",
            "original_key_source", "original_bpm", "reference_title", "reference_artist", "reference_album",
            "reference_duration_seconds", "recording_mbid", "deezer_track_id", "lyrics_reference_provider",
            "lyrics_reference_id", "lyrics_reference_url", "metadata_confidence", "provenance_status",
            "legacy_source_commit", "legacy_source_path", "metadata_review_status",
        ]
        lines = [f"{key}: {metadata.quote_yaml(values[key])}" for key in ordered if key in values]
        lines.extend(f"{key}: {metadata.quote_yaml(values[key])}" for key in values if key not in ordered)
        source.write_text("---\n" + "\n".join(lines) + "\n---\n\n" + body)
        changed.append(song["path"])
    return changed


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    harvest = sub.add_parser("harvest")
    harvest.add_argument("--cache", type=Path, default=ROOT / ".metadata-cache")
    harvest.add_argument("--output", type=Path, default=ROOT / "metadata/key-proposals.json")
    harvest.add_argument("--ids", nargs="*")
    apply_cmd = sub.add_parser("apply")
    apply_cmd.add_argument("--proposals", type=Path, default=ROOT / "metadata/key-proposals.json")
    args = parser.parse_args()
    if args.command == "harvest":
        result = build_proposals(args.cache, set(args.ids) if args.ids else None)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    else:
        for path in apply_proposals(args.proposals):
            print(path)


if __name__ == "__main__":
    main()
