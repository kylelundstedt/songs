#!/usr/bin/env python3
"""Deterministic, metadata-only set-list to canonical-song catalog matcher.

Only filename, front matter, and H1 fields are read from canonical Markdown files;
song bodies are neither retained nor written. Raw source labels are never changed.
"""
from __future__ import annotations
import argparse, json, re, unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

KEY_RE = re.compile(r"^(?:[A-G](?:#|b)?(?:m|maj7|sus[24])?|N/?C|\?+)$", re.I)
# Reviewed source/history aliases only; no artist/version inference. Values are IDs.
HISTORICAL_ALIASES = {
    "exs ans ohs": "Exs-And-Ohs", "ex and ohs": "Exs-And-Ohs",
    "purplerain": "Purple-Rain", "useme": "Use-Me",
    "jump jive": "Jump-Jive-Wail", "jump jive an wail": "Jump-Jive-Wail",
    "doin time": "Doin-Time",
    "free fallin": "Free-Fallin", "gimme all your lovin": "Gimme-All-Your-Lovin",
    "im bad im nationwide": "I-m-Bad-I-m-Nationwide", "lets get it on": "Let-s-Get-It-On",
    "lets go crazy": "Let-s-Go-Crazy", "long train running": "Long-Train-Runnin",
    "mary janes last dance": "Mary-Jane-s-Last-Dance", "peaceful easy feeling": "Peaceful-Easy-Feelin",
    "rock and roll aint noise pollution": "Rock-and-Roll-Ain-t-Noise-Pollution",
    "say it aint so": "Say-It-Ain-t-So", "sex on fire": "Sex-on-Fire",
    "thats the way i like it": "That-s-The-Way-I-Like-It", "waitin for the bus": "Waitin-for-the-Bus",
    "when im gone": "When-I-m-Gone", "you dont know how it feels": "You-Don-t-Know-How-It-Feels",
    "short skirt long jacket": "Short-Skirt", "short skirt long jacket": "Short-Skirt",
    "where the streets have no name": "Where-the-Streets-Have-No-Names",
    # Reviewed iCloud historical abbreviations / renamed labels.
    "hashpipe": "Hash-Pipe", "i dont wanna be": "I-Don-t-Wanna-Be",
    "last dance with mary jane": "Mary-Jane-s-Last-Dance", "folsom prison": "Folsom-Prison-Blues",
    "are my girl": "Are-You-Gonna-Be-My-Girl", "in the middle": "The-Middle",
    "shake shake": "Shake-Shake-Shake", "thank u 4 lettin": "Thank-You-Falettinme-Be-Mice-Elf-Agin",
    "thats the way": "That-s-The-Way-I-Like-It",
}
# Explicit catalog abbreviation aliases found in extracted iCloud lists.
REVIEWED_CATALOG_ALIASES = {"Streets": "Where-the-Streets-Have-No-Names", "Folsom": "Folsom-Prison-Blues",
                            "Locked Out": "Locked-Out-Of-Heaven", "Seven Nation": "Seven-Nation-Army",
                            "Play That Funky": "Play-That-Funky-Music", "You Shook Me": "You-Shook-Me-All-Night-Long",
                            "Are You My Way": "Are-You-Gonna-Go-My-Way"}
# Contextual expansions apply only inside these explicitly reviewed multi-song labels.
# They retain the source component in raw_component and never resolve the composite.
COMPOSITE_COMPONENT_EXPANSIONS = {
    "thats shake lucky": ["That's the Way", "Shake Shake", "Get Lucky"],
    "what i got midnight hour": ["What I Got", "In The Midnight Hour"],
}


def text(value: Any) -> str: return " ".join(str(value or "").strip().split())
def norm(value: str) -> str:
    value=unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower().replace("'", "")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value).split())

