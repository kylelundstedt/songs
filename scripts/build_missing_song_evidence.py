#!/usr/bin/env python3
"""Build a deterministic, metadata-only review queue for unresolved set-list labels.

Reads only matched set-list JSON plus canonical/notion Markdown filenames, YAML-style
front matter, and first H1 lines.  It never reads or retains song/lead-sheet bodies,
and never writes outside the supplied research directory.
"""
from __future__ import annotations
import argparse, json, re, unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

REVIEW_STATUSES={"unmatched","fuzzy_review","composite_review"}
KEY=re.compile(r"^(?:[A-G](?:#|b)?(?:m|maj7|sus[24])?|N/?C|\?+)$",re.I)
EXT=re.compile(r"\.(?:md|docx?|pdf|pages)$",re.I)
PERFORMER=re.compile(r"^(?:jmb|kgl|dlg|jp|james|matt|dave|kyle|rae|rachel|jess|codi|charlie|todd|lana\s+del\s+ray)$",re.I)
NOISE={"untitled","unknown","tbd","set break","break","encore","new song","jmb","kgl","dlg","jp","k e","m d k"}
# Reviewed evidence-only title equivalences.  These do not alter source matches.
TITLE_EQUIVALENTS={"i melt with you":"Melt With You"}
# Reviewed concatenations present as one source label, not song-title inference.
CONCATENATED_MULTI_TITLES={
    "about damn time use me":["About damn time","Use Me"],
    "some kind of wonderful use me":["Some Kind of Wonderful","Use Me"],
    "what i got folsom prison blues":["What I Got","Folsom Prison Blues"],
}
# Intentional restricted list: evidence-only cleanup of obvious direction tails, not
# artist/title inference.
DIRECTION=re.compile(r"\s+(?:add\s+vox\s+back|solo(?:\s+time|\s+at.*)?|extra\s+long|extend|optional|double\s*\(.*|acoustic(?:\s+in\s+[a-g][#b]?(?:m)?)?|longer\s+intro.*|scary\s+pockets\s+version|if\s+people.*|repeat\s+whole\s+tune).*$",re.I)

def text(x:Any)->str: return " ".join(str(x or "").strip().split())
def norm(s:str)->str:
    s=unicodedata.normalize("NFKD",s).encode("ascii","ignore").decode().lower().replace("'","")
    return " ".join(re.sub(r"[^a-z0-9]+"," ",s).split())
def compact_norm(s:str)->str: return norm(s).replace(" ","")
def esc(s:Any)->str: return str(s or "").replace("|","\\|")
def safe_title_file(path:Path)->dict[str,Any]|None:
    """Read only filename/front matter/H1; stop before body."""
    fm={}; h1=""; short=""; infm=False
    try:
      with path.open(encoding="utf-8",errors="replace") as f:
        for i,line in enumerate(f):
          if i==0 and line.strip()=="---": infm=True; continue
          if infm:
            if line.strip()=="---": infm=False; continue
            m=re.match(r"^([A-Za-z_][\w-]*):\s*(.*?)\s*$",line)
            if m: fm[m.group(1).lower()]=m.group(2).strip().strip("\"'")
            continue
          if line.startswith("# "):
            raw_h1=text(line[2:])
            short=re.search(r'\s+\{short="([^"]+)"\}\s*$',raw_h1)
            short=text(short.group(1)) if short else ""
            h1=text(re.sub(r"\s+\{short=[^}]*\}\s*$","",raw_h1)); break
          if i>250: break
    except OSError: return None
    title=text(fm.get("title") or h1 or path.stem.replace("-"," "))
    return {"title":title,"h1":h1 or None,"front_matter_title":text(fm.get("title")) or None,"short_alias":short or None}

def read_catalog(songdir:Path)->list[dict[str,Any]]:
    rows=[]
    for p in sorted(songdir.glob("*.md")):
      meta=safe_title_file(p)
      if not meta: continue
      aliases=sorted({x for x in [meta['title'],meta['h1'],meta['front_matter_title'],meta['short_alias'],p.stem.replace("-"," ")] if x})
      rows.append({"canonical_song_id":p.stem,"canonical_song_path":f"songs/{p.name}","canonical_title":meta['title'],"aliases":aliases})
    return rows

