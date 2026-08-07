#!/usr/bin/env python3
"""Build deterministic, source-neutral SetListDraft import candidates.

This reads reconciliation plus each matched-source candidate file. It never writes to
../songs and intentionally leaves fuzzy, composite, and unmatched items unresolved.
"""
from __future__ import annotations
import hashlib, json, re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUTS = {
    "reconciled": ROOT / "candidates/reconciled-set-lists.json",
    "github": ROOT / "candidates/github-set-lists-matched.json",
    "icloud": ROOT / "candidates/icloud-set-lists-matched.json",
    "notion": ROOT / "candidates/notion-set-lists-matched.json",
}
OUT = ROOT / "candidates/set-list-drafts.json"
REPORT = ROOT / "reports/draft-readiness.md"

# Deliberately narrow: proposals require an unambiguous trailing performer token,
# never an inferred singer from a generic annotation such as "extend" or "acoustic".
PERFORMER = re.compile(r"^(?:Dave|Ellen|Kyle|Janel|Mayra|Christy|Rae|Rachel|Jess|James|Matt|JMB|DLG|KGL|Codi|Charlie)(?:\??|(?:\s*/\s*(?:Dave|Ellen|Kyle|Janel|Mayra|Christy|Rae|Rachel|Jess|James|Matt|JMB|DLG|KGL|Codi|Charlie)\??)+)$", re.I)
KEY = re.compile(r"\s*\((?:[A-G](?:#|b)?m?(?:\s*,\s*[A-G](?:#|b)?m?)?|[A-G](?:#|b)?\s+for\s+[^)]+)\)\s*$", re.I)

