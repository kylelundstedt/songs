#!/usr/bin/env python3
"""Deterministic, conservative reconciliation of collected set-list candidates.

Reads candidate JSON in this repository and canonical sets in ../songs read-only.  It
only groups sources as one event when a full calendar date and additional evidence
support that conclusion; month-precision dates are valid import metadata but
intentionally never auto-merge.
"""
from __future__ import annotations
import hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def locate_songs_repo():
    """Find the application repository in standalone or embedded research layouts."""
    candidates=[ROOT, *ROOT.parents, ROOT.parent/'songs']
    for candidate in candidates:
        if (candidate/'songs').is_dir() and (candidate/'sets').is_dir():
            return candidate
    raise RuntimeError('cannot locate Songs repository containing songs/ and sets/')

SONGS=locate_songs_repo()
OUT=ROOT/'candidates/reconciled-set-lists.json'; REPORT=ROOT/'reports/reconciliation.md'

def load(p): return json.loads(Path(p).read_text())
def norm(s): return re.sub(r'[^a-z0-9]+',' ',(s or '').lower()).strip()
def date_parts(s):
    """Classify approved source date forms without changing their raw evidence."""
    if not isinstance(s, str) or not s.strip():
        return {'raw': s, 'value': None, 'precision': 'missing', 'day': None}
    if re.fullmatch(r'\d{4}-(?:0[1-9]|1[0-2])', s):
        return {'raw': s, 'value': s, 'precision': 'month', 'day': None}
    if re.fullmatch(r'\d{4}-\d\d-\d\d(?:T.*)?', s):
        # Date-only values and timestamp values are both day-precision. Preserve
        # the timestamp in raw while using its calendar-date portion as value.
        return {'raw': s, 'value': s[:10], 'precision': 'day', 'day': s[:10]}
    # There are no other supported partial-date forms. Keep unexpected source text
    # as raw evidence, but make it non-publishable just like an absent date.
    return {'raw': s, 'value': None, 'precision': 'missing', 'day': None}
def full_date(s):
    return date_parts(s)['precision']=='day'
def day(s): return date_parts(s)['day']
def venue_norm(s): return norm(s).replace('murphy s','murphys').replace('reel and brand','reel brand')
def title_norm(s):
    # Conservative: remove only obvious document-role suffixes, retaining event words.
    x=norm(s); x=re.sub(r'\b(start stop notes|start stop|print|candidate)\b','',x)
    return re.sub(r'\s+',' ',x).strip()
def canon_songs(items):
    out=[]
    for x in items:
        m=x.get('catalog_match') or {}
        if m.get('match_status') in ('exact','normalized') and m.get('canonical_song_id'): out.append(m['canonical_song_id'])
    return out
def sim(a,b):
    if not a or not b:return {'overlap':0.0,'sequence':0.0}
    # set overlap and positional agreement, intentionally simple/deterministic.
    overlap=len(set(a)&set(b))/min(len(set(a)),len(set(b))) if set(a) and set(b) else 0
    sequence=sum(x==y for x,y in zip(a,b))/min(len(a),len(b))
    return {'overlap':round(overlap,3),'sequence':round(sequence,3)}
def flatten_groups(groups): return [s for g in groups for s in g.get('songs',[])]
def source_ref(kind, rec):
    if kind=='github': return {'repository':rec['repository'],'commit_sha':rec['commit_sha'],'default_branch':rec.get('default_branch')}
    if kind=='notion': return {'page_id':rec['page_id'],'source_created_time':rec.get('source_created_time'),'source_last_edited_time':rec.get('source_last_edited_time')}
    return {'candidate_id':rec['id'],'sources':rec.get('sources',[]),'related_artifacts':rec.get('related_artifacts',[])}
def record_ref(input_file, collection_key, object_id):
    return {'input_file':input_file,'collection_key':collection_key,'object_id':object_id}
def band_proposal(title, explicit):
    n=norm(title)
    if re.search(r'\blc\b|loosely covered',n):
        return {'value':'Loosely Covered','confidence':'medium','basis':'title abbreviation LC corroborated by explicit Loosely Covered labels in other sources; proposal only'} if not explicit else None
    return None