def title_from_filename(filename:str)->str:
    s=EXT.sub("",Path(filename).name)
    s=re.sub(r"^[A-Z]\d+\s*-\s*","",s) # iCloud sequence labels only
    s=re.sub(r"\s*\[[^]]+\]$","",s)
    s=re.sub(r"\s+-\s+[A-Za-z .]+$","",s) # version/performer suffix, evidence only
    s=re.sub(r"\s+[A-Z]$","",s) # A/B arrangements
    return text(s)

def normalize_identity(label:str)->str:
    s=text(label).lstrip("@").strip()
    s=re.sub(r"[?*!]+$","",s).strip()
    s=re.sub(r"\s+-\s*.*$","",s).strip()
    s=re.sub(r"\s*\[[^]]+\]", "", s)
    # A parenthesized key is annotation even when a later personnel tail follows.
    had_parenthesized_key=bool(re.search(r"\s*\((?:[A-G](?:#|b)?(?:m|maj7|sus[24])?|N/?C)\)",s,re.I))
    s=re.sub(r"\s*\((?:[A-G](?:#|b)?(?:m|maj7|sus[24])?|N/?C)\)", "", s, flags=re.I)
    s=DIRECTION.sub("",s).strip()
    # Remove trailing parentheticals only when key, personnel, equipment, or directions.
    while True:
      m=re.search(r"\s*\(([^()]*)\)\s*$",s)
      if not m: break
      inside=text(m.group(1)); pieces=[text(x) for x in re.split(r"[/,]",inside)]
      low=norm(inside)
      structured=(bool(pieces) and all(KEY.fullmatch(x) or PERFORMER.fullmatch(x) for x in pieces)) or any(x in low for x in ["acoustic","bass","guitar","keys","piano","vox","vocal","optional","solo","lineup"])
      if not structured: break
      s=s[:m.start()].rstrip()
    # Common bare personnel/key tail after a source-export annotation.
    s=DIRECTION.sub("",s).strip()
    # Bare `am` can be part of a title (for example, "3 am"); remove a
    # trailing bare key only after a structured parenthesized-key annotation.
    if had_parenthesized_key:
      s=re.sub(r"\s+(?:[A-G](?:#|b)?(?:m|maj7|sus[24])?)\s*$", "", s, flags=re.I)
    s=re.sub(r"\s+(?:[A-G](?:#|b)?m?\s+)?(?:jmb|kgl|dlg|jp|james|matt|dave|kyle|rae|rachel|jess|codi)\s*$","",s,flags=re.I)
    s=text(re.sub(r"[?*!]+$","",s).strip())
    return TITLE_EQUIVALENTS.get(norm(s),s)

def split_raw(label:str)->list[str]|None:
    """Conservative supplementary split only; source matcher components win."""
    clean=normalize_identity(label)
    if re.search(r"\s*/\s*",clean): p=re.split(r"\s*/\s*",clean)
    elif re.search(r"\s+into\s+",clean,re.I): p=re.split(r"\s+into\s+",clean,flags=re.I)
    elif len(re.findall(r"\s+to\s+",clean,re.I))>=2: p=re.split(r"\s+to\s+",clean,flags=re.I)
    else: return None
    p=[text(x) for x in p if text(x)]
    return p if len(p)>1 else None

def catalog_hits(identity:str,catalog:list[dict[str,Any]])->list[dict[str,Any]]:
    q=norm(identity); cq=compact_norm(identity); exact=[]
    for song in catalog:
      aliases=[a for a in song['aliases'] if norm(a)==q or compact_norm(a)==cq]
      if aliases: exact.append({**{k:song[k] for k in ('canonical_song_id','canonical_song_path','canonical_title')},"matched_aliases":aliases,"confidence":"high"})
    return sorted(exact,key=lambda x:(x['canonical_title'],x['canonical_song_id']))

def top_catalog(identity:str,catalog:list[dict[str,Any]])->list[dict[str,Any]]:
    q=norm(identity); scored=[]
    for s in catalog:
      score=max(SequenceMatcher(None,q,norm(a)).ratio() for a in s['aliases'])
      scored.append((score,s))
    return [{"canonical_song_id":s['canonical_song_id'],"canonical_song_path":s['canonical_song_path'],"canonical_title":s['canonical_title'],"score":round(score,3)} for score,s in sorted(scored,key=lambda x:(-x[0],x[1]['canonical_title'],x[1]['canonical_song_id']))[:3]]