def read_catalog(song_dir: Path) -> list[dict[str, Any]]:
    songs=[]
    for path in sorted(song_dir.glob("*.md")):
        fm={}; h1=""; short_alias=""; in_fm=False
        with path.open(encoding="utf-8", errors="replace") as fh:
            for n,line in enumerate(fh):
                if n == 0 and line.strip()=="---": in_fm=True; continue
                if in_fm:
                    if line.strip()=="---": in_fm=False; continue
                    found=re.match(r"^([A-Za-z_][\w-]*):\s*(.*?)\s*$",line)
                    if found: fm[found.group(1).lower()]=found.group(2).strip().strip('"\'')
                    continue
                if line.startswith("# "):
                    heading=text(line[2:])
                    short=re.search(r'\s+\{short="([^"]+)"\}\s*$', heading)
                    short_alias=text(short.group(1)) if short else ""
                    h1=text(re.sub(r"\s+\{short=[^}]*\}\s*$", "", heading)); break
                if n > 250: break
        stem=path.stem.replace("-", " "); title=text(fm.get("title") or h1 or stem)
        songs.append({"id":path.stem, "path":f"songs/{path.name}", "title":title,
                      "artist":text(fm.get("artist") or fm.get("reference_artist")) or None,
                      "aliases":sorted({title,h1,short_alias,stem,text(fm.get("title"))}-{''})})
    for song in songs:
        for alias, song_id in REVIEWED_CATALOG_ALIASES.items():
            if song["id"]==song_id: song["aliases"].append(alias)
    return songs

def is_key_annotation(value: str) -> bool:
    bits=[text(x) for x in re.split(r"\s*[,/]\s*",value)]
    return bool(bits) and all(KEY_RE.fullmatch(x) for x in bits)

def strip_markers(value: str) -> str:
    # OCR/list punctuation only, deliberately not title punctuation.
    return re.sub(r"[\s*?]+$", "", value).strip()

def clean_label(raw: str) -> str:
    s=strip_markers(text(raw).lstrip("@").strip())
    # A dash introduces a note/assignment (including a bare trailing dash).
    s=re.sub(r"\s+-\s*.*$", "", s).strip()
    s=strip_markers(s)
    # Short bare performer tails appear after a key in several exports.
    s=re.sub(r"\s+(?:jmb|kgl|dlg|dave|kyle|rae|rachel|jess)\s*(?:maybe)?$", "", s, flags=re.I)
    # A bare instrument is structured only when it follows a parenthetical key.
    s=re.sub(r"(\))\s+(?:bass|guitar|drums?|keys?|vox|vocals?)\s*$", r"\1", s, flags=re.I)
    # Clear all-caps/free-text performance endings before parenthetical peeling.
    s=re.sub(r"\s+(?:solo(?:\s+at.*)?|extra\s+solo|extend|optional)\s*$", "", s, flags=re.I)
    # Peel repeated trailing key / singer / instrument / performance annotations.
    while True:
        found=re.search(r"\s*\(([^()]*)\)\s*$",s)
        if not found: break
        inside=text(found.group(1)); low=norm(inside)
        structured=(is_key_annotation(inside) or any(w in low for w in
          ("rachel","jess","rae","kyle","dave","codi","jmb","kgl","dlg","singer","vox","vocal",
           "bass","guitar","drum","keys","keyboard","acoustic","optional","solo","extend","record","version","lineup","lana del ray")))
        if not structured: break
        s=strip_markers(s[:found.start()].rstrip())
    return text(strip_markers(s))

def split_composite(cleaned: str) -> list[str] | None:
    # Slash and lowercase "into" are source separators. Capitalized Into is a
    # title word (e.g. Crash Into Me). "to" needs at least two joins to avoid
    # ordinary titles such as Born To Run and Hard To Handle.
    if re.search(r"\s*/\s*",cleaned): parts=re.split(r"\s*/\s*",cleaned)
    elif " into " in cleaned: parts=cleaned.split(" into ")
    elif len(re.findall(r"\s+to\s+",cleaned,re.I)) >= 2: parts=re.split(r"\s+to\s+",cleaned,flags=re.I)
    else: return None
    parts=[text(p) for p in parts if text(p)]
    return parts if len(parts)>1 else None