def main():
    gh=load(ROOT/'candidates/github-set-lists-matched.json')['candidates']
    no=load(ROOT/'candidates/notion-set-lists-matched.json')['gigs']
    ic=load(ROOT/'candidates/icloud-set-lists-matched.json')
    records=[]
    for r in gh:
        g=r['gig']; songs=canon_songs(r['ordered_songs'])
        records.append({'source_type':'github','source_id':r['repository']+'@'+r['commit_sha'],'source_record_ref':record_ref('candidates/github-set-lists-matched.json','candidates',r['repository']+'@'+r['commit_sha']),'source_reference':source_ref('github',r),'status':'extracted','confidence':g.get('date_confidence'),'date_raw':g.get('date'),'date_value':date_parts(g.get('date'))['value'],'date_precision':date_parts(g.get('date'))['precision'],'date_exact':day(g.get('date')),'title_raw':g.get('title'),'venue_raw':g.get('location'),'band_explicit':r.get('band_name'),'band_proposal':None,'song_ids':songs,'song_count':len(r['ordered_songs']),'song_match_count':len(songs),'ordering_ambiguous':False,'ambiguities':[]})
    for r in no:
        songs=canon_songs(r['body_song_evidence_ordered']); ambiguous=any('columns' in a.lower() for a in r.get('ambiguity',[]))
        records.append({'source_type':'notion','source_id':r['page_id'],'source_record_ref':record_ref('candidates/notion-set-lists-matched.json','gigs',r['page_id']),'source_reference':source_ref('notion',r),'status':'extracted' if songs else 'unsupported','confidence':r.get('confidence'),'date_raw':r.get('date_start'),'date_value':date_parts(r.get('date_start'))['value'],'date_precision':date_parts(r.get('date_start'))['precision'],'date_exact':day(r.get('date_start')),'title_raw':r.get('gig_name'),'venue_raw':r.get('venue_or_location'),'band_explicit':None,'band_proposal':band_proposal(r.get('gig_name'),False),'song_ids':songs,'song_count':len(r['body_song_evidence_ordered']),'song_match_count':len(songs),'ordering_ambiguous':ambiguous,'ambiguities':r.get('ambiguity',[])})
    for r in ic['gig_candidates']:
        md=r['metadata']; songs=canon_songs(flatten_groups(r.get('groups',[])))
        records.append({'source_type':'icloud','source_id':r['id'],'source_record_ref':record_ref('candidates/icloud-set-lists-matched.json','gig_candidates',r['id']),'source_reference':source_ref('icloud',r),'status':r['status'],'confidence':r.get('confidence'),'date_raw':md.get('date'),'date_value':date_parts(md.get('date'))['value'],'date_precision':date_parts(md.get('date'))['precision'],'date_exact':day(md.get('date')),'title_raw':md.get('venue_or_event'),'venue_raw':md.get('venue_or_event'),'band_explicit':md.get('band'),'band_proposal':None,'song_ids':songs,'song_count':len(flatten_groups(r.get('groups',[]))),'song_match_count':len(songs),'ordering_ambiguous':False,'ambiguities':[]})
    # Canonical sets: parse limited frontmatter/list identifiers (not source bodies elsewhere).
    canonical=[]
    for p in sorted((SONGS/'sets').glob('*.md')):
        t=p.read_text(); ds=re.search(r'^date:\s*["\']?([^\n"\']+)',t,re.M); title=re.search(r'^title:\s*["\']?([^\n"\']+)',t,re.M)
        ids=re.findall(r'\[\[songs/([^\]|#]+)',t) + re.findall(r'\]\(\.\./songs/([^/)]+)\.md\)',t)
        canonical.append({'path':str(p.relative_to(SONGS)),'date':ds.group(1).strip() if ds else None,'title':title.group(1).strip() if title else p.stem,'song_ids':ids})
    # Union exact defensible Notion supporting pages only: full date, same normalized venue,
    # and a document-role suffix plus very high canonical song overlap.
    parent=list(range(len(records)))
    def find(x):
        while parent[x]!=x: parent[x]=parent[parent[x]];x=parent[x]
        return x
    def union(a,b):
        a,b=find(a),find(b)
        if a!=b:parent[b]=a
    related=[]; possible=[]; templates=[]
    for i,a in enumerate(records):
      for j,b in enumerate(records[:i]):
        ss=sim(a['song_ids'],b['song_ids'])
        bothfull=a['date_exact'] and b['date_exact']
        same_day=bothfull and a['date_exact']==b['date_exact']
        same_venue=venue_norm(a['venue_raw']) and venue_norm(a['venue_raw'])==venue_norm(b['venue_raw'])
        supporting_role=bool(re.search(r'\b(start stop|print)\b',norm(a['title_raw']))) or bool(re.search(r'\b(start stop|print)\b',norm(b['title_raw'])))
        notes_role=bool(re.search(r'\bnotes?\b',norm(a['title_raw']))) or bool(re.search(r'\bnotes?\b',norm(b['title_raw'])))
        same_core=title_norm(a['title_raw'])==title_norm(b['title_raw']) and bool(title_norm(a['title_raw']))
        supporting_evidence=(supporting_role and same_core and ss['overlap']>=.75) or (notes_role and ss['overlap']>=.9 and ss['sequence']>=.9)
        if same_day and same_venue and supporting_evidence:
            union(i,j); related.append({'kind':'related_supporting_page','source_ids':[a['source_id'],b['source_id']],'basis':{'same_full_date':a['date_exact'],'same_normalized_venue':venue_norm(a['venue_raw']),'song_similarity':ss,'document_role_title':True}})
        elif same_day and (same_venue or same_core) and ss['overlap']>=.55:
            possible.append({'source_ids':[a['source_id'],b['source_id']],'basis':{'same_full_date':a['date_exact'],'same_venue':same_venue,'same_title_core':same_core,'song_similarity':ss},'disposition':'review; not auto-merged'})
        elif a['date_exact'] and b['date_exact'] and a['date_exact']!=b['date_exact'] and ss['sequence']>=.9 and min(len(a['song_ids']),len(b['song_ids']))>=8:
            templates.append({'source_ids':[a['source_id'],b['source_id']],'dates':[a['date_exact'],b['date_exact']],'song_similarity':ss,'disposition':'template_reuse_not_duplicate_gig'})
    possible_source_ids={source_id for pair in possible for source_id in pair['source_ids']}
    buckets={}
    for i,r in enumerate(records): buckets.setdefault(find(i),[]).append(r)
    groups=[]
    for n,rs in enumerate(sorted(buckets.values(),key=lambda x:min(z['source_id'] for z in x)),1):
        primary=next((r for r in rs if r['status']=='extracted'),rs[0])
        c_matches=[]
        for c in canonical:
            ss=sim(primary['song_ids'],c['song_ids'])
            if primary['date_exact']==c['date'] and ss['overlap']>=.75:
                c_matches.append({'canonical_set':c['path'],'basis':{'same_full_date':c['date'],'song_similarity':ss}})
        blockers=[]
        if primary['status']!='extracted': blockers.append('unsupported source extraction')
        if primary['date_precision']=='missing': blockers.append('missing or unsupported date')
        if any(not str(x['title_raw'] or '').strip() for x in rs): blockers.append('missing or blank gig title')
        if any(x['source_id'] in possible_source_ids for x in rs): blockers.append('appears in possible-duplicate pair; resolve event identity before import')
        if primary['source_type']=='notion' and primary['ordering_ambiguous']: blockers.append('Notion column-order ambiguity; order requires review')
        if primary['song_match_count']==0: blockers.append('no canonical-song evidence')
        if c_matches: blockers.append('matches existing canonical set; do not import duplicate')
        import_ready=not blockers
        groups.append({'event_group_id':f'event-{n:03d}','primary_source_id':primary['source_id'],'date_exact':primary['date_exact'],'date_value':primary['date_value'],'date_precision':primary['date_precision'],'date_raw_values':sorted(set(str(x['date_raw']) for x in rs)),'title_raw_values':sorted(set(str(x['title_raw']) for x in rs)),'venue_raw_values':sorted(set(str(x['venue_raw']) for x in rs)),'band_evidence':{'explicit_values':sorted(set(x['band_explicit'] for x in rs if x['band_explicit'])),'proposals':[x['band_proposal'] for x in rs if x['band_proposal']]},'representation_source_ids':[x['source_id'] for x in rs],'canonical_matches':c_matches,'import_disposition':'existing_canonical' if c_matches else ('import_ready' if import_ready else 'review_blocked'),'review_blockers':blockers})
    # iCloud artifact dispositions retained independently, including duplicate representations.
    data={'schema_version':'1.0','method':'deterministic conservative reconciliation; day-precision dates required for automatic cross-page event grouping; month-precision dates are importable but never auto-merged','source_candidate_index':records,'icloud_artifact_dispositions':ic['artifacts'],'event_groups':groups,'related_supporting_pages':related,'possible_duplicates':possible,'template_reuse':templates,'canonical_sets_index':canonical,'input_fingerprints':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT/'candidates/github-set-lists-matched.json',ROOT/'candidates/notion-set-lists-matched.json',ROOT/'candidates/icloud-set-lists-matched.json',ROOT/'manifests/icloud-artifacts.jsonl']}}
    data['counts']={'source_candidates':len(records),'unique_event_groups':len(groups),'exact_duplicate_representations':sum(x['disposition']=='duplicate_representation' for x in ic['artifacts']),'related_supporting_pages':len(related),'possible_duplicates':len(possible),'template_reuse':len(templates),'existing_canonical_matches':sum(bool(g['canonical_matches']) for g in groups),'import_ready_candidates':sum(g['import_disposition']=='import_ready' for g in groups),'review_blocked_candidates':sum(g['import_disposition']=='review_blocked' for g in groups)}
    OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    queue=[]
    for g in groups:
        if g['import_disposition']!='import_ready': queue.append((0 if g['canonical_matches'] else 1,g))
    queue.sort(key=lambda z:(z[0],z[1]['event_group_id']))
    lines=['# Set-list reconciliation','','Generated by `scripts/reconcile_setlists.py`. The reconciled JSON is a normalized index: full raw records remain in the matched input files and are addressed through `source_record_ref`. This pass is conservative: month-precision dates are valid historical metadata for import, but only day-precision dates can auto-merge cross-page representations; Notion API preorder is not treated as performance order when columns are present.','','## Counts','','| Metric | Count |','|---|---:|']+[f"| {k.replace('_',' ')} | {v} |" for k,v in data['counts'].items()]+['','## Prioritized review queue','']
    for p in possible[:6]:
        lines.append(f"1. **Possible duplicate** — `{p['source_ids'][0]}` / `{p['source_ids'][1]}`; {p['basis']}. Keep separate until event identity is confirmed.")
    for _,g in queue[:12]: lines.append(f"1. **{g['event_group_id']}** — `{g['import_disposition']}`; date `{g['date_raw_values']}`; title `{g['title_raw_values']}`. " + '; '.join(g['review_blockers']))
    lines += ['', '## Rules applied', '', '- A missing or unsupported date blocks import; `YYYY-MM` is intentional month-precision metadata and does not.', '- Only day-precision dates may auto-merge cross-source representations; month-precision candidates remain separate pending event-identity review.', '- A missing or blank gig title blocks import.', '- Every representation in a possible-duplicate pair blocks its event group until the pair is resolved.', '- Exact duplicate representations are reported from the iCloud artifact disposition data; they are not new gigs.', '- Related Notion supporting/start-stop/print pages require same full date, same normalized venue, document-role evidence, and canonical-song overlap; title-marked notes pages additionally require near-exact canonical sequence evidence.', '- Same ordered songs on different dates are template reuse, never duplicate gigs.', '- Band abbreviations are proposals only; explicit source band labels are kept separately.', '- Existing canonical match means no duplicate import proposal.']
    REPORT.write_text('\n'.join(lines)+'\n')
    json.loads(OUT.read_text())
if __name__=='__main__': main()