def lead_confidence(identity:str,title:str)->tuple[float,str]:
    score=SequenceMatcher(None,norm(identity),norm(title)).ratio()
    return round(score,3), "high" if norm(identity)==norm(title) else ("medium" if score>=.88 else "low")

def read_notion_candidates(base:Path)->list[dict[str,Any]]:
    out=[]
    if not base.is_dir(): return out
    for p in sorted(base.glob("*.md")):
      meta=safe_title_file(p)
      if meta: out.append({"candidate_path":p.name,"title":meta['title'],"h1":meta['h1'],"front_matter_title":meta['front_matter_title']})
    return out

def read_icloud(path:Path)->list[dict[str,Any]]:
    out=[]
    for line in path.read_text(encoding="utf-8").splitlines():
      r=json.loads(line)
      if r.get('type')!='individual_song_lead_sheet': continue
      out.append({"path":r.get('path'),"filename":r.get('filename'),"logical_title":title_from_filename(r.get('filename','')),"band":r.get('band')})
    return sorted(out,key=lambda x:(x['logical_title'],x['path']))

def support(identity:str,notion:list[dict[str,Any]],icloud:list[dict[str,Any]])->list[dict[str,Any]]:
    rows=[]
    for n in notion:
      score,conf=lead_confidence(identity,n['title'])
      if conf in {'high','medium'}: rows.append({"source":"notion_candidate_metadata","title":n['title'],"candidate_path":n['candidate_path'],"confidence":conf,"score":score})
    for i in icloud:
      score,conf=lead_confidence(identity,i['logical_title'])
      if conf in {'high','medium'}: rows.append({"source":"icloud_individual_song_lead_sheet_logical_filename","title":i['logical_title'],"path":i['path'],"band":i['band'],"confidence":conf,"score":score})
    unique={}
    for row in rows:
      key=json.dumps(row,sort_keys=True,ensure_ascii=False)
      unique[key]=row
    return sorted(unique.values(),key=lambda x:({"high":0,"medium":1}[x['confidence']],-x['score'],x['source'],x.get('candidate_path',x.get('path',''))))

def source_refs(source:str,data:dict[str,Any],container:dict[str,Any])->dict[str,Any]:
    if source=='notion':
      return {"source_type":"notion","gig_name":container.get('gig_name'),"date_start":container.get('date_start'),"venue_or_location":container.get('venue_or_location'),"page_id":container.get('page_id'),"source_block_id":data.get('source_block_id'),"source_path":data.get('source_path')}
    if source=='icloud':
      return {"source_type":"icloud","candidate_id":container.get('candidate_id'),"date_raw":container.get('date_raw'),"venue_raw":container.get('venue_raw'),"band":container.get('band_explicit') or container.get('band_proposal'),"artifact_paths":container.get('artifact_paths')}
    return {"source_type":"github","repository":container.get('repository'),"commit_sha":container.get('commit_sha'),"date_raw":container.get('date_raw')}

def is_performer_initial_component(value:str)->bool:
    return bool(re.fullmatch(r"[A-Z]{1,3}",text(value)))

def strip_performer_initial_tail(value:str)->str:
    """Strip a bare uppercase initial tail only when a title precedes it."""
    return text(re.sub(r"\s+[A-Z]{1,3}$", "", value)) if re.search(r"\S+\s+[A-Z]{1,3}$",value) else value