def load(path): return json.loads(path.read_text())
def sha(value): return hashlib.sha256(value.encode("utf-8")).hexdigest()
def fingerprint(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def clean_none(value): return None if value is None or str(value).strip().lower() == "none" or not str(value).strip() else value
def path_key(path): return tuple(int(x) if x.isdigit() else x for x in str(path or "").split("."))
def exact_match(match): return bool(match and match.get("match_status") in {"exact", "normalized"} and match.get("canonical_song_id"))
def compact_proposals(values):
    """Keep no more than three human-review choices, not matcher payloads."""
    return [{k: x.get(k) for k in ("canonical_song_id", "canonical_song_path", "canonical_title", "score")}
            for x in (values or [])[:3]]

def compact_components(match):
    return [{"raw_component": x.get("raw_component"), "cleaned_title": x.get("cleaned_title"),
             "proposed_match_status": x.get("proposed_match_status"),
             "review_proposals": compact_proposals(x.get("candidate_alternatives"))}
            for x in (match or {}).get("component_proposals", [])[:3]]

def match_fields(match):
    match = match or {}
    source_status = match.get("match_status") or "unmatched"
    accepted = exact_match(match)
    out = {"cleaned_title": match.get("cleaned_title") or match.get("raw_label"),
           "resolution_status": source_status if accepted else "unresolved",
           "confidence": match.get("confidence")}
    if accepted:
        out["resolved_canonical_song"] = {"canonical_song_id": match["canonical_song_id"],
                                            "canonical_song_path": match.get("canonical_song_path"),
                                            "canonical_title": match.get("canonical_title")}
    else:
        out["review_kind"] = source_status
        components = compact_components(match)
        if components: out["component_proposals"] = components
        else: out["review_proposals"] = compact_proposals(match.get("candidate_alternatives"))
    return out

def notion_parse(raw):
    """Return only conservative proposals; raw label remains untouched elsewhere."""
    raw = raw or ""
    # Exact three-part syntax: Title (key) - Singer - note.
    parts = [x.strip() for x in raw.split(" - ")]
    if len(parts) == 3 and PERFORMER.fullmatch(parts[1]):
        return {"display_label": KEY.sub("", parts[0]).strip(),
                "singer_proposal": {"value": parts[1], "confidence": "medium", "basis": "clear Title (key) - Singer - note syntax"},
                "note_proposal": {"value": parts[2], "confidence": "medium", "basis": "clear Title (key) - Singer - note syntax"}}
    # Exact trailing performer parenthetical, optionally followed by a free-text note.
    m = re.match(r"^(.*?)(?:\s+)\(([^()]*)\)(?:\s+(.+))?$", raw)
    if m and PERFORMER.fullmatch(m.group(2).strip()):
        title = KEY.sub("", m.group(1)).strip()
        out = {"display_label": title, "singer_proposal": {"value": m.group(2).strip(), "confidence": "medium", "basis": "clear trailing performer parenthetical"}}
        if m.group(3): out["note_proposal"] = {"value": m.group(3).strip(), "confidence": "medium", "basis": "text following clear trailing performer parenthetical"}
        return out
    # One-dash annotations are deliberately not parsed: they may be a singer, a note,
    # a version, or an instruction. The raw source label is retained for review.
    return {"display_label": (KEY.sub("", raw).strip() or raw)}

def make_item(draft_id, section_number, position, raw_label, match, source_label, direct_singer=None, direct_note=None, proposals=None, item_evidence=None):
    item = {
        "item_id": f"{draft_id}-item-{section_number:02d}-{position:03d}",
        "position": position,
        "display_label": (proposals or {}).get("display_label") or raw_label or "Untitled item",
        "raw_source_label": raw_label,
        "raw_source": source_label,
        **match_fields(match),
        "source_evidence": {k: v for k, v in (item_evidence or {}).items() if v is not None},
    }
    if direct_singer is not None: item["singer"] = direct_singer
    if direct_note is not None: item["note"] = direct_note
    for key in ("singer_proposal", "note_proposal"):
        if (proposals or {}).get(key): item[key] = proposals[key]
    return item

def sections_github(rec, draft_id):
    buckets = []
    for song in rec["ordered_songs"]:
        group = song.get("group_number") or song.get("set_number")
        key = group if group is not None else 1
        if not buckets or buckets[-1][0] != key: buckets.append((key, []))
        buckets[-1][1].append(song)
    result = []
    for s_no, (group, songs) in enumerate(buckets, 1):
        result.append({"section_id": f"{draft_id}-section-{s_no:02d}", "position": s_no,
                       "label": f"Set {group}" if group is not None else "Set 1",
                       "raw_source_label": str(group) if group is not None else None,
                       "items": [make_item(draft_id, s_no, i, x.get("song"), x.get("catalog_match"), "github", x.get("singer"), None, None,
                         {"source_filename": x.get("source_filename"), "source_position": x.get("position"), "group_number": x.get("group_number"), "set_number": x.get("set_number")}) for i,x in enumerate(songs,1)]})
    return result

def sections_icloud(rec, draft_id):
    result=[]
    for s_no, group in enumerate(rec.get("groups", []), 1):
        raw_group = group.get("label")
        result.append({"section_id": f"{draft_id}-section-{s_no:02d}", "position": s_no,
                       "label": raw_group or f"Unlabeled group {s_no}", "raw_source_label": raw_group,
                       "items": [make_item(draft_id,s_no,i,x.get("label"),x.get("catalog_match"),"icloud",x.get("singer"),x.get("note"),None,
                         {"group_label":raw_group,"source_candidate_id":rec.get("id")}) for i,x in enumerate(group.get("songs",[]),1)]})
    # Unsupported/empty iCloud artifacts still become reviewable drafts with an
    # explicit empty section rather than silently disappearing.
    if not result:
        result.append({"section_id": f"{draft_id}-section-01", "position": 1,
                       "label": "Unparsed source group", "raw_source_label": None, "items": []})
    return result

def sections_notion(rec, draft_id):
    stream=[]
    for x in rec.get("body_song_evidence_ordered",[]): stream.append((path_key(x.get("source_path")), 1, x))
    for x in rec.get("set_breaks",[]): stream.append((path_key(x.get("source_path")), 0, x))
    stream.sort(key=lambda x:(x[0],x[1]))
    sections=[]; current={"label":"Set 1","raw_source_label":None,"items":[]}
    for _,kind,x in stream:
        if kind == 0:
            if current["items"]: sections.append(current)
            current={"label":x.get("label") or f"Set {len(sections)+1}","raw_source_label":x.get("label"),"items":[]}
            continue
        raw=x.get("label") or "Untitled item"; parsed=notion_parse(raw)
        current["items"].append((x,parsed))
    if current["items"]: sections.append(current)
    # Empty Notion records still get an empty section, preserving the draft shape.
    if not sections: sections=[current]
    result=[]
    for s_no, sec in enumerate(sections,1):
        items=[]
        for pos,(x,parsed) in enumerate(sec["items"],1):
            items.append(make_item(draft_id,s_no,pos,x.get("label"),x.get("catalog_match"),"notion",None,None,parsed,
                {"page_id":rec.get("page_id"),"source_block_id":x.get("source_block_id"),"source_path":x.get("source_path"),"link":x.get("link"),"source_confidence":x.get("confidence"),"basis":x.get("basis"),"source_last_edited_time":x.get("source_last_edited_time")}))
        result.append({"section_id":f"{draft_id}-section-{s_no:02d}","position":s_no,"label":sec["label"],"raw_source_label":sec["raw_source_label"],"items":items})
    return result

def object_key(input_file, obj):
    if input_file.endswith("github-set-lists-matched.json"):
        return obj["repository"] + "@" + obj["commit_sha"]
    if input_file.endswith("notion-set-lists-matched.json"):
        return obj["page_id"]
    if input_file.endswith("icloud-set-lists-matched.json"):
        return obj["id"]
    raise ValueError(f"unsupported source input: {input_file}")

def build_source_indexes(matched_inputs):
    indexes = {}
    for input_file, data in matched_inputs.items():
        for collection_key in ("candidates", "gigs", "gig_candidates"):
            if collection_key in data:
                indexes[(input_file, collection_key)] = {object_key(input_file, obj): obj for obj in data[collection_key]}
    return indexes

def resolve_source_record(record, indexes):
    ref = record.get("source_record_ref") or {}
    key = (ref.get("input_file"), ref.get("collection_key"))
    if key not in indexes or ref.get("object_id") not in indexes[key]:
        raise ValueError(f"unresolvable source_record_ref for {record.get('source_id')}: {ref}")
    resolved = indexes[key][ref["object_id"]]
    if object_key(ref["input_file"], resolved) != record["source_id"]:
        raise ValueError(f"source_record_ref/source_id mismatch: {record['source_id']}")
    return resolved

def concise_locator(record):
    ref = record["source_record_ref"]
    out = {"source_type": record["source_type"], "source_id": record["source_id"],
           "source_record_ref": ref}
    sr = record.get("source_reference") or {}
    if record["source_type"] == "github":
        out["repository"] = sr.get("repository"); out["commit_sha"] = sr.get("commit_sha")
    elif record["source_type"] == "notion":
        out["page_id"] = sr.get("page_id")
    else:
        out["candidate_id"] = sr.get("candidate_id")
        out["source_hashes"] = [x.get("sha256") for x in sr.get("sources", []) if x.get("sha256")]
    return {k:v for k,v in out.items() if v not in (None, [], {})}

def source_refs(group, records):
    return [concise_locator(records[sid]) for sid in group["representation_source_ids"]]

def primary_record(group, records): return records[group["primary_source_id"]]

def metadata(group, primary, source_record):
    date_raw=clean_none(primary.get("date_raw"))
    out = {"band_explicit": primary.get("band_explicit"), "band_proposal": primary.get("band_proposal"),
           "title": clean_none(primary.get("title_raw")), "date": {"raw": date_raw, "value": primary.get("date_value"),
           "precision": primary.get("date_precision") or "missing"}, "location": clean_none(primary.get("venue_raw"))}
    # The usable Wait for the Shake artifact has no source title.  Keep the null
    # source value and make the generated label explicitly review-only.
    if primary.get("source_id") == "wait-for-the-shake-2006-01-25" and out["title"] is None:
        source = (source_record.get("sources") or [{}])[0]
        filename = source.get("filename") or Path(source.get("path") or "source").name
        stem = Path(filename).stem
        fallback = f"{primary.get('band_explicit')} — {stem}".strip(" —")
        out["title"] = fallback
        out["title_proposal"] = {"value": fallback, "confidence": "low", "requires_review": True,
            "basis": "generated from explicit band, date, and source filename",
            "original_source_value": None, "source_filename": filename}
    return out

def confidence(sections, blockers):
    items=[x for s in sections for x in s["items"]]
    unresolved=sum(x["resolution_status"] == "unresolved" for x in items)
    if blockers or unresolved: return "blocked"
    return "high" if items and all((x.get("confidence") or 0) >= .98 for x in items) else "medium"

def build():
    recon = load(INPUTS["reconciled"])
    matched = {str(path.relative_to(ROOT)): load(path) for name, path in INPUTS.items() if name != "reconciled"}
    indexes = build_source_indexes(matched)
    records = {x["source_id"]: x for x in recon["source_candidate_index"]}
    resolved = {sid: resolve_source_record(record, indexes) for sid, record in records.items()}
    rel_by_id = defaultdict(list)
    for rel in recon["related_supporting_pages"]:
        concise = {"kind": rel["kind"], "source_ids": rel["source_ids"], "basis": rel.get("basis", {})}
        for sid in rel["source_ids"]: rel_by_id[sid].append(concise)
    drafts=[]; existing=[]; unusable=[]
    for group in recon["event_groups"]:
        if group["import_disposition"] == "existing_canonical":
            existing.append({"event_group_id":group["event_group_id"],"reason":"existing_canonical","canonical_matches":group["canonical_matches"]}); continue
        primary = primary_record(group, records); rec = resolved[primary["source_id"]]
        draft_id="sld-"+sha(group["event_group_id"])[:12]
        if primary["source_type"] == "github": sections=sections_github(rec,draft_id)
        elif primary["source_type"] == "icloud": sections=sections_icloud(rec,draft_id)
        else: sections=sections_notion(rec,draft_id)
        item_count=sum(len(section["items"]) for section in sections)
        if not item_count:
            unusable.append({"event_group_id":group["event_group_id"],"reason":"zero_extracted_items_or_no_song_evidence",
                             "primary_source":concise_locator(primary),"reconciliation_blockers":group["review_blockers"]})
            continue
        unresolved=[x["item_id"] for s in sections for x in s["items"] if x["resolution_status"] == "unresolved"]
        blockers=list(group["review_blockers"])
        proposed = metadata(group, primary, rec)
        if proposed.get("title_proposal"):
            blockers.append("generated fallback title is a proposal; confirm or replace before publication")
        if unresolved: blockers.append(f"{len(unresolved)} unresolved item(s): composite, fuzzy, or unmatched matches require human resolution or removal")
        material={"event_group_id":group["event_group_id"],"metadata":proposed,"sections":sections,"blockers":blockers}
        supporting=[]; seen=set()
        for sid in group["representation_source_ids"]:
            for rel in rel_by_id[sid]:
                marker=json.dumps(rel,sort_keys=True)
                if marker not in seen: supporting.append(rel); seen.add(marker)
        draft={"draft_id":draft_id,"revision":"sha256:"+sha(json.dumps(material,ensure_ascii=False,sort_keys=True,separators=(",",":")))[:16],
               "schema_version":"set-list-draft-candidate/1.0","event_group_id":group["event_group_id"],
               "status":"publication_ready" if not blockers else "review_required","proposed_metadata":proposed,"sections":sections,
               "validation":{"publication_blocked":bool(blockers),"blockers":blockers,"unresolved_item_ids":unresolved},
               "import_evidence":{"confidence":confidence(sections,blockers),"primary_source":concise_locator(primary),
                                  "representations":source_refs(group, records),"supporting_relationships":supporting,
                                  "reconciliation_disposition":group["import_disposition"]}}
        drafts.append(draft)
    drafts.sort(key=lambda x:x["event_group_id"]); unusable.sort(key=lambda x:x["event_group_id"])
    publication_ready=[x for x in drafts if x["status"]=="publication_ready"]
    review_required=[x for x in drafts if x["status"]=="review_required"]
    return {"schema_version":"set-list-draft-candidates/1.0","method":"permissive draft admission from reconciled source_record_ref pointers; publication remains explicitly human-reviewed and strict","input_fingerprints":{str(p.relative_to(ROOT)):fingerprint(p) for p in INPUTS.values()},
            "publication_ready":publication_ready,"review_required":review_required,"excluded_unusable":unusable,"excluded_existing_canonical":existing,
            "counts":{"admitted_drafts":len(drafts),"publication_ready":len(publication_ready),"review_required":len(review_required),"excluded_unusable":len(unusable),"excluded_existing_canonical":len(existing)}}

def write_report(data):
    drafts=data["publication_ready"]+data["review_required"]
    source=Counter(d["import_evidence"]["primary_source"]["source_type"] for d in drafts)
    band=Counter((d["proposed_metadata"]["band_explicit"] or (d["proposed_metadata"]["band_proposal"] or {}).get("value") or "(none)") for d in drafts)
    status=Counter(d["status"] for d in drafts); items=[i for d in drafts for s in d["sections"] for i in s["items"]]
    resolution=Counter(i["resolution_status"] for i in items)
    singer=Counter("confirmed" if i.get("singer") else "proposal" if i.get("singer_proposal") else "none" for i in items)
    lines=["# SetListDraft admission and readiness","","Generated by `scripts/build_setlist_drafts.py`. Admission permits editable drafts with source items; canonical publication remains strict.","","## Draft admission","",f"- **Admitted editable drafts:** {data['counts']['admitted_drafts']}.",f"- **Excluded unusable sources (zero extracted items/no song evidence):** {data['counts']['excluded_unusable']}.",f"- **Excluded existing canonical events:** {data['counts']['excluded_existing_canonical']}.","", "## Publication readiness","",f"- **Publication ready:** {data['counts']['publication_ready']} admitted drafts.",f"- **Review required:** {data['counts']['review_required']} admitted drafts.",f"- **Unresolved items:** {sum(1 for i in items if i['resolution_status']=='unresolved')}; each blocks publication.","", "## Counts", "", "| Dimension | Value | Count |", "|---|---|---:|"]
    for k,v in sorted(source.items()): lines.append(f"| primary source | {k} | {v} |")
    for k,v in sorted(band.items()): lines.append(f"| band (explicit or proposal) | {k} | {v} |")
    for k,v in sorted(status.items()): lines.append(f"| admitted draft status | {k} | {v} |")
    for k,v in sorted(resolution.items()): lines.append(f"| item resolution | {k} | {v} |")
    for k,v in sorted(singer.items()): lines.append(f"| singer evidence | {k} | {v} |")
    lines += ["", "## Prioritized publication-review packet", ""]
    priority=[]
    for d in data["review_required"]:
        b=d["validation"]["blockers"]; score=(0 if any("possible-duplicate" in x for x in b) else 1, 0 if d["validation"]["unresolved_item_ids"] else 1, d["event_group_id"])
        priority.append((score,d))
    for _,d in sorted(priority)[:15]:
        title=d["proposed_metadata"]["title"] or "(missing title)"; date=d["proposed_metadata"]["date"]["raw"] or "(missing date)"
        lines.append(f"1. **{d['event_group_id']}** — `{title}` ({date}): " + "; ".join(d["validation"]["blockers"]))
    lines += ["", "## Excluded unusable sources", ""]
    for x in data["excluded_unusable"]:
        lines.append(f"- **{x['event_group_id']}** — `{x['primary_source']['source_type']}` `{x['primary_source']['source_id']}`: {x['reason']}.")
    lines += ["", "## Guardrails", "", "- Admission never implies publication readiness.", "- Only exact/normalized title matches carry `resolved_canonical_song`; unresolved retained items block publication.", "- Existing canonical events remain excluded; no canonical Markdown was generated.", "- The Wait for the Shake fallback title is explicitly a review-only proposal and retains the original null source value.", "- GitHub parsed singers/groups and iCloud groups/singers/notes are preserved; Notion singer/note values remain conservative proposals."]
    REPORT.write_text("\n".join(lines)+"\n")

def main():
    data=build(); OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n"); json.loads(OUT.read_text()); write_report(data)
if __name__ == "__main__": main()