def candidates(cleaned: str, catalog: list[dict[str,Any]], limit=5) -> list[dict[str,Any]]:
    q=norm(cleaned); rows=[]
    for song in catalog:
        score=max(SequenceMatcher(None,q,norm(alias)).ratio() for alias in song['aliases'])
        rows.append((score,song))
    rows.sort(key=lambda row:(-row[0],row[1]['title'],row[1]['id']))
    return [{"canonical_song_id":s['id'],"canonical_song_path":s['path'],"canonical_title":s['title'],"score":round(score,3)} for score,s in rows[:limit]]

def resolved(song: dict[str,Any], status: str, confidence: float) -> dict[str,Any]:
    return {"match_status":status,"canonical_song_id":song['id'],"canonical_song_path":song['path'],"canonical_title":song['title'],"canonical_artist":song['artist'],"confidence":confidence}

def basic_match(cleaned: str, catalog: list[dict[str,Any]]) -> dict[str,Any]:
    exact=[s for s in catalog if any(text(a).casefold()==text(cleaned).casefold() for a in s['aliases'])]
    if len(exact)==1: return resolved(exact[0],"exact",1.0)
    normalized=[s for s in catalog if any(norm(a)==norm(cleaned) for a in s['aliases'])]
    if len(normalized)==1: return resolved(normalized[0],"normalized",.99)
    song_id=HISTORICAL_ALIASES.get(norm(cleaned))
    historical=[s for s in catalog if s['id']==song_id]
    if len(historical)==1: return resolved(historical[0],"normalized",.98)
    alts=candidates(cleaned,catalog); out={"match_status":"unmatched","canonical_song_id":None,"canonical_song_path":None,"canonical_title":None,"canonical_artist":None,"confidence":0.0,"candidate_alternatives":alts}
    if alts:
        out['score_margin']=round(alts[0]['score']-(alts[1]['score'] if len(alts)>1 else 0),3)
        if alts[0]['score']>=.94 and out['score_margin']>=.10:
            # Proposal only: intentionally unresolved pending review.
            out['match_status']='fuzzy_review'; out['confidence']=alts[0]['score']
    return out

def match(raw: str, catalog: list[dict[str,Any]]) -> dict[str,Any]:
    cleaned=clean_label(raw); components=split_composite(cleaned)
    if components:
        proposals=[]
        expanded=COMPOSITE_COMPONENT_EXPANSIONS.get(norm(cleaned), components)
        for component, lookup_title in zip(components, expanded):
            proposal=basic_match(lookup_title,catalog)
            proposals.append({"raw_component":component,"cleaned_title":lookup_title,"proposed_match_status":proposal['match_status'],
                              "candidate_alternatives":proposal.get('candidate_alternatives') or ([{"canonical_song_id":proposal['canonical_song_id'],"canonical_song_path":proposal['canonical_song_path'],"canonical_title":proposal['canonical_title'],"score":proposal['confidence']}] if proposal['canonical_song_id'] else [])})
        return {"raw_label":raw,"cleaned_title":cleaned,"match_status":"composite_review","canonical_song_id":None,"canonical_song_path":None,"canonical_title":None,"canonical_artist":None,"confidence":0.0,"candidate_alternatives":[],"component_proposals":proposals}
    result=basic_match(cleaned,catalog); result.update({"raw_label":raw,"cleaned_title":cleaned})
    result.setdefault('candidate_alternatives', candidates(cleaned,catalog))
    return result

def aggregate(items): return dict(sorted(Counter(i['match_status'] for i in items).items()))
def add_matches(container: list[dict[str,Any]], label_key: str, catalog: list[dict[str,Any]]) -> list[dict[str,Any]]:
    output=[]
    for row in container:
        row['catalog_match']=match(row[label_key],catalog); output.append(row['catalog_match'])
    return output