def collect(root:Path)->list[dict[str,Any]]:
    results=[]
    # Explicit schema traversal avoids treating any unrelated matching fields as labels.
    inputs=[('github',json.loads((root/'candidates/github-set-lists-matched.json').read_text())),('notion',json.loads((root/'candidates/notion-set-lists-matched.json').read_text())),('icloud',json.loads((root/'candidates/icloud-set-lists-matched.json').read_text()))]
    for source,doc in inputs:
      if source=='github': groups=[(c,c.get('ordered_songs',[]),'song') for c in doc.get('candidates',[])]
      elif source=='notion': groups=[(g,g.get('body_song_evidence_ordered',[]),'label') for g in doc.get('gigs',[])]
      else: groups=[(g,s.get('songs',[]),'label') for g in doc.get('gig_candidates',[]) for s in g.get('groups',[])]
      for container,items,key in groups:
        for item in items:
          cm=item.get('catalog_match') or {}
          if cm.get('match_status') not in REVIEW_STATUSES: continue
          raw=text(item.get(key) or cm.get('raw_label'))
          refs=source_refs(source,item,container)
          cleaned=normalize_identity(cm.get('cleaned_title') or raw)
          concatenated=CONCATENATED_MULTI_TITLES.get(norm(cleaned))
          if concatenated:
            for pos,val in enumerate(concatenated,1):
              results.append({"identity":normalize_identity(val),"raw_label":raw,"raw_component":val,"component_position":pos,"match_status":"concatenated_multi_title_component","proposed_match_status":None,"source_reference":refs})
          elif cm['match_status']=='composite_review':
            comps=cm.get('component_proposals') or []
            substantive=[]
            for pos,p in enumerate(comps,1):
              raw_component=text(p.get('raw_component'))
              if is_performer_initial_component(raw_component): continue
              val=strip_performer_initial_tail(normalize_identity(p.get('cleaned_title') or raw_component))
              if val: substantive.append((pos,p,val))
            # A slash containing only performer initials after one title is not a medley.
            if len(substantive)==1 and len(comps)>1:
              pos,p,val=substantive[0]
              results.append({"identity":val,"raw_label":raw,"raw_component":None,"component_position":None,"match_status":"performer_initials_stripped","proposed_match_status":p.get('proposed_match_status'),"source_reference":refs})
            else:
              for pos,p,val in substantive:
                results.append({"identity":val,"raw_label":raw,"raw_component":p.get('raw_component'),"component_position":pos,"match_status":"composite_component","proposed_match_status":p.get('proposed_match_status'),"source_reference":refs})
          else:
            # Do not invent a split for a non-composite source label; record it as one
            # ambiguous label, while preserving any raw separator in the evidence.
            results.append({"identity":cleaned,"raw_label":raw,"raw_component":None,"component_position":None,"match_status":cm['match_status'],"proposed_match_status":None,"source_reference":refs})
    return results

def classify(identity:str,events:list[dict[str,Any]],hits:list[dict[str,Any]])->str:
    n=norm(identity)
    if n in NOISE or not n: return 'non_song_untitled_noise'
    composite_statuses={'composite_component','concatenated_multi_title_component'}
    has_standalone=any(e['match_status'] not in composite_statuses for e in events)
    if hits and has_standalone: return 'obvious_existing_catalog_alias_review'
    # A grouped identity can have both independent occurrences and one composite
    # occurrence; its per-occurrence review_status_counts preserves that distinction.
    if has_standalone:
      if re.search(r"\s+(?:or|and)\s+|/",identity,re.I): return 'ambiguous_label'
      return 'likely_genuinely_missing_canonical_song'
    if any(e['match_status'] in composite_statuses for e in events): return 'medley_or_composite_component'
    if hits: return 'obvious_existing_catalog_alias_review'

def build(root:Path,songs:Path,notion_dir:Path,manifest:Path)->dict[str,Any]:
    catalog=read_catalog(songs); notion=read_notion_candidates(notion_dir); icloud=read_icloud(manifest); events=collect(root)
    grouped=defaultdict(list)
    for e in events: grouped[norm(e['identity'])].append(e)
    identities=[]
    for key,es in sorted(grouped.items()):
      identity=sorted({e['identity'] for e in es},key=lambda x:(len(x),x.casefold(),x))[0]
      hits=catalog_hits(identity,catalog); refs=[]; seen=set()
      for e in sorted(es,key=lambda x:json.dumps(x['source_reference'],sort_keys=True)):
        k=json.dumps(e['source_reference'],sort_keys=True,ensure_ascii=False)
        if k not in seen: seen.add(k); refs.append(e['source_reference'])
      raws=Counter(e['raw_label'] for e in es)
      statuses=Counter(e['match_status'] for e in es)
      identities.append({"proposed_identity":identity,"proposed_song_identity":identity,"normalized_identity":key,"classification":classify(identity,es,hits),"occurrence_count":len(es),"raw_labels":[{"raw_label":r,"occurrence_count":c} for r,c in sorted(raws.items(),key=lambda x:(norm(x[0]),x[0]))],"review_status_counts":dict(sorted(statuses.items())),"source_references":refs,"catalog_alias_hits":hits,"catalog_fuzzy_context":[] if hits else top_catalog(identity,catalog),"supporting_lead_sheet_candidates":support(identity,notion,icloud)})
    counts=Counter(x['classification'] for x in identities)
    return {"schema_version":"1.0","scope":{"matched_inputs":["candidates/github-set-lists-matched.json","candidates/notion-set-lists-matched.json","candidates/icloud-set-lists-matched.json"],"notion_candidate_metadata":"filenames, front matter titles, and H1 only; no bodies","icloud_manifest":"individual_song_lead_sheet logical filenames/path/band only","canonical_catalog":"filenames, front matter titles, H1, and aliases only; no bodies","writes":"research directory only; no canonical songs created or changed"},"method":"deterministic grouping of every unmatched, fuzzy_review, and composite_review component; exact normalized metadata evidence only for high-confidence support; fuzzy context is advisory and never changes a match","summary":{"input_occurrences":len(events),"proposed_identities":len(identities),"classification_counts":dict(sorted(counts.items())),"catalog_song_count":len(catalog),"notion_candidate_count":len(notion),"icloud_individual_song_lead_sheet_count":len(icloud)},"identities":identities}

def report(data:dict[str,Any])->str:
    s=data['summary']; lines=['# Missing-song evidence queue','', 'Metadata-only review queue. No canonical songs were created or changed; song and lead-sheet bodies were not read or retained.','',f"Occurrences: **{s['input_occurrences']}**; normalized proposed identities: **{s['proposed_identities']}**.",'', '## Classification summary','', '| Classification | Identities |','|---|---:|']
    for k,v in s['classification_counts'].items(): lines.append(f'| {k.replace("_"," ")} | {v} |')
    lines += ['', '## Review queue','', '| Proposed identity | Class | Occurrences | Lead-sheet support | Catalog check | Raw labels |','|---|---|---:|---|---|---|']
    order={'likely_genuinely_missing_canonical_song':0,'ambiguous_label':1,'medley_or_composite_component':2,'obvious_existing_catalog_alias_review':3,'non_song_untitled_noise':4}
    for x in sorted(data['identities'],key=lambda x:(order[x['classification']],-x['occurrence_count'],norm(x['proposed_song_identity']))):
      support=', '.join(f"{z['title']} ({z['confidence']})" for z in x['supporting_lead_sheet_candidates'][:3]) or '—'
      cat=', '.join(z['canonical_title'] for z in x['catalog_alias_hits']) or ('; '.join(f"{z['canonical_title']} {z['score']:.3f}" for z in x['catalog_fuzzy_context'][:1]) if x['catalog_fuzzy_context'] else '—')
      raws='; '.join(f"{z['raw_label']} ×{z['occurrence_count']}" for z in x['raw_labels'])
      lines.append(f"| {esc(x['proposed_song_identity'])} | {x['classification'].replace('_',' ')} | {x['occurrence_count']} | {esc(support)} | {esc(cat)} | {esc(raws)} |")
    lines += ['', '## Interpretation rules','', '- `likely genuinely missing canonical song` is a review candidate, not a request to create a canonical song.', '- `obvious existing catalog alias review` has an exact normalized existing catalog title/alias after evidence-only cleanup; accepted matches were not modified.', '- `medley or composite component` retains its source matcher component status; components are never collapsed into one song.', '- `ambiguous label` and `non-song Untitled noise` need human review before any catalog action.', '- JSON `source_references` preserves gig/source references; `supporting_lead_sheet_candidates` contains only metadata/filename evidence and confidence.']
    return '\n'.join(lines)+'\n'

def regression_assertions(data:dict[str,Any])->None:
    """Guard title-like `am` from being mistaken for an unparenthesized key."""
    assert normalize_identity("3 am")=="3 am", "bare title suffix `am` must not be stripped as A minor"
    assert any(x.get("proposed_identity")=="3 am" for x in data["identities"]), "3 am must remain a proposed identity"

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--research',default='.'); ap.add_argument('--songs',default='/home/exedev/songs/songs'); ap.add_argument('--notion-candidates',default='/home/exedev/songs/migration/notion-candidates'); ap.add_argument('--icloud-manifest',default='manifests/icloud-artifacts.jsonl'); args=ap.parse_args()
 root=Path(args.research); data=build(root,Path(args.songs),Path(args.notion_candidates),root/args.icloud_manifest)
 regression_assertions(data)
 (root/'candidates'/'missing-song-evidence.json').write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
 (root/'reports'/'missing-song-evidence.md').write_text(report(data))
if __name__=='__main__': main()