def esc(value: Any) -> str: return str(value or '').replace('|','\\|')
def report_review_rows(source: str, items: list[dict[str,Any]]):
    grouped=defaultdict(list)
    for item in items:
        if item['match_status'] in {'unmatched','fuzzy_review','composite_review'}: grouped[(item['match_status'],item['raw_label'],item['cleaned_title'])].append(item)
    for (status,raw,cleaned), rows in grouped.items():
        item=rows[0]; top=item.get('candidate_alternatives',[{}])[0] if item.get('candidate_alternatives') else {}
        if status=='composite_review': top='; '.join(p['raw_component'] for p in item['component_proposals'])
        else: top=top.get('canonical_title','')
        yield source,raw,cleaned,status,top,len(rows)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--songs',default='/home/exedev/songs/songs'); ap.add_argument('--research',default='.'); args=ap.parse_args()
    root=Path(args.research); catalog=read_catalog(Path(args.songs))
    github=json.loads((root/'candidates/github-set-lists.json').read_text()); notion=json.loads((root/'candidates/notion-set-lists.json').read_text()); icloud=json.loads((root/'candidates/icloud-set-lists.json').read_text())
    github_items=[m for c in github['candidates'] for m in add_matches(c.get('ordered_songs',[]),'song',catalog)]
    notion_items=[m for g in notion['gigs'] for m in add_matches(g.get('body_song_evidence_ordered',[]),'label',catalog)]
    icloud_items=[m for gig in icloud['gig_candidates'] for group in gig.get('groups',[]) for m in add_matches(group.get('songs',[]),'label',catalog)]
    method='exact alias, punctuation/case normalization, reviewed historical aliases, conservative fuzzy proposals, composite review'
    for data,items in [(github,github_items),(notion,notion_items),(icloud,icloud_items)]: data['matching']={"catalog_song_count":len(catalog),"method":method,"aggregate_counts":aggregate(items)}
    for name,data in [('github-set-lists-matched.json',github),('notion-set-lists-matched.json',notion),('icloud-set-lists-matched.json',icloud)]: (root/'candidates'/name).write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
    sources=[('GitHub ordered_songs',github_items),('Notion body_song_evidence_ordered',notion_items),('iCloud gig_candidates/groups/songs',icloud_items)]
    lines=['# Song catalog matching report','',f'Canonical catalog: **{len(catalog)}** songs (filename, front matter, and H1 indexed; no bodies read or retained).','','## Aggregate counts','','| Source | Exact | Normalized | Fuzzy review | Composite review | Unmatched | Total |','|---|---:|---:|---:|---:|---:|---:|']
    for name,items in sources:
        counts=aggregate(items); lines.append(f"| {name} | {counts.get('exact',0)} | {counts.get('normalized',0)} | {counts.get('fuzzy_review',0)} | {counts.get('composite_review',0)} | {counts.get('unmatched',0)} | {len(items)} |")
    rows=[]
    for name,items in sources: rows.extend(report_review_rows(name,items))
    lines += ['', '## Review queue', '', 'Grouped by identical raw label; counts retain every machine-readable occurrence.', '', '| Source | Raw label | Cleaned title | Status | Top proposal / components | Occurrences |','|---|---|---|---|---|---:|']
    for row in sorted(rows,key=lambda r:(r[0],r[3],norm(r[1]))): lines.append('| '+' | '.join(esc(x) for x in row)+' |')
    lines += ['', '## Rules', '', '- Raw labels are preserved. Structured trailing stars/question markers are removed before and after peeling repeated keys, performers, instruments, and short performance markers.', '- Multi-song labels are `composite_review` with component proposals and are never resolved to one canonical song.', '- `fuzzy_review` is a proposal only: its canonical fields remain null. All accepted matches are exact or normalized.']
    (root/'reports/song-matching.md').write_text('\n'.join(lines)+'\n')
if __name__=='__main__': main()
