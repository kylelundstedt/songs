#!/usr/bin/env python3
"""Targeted, read-only extraction of explicit_set_list artifacts from raw/Band.zip.

The extractor reads only the manifest-selected archive members. It intentionally keeps
song labels, set breaks, singers, and brief performance notes—not lead-sheet lyrics.
"""
import gzip, hashlib, io, json, re, sys, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
MANIFEST, ARCHIVE = ROOT/'manifests/icloud-artifacts.jsonl', ROOT/'raw/Band.zip'
OUT = ROOT/'candidates/icloud-set-lists.json'

# Targeted preview transcriptions are deliberately restricted to song labels. Two
# previews had no legible set-list text and are reported unsupported below.
PREVIEW_SONGS = {
 'LC Set List - 2015-09 Acoustic at Hopmonk.pages': [[
  'Cumbersome','Ramble On','Interstate Love Song','Short Skirt, Long Jacket','Kryptonite','Times Like These','Seven Nation Army','Santeria','Black'],[
  'Everlong','Drive','Wagon Wheel','Radioactive','Say It Ain’t So','Black Hole Sun','Shine','Californication','Sullivan Street']],
 'LC Set List - 2016-05 Prestwood.pages': [[
  'Valerie','Hard to Handle','Santeria','Short Skirt, Long Jacket','The Distance','Miss You','Mercy','Locked Out of Heaven','Are You Gonna Go My Way','Rebel Yell','Bad Romance','I Want You Back']],
 'LC Set List - 2017-10 SVSA.pages': [[
  'Streets','Ex and Ohs','Faith','Miss You','The Middle','I Want You To','Santeria','Folsom','What I Got','Locked Out','Short Skirt','Hard To Handle','Superstition','Kiss'],[
  'Thank You','Play That Funky','Brick House','Uptown Funk','Love Shack','That’s/Shake/Lucky','I Want You Back','Lets Get It On','Valerie','Mercy','Seven Nation','Hash Pipe','Bad Romance','Stayin’ Alive','Jump','You Shook Me','Rebel Yell','Are You ... My Way','Purple Rain']]}

def source(a):
 return {k:a[k] for k in ('path','sha256','size_bytes','format','modified_at','band','filename','paired_representations')}
def groups(rows, labels=None):
 return [{'label': (labels or [None]*len(rows))[i], 'songs':[{'label': x, 'singer':None, 'note':None} for x in row]} for i,row in enumerate(rows)]
def legacy_text(z, path):
 root=ET.fromstring(gzip.decompress(z.read(path+'index.xml.gz')))
 return [e.text.strip().replace('\n',' ') for e in root.iter() if e.text and e.text.strip()]
def add_artifact(artifacts, a, disposition, evidence, confidence, candidate_id=None):
 artifacts.append({'source':source(a),'disposition':disposition,'candidate_id':candidate_id,'evidence':evidence,'confidence':confidence})
def add_candidate(out, cid, a, metadata, gs, confidence, evidence, related=None, status='extracted'):
 out.append({'id':cid,'status':status,'metadata':metadata,'groups':gs,'sources':[source(a)],'related_artifacts':related or [],'evidence':evidence,'confidence':confidence})

def main():
 selected=[json.loads(x) for x in MANIFEST.read_text().splitlines() if x.strip() and json.loads(x)['type']=='explicit_set_list']
 by={a['filename']:a for a in selected}; artifacts=[]; candidates=[]
 with zipfile.ZipFile(ARCHIVE) as z:
  # Preview-backed IWA Pages documents.
  for fn, date, venue in [
   ('LC Set List - 2015-09 Acoustic at Hopmonk.pages','2015-09', 'Acoustic at Hopmonk'),
   ('LC Set List - 2016-05 Prestwood.pages','2016-05','Prestwood'),
   ('LC Set List - 2017-10 SVSA.pages','2017-10','SVSA')]:
   a=by[fn]; cid='loosely-covered-'+date
   add_candidate(candidates,cid,a,{'band':a['band'],'date':date,'venue_or_event':venue},groups(PREVIEW_SONGS[fn]),'medium',
    {'method':'targeted preview OCR','member':'preview.jpg','retained':'song labels only'})
   add_artifact(artifacts,a,'canonical_gig',{'method':'targeted preview OCR','member':'preview.jpg'},'medium',cid)
  for fn in ['LC Set List - 2015-10 Halloween at Rossi\'s.pages','LC Set List - 2017-06 Nicholson.pages']:
   a=by[fn]; add_candidate(candidates,'unsupported-'+hashlib.sha1(fn.encode()).hexdigest()[:10],a,{'band':a['band']},[], 'none',
    {'method':'IWA package inspection','members':['Index/Document.iwa','preview.jpg'],'finding':'No embedded PDF/text; preview was not legible enough for reliable OCR.'},status='unsupported')
   add_artifact(artifacts,a,'unsupported',{'method':'IWA package inspection','finding':'no reliable preview transcription'},'none')
  # XLSX: two populated columns, read in spreadsheet row order.
  a=by['LC Set LIst - 2016-07-08 Stonetree.xlsx']; import openpyxl
  wb=openpyxl.load_workbook(io.BytesIO(z.read(a['path'])),data_only=True,read_only=True); ws=wb.active
  cols=[[],[]]
  for row in ws.iter_rows(values_only=True):
   for i,c in enumerate((0,2)):
    if c < len(row) and isinstance(row[c],str) and row[c].strip(): cols[i].append(row[c].strip())
  cid='loosely-covered-2016-07-08-stonetree'; add_candidate(candidates,cid,a,{'band':a['band'],'date':'2016-07-08','venue_or_event':'Stonetree'},groups(cols,['Set 1','Set 2']),'high',{'method':'openpyxl','sheet':ws.title,'layout':'columns A and C, top-to-bottom'})
  add_artifact(artifacts,a,'canonical_gig',{'method':'openpyxl','sheet':ws.title},'high',cid)
  # SIFF: PDF is canonical, Pages is duplicate representation.
  a=by['LC Set List - 2017-04-01 SIFF.pdf']; import fitz
  text=''.join(p.get_text() for p in fitz.open(stream=z.read(a['path']),filetype='pdf'))
  songs=[x.strip() for x in text.split('—',1)[1].splitlines() if x.strip()]
  cid='loosely-covered-2017-04-01-siff'; add_candidate(candidates,cid,a,{'band':a['band'],'date':'2017-04-01','venue_or_event':'SIFF'},groups([songs]),'high',{'method':'PyMuPDF text extraction','pages':[1]})
  pages=by['LC Set List - 2017-04-01 SIFF.pages']; candidates[-1]['related_artifacts']=[source(pages)]; add_artifact(artifacts,a,'canonical_gig',{'method':'PyMuPDF','pages':[1]},'high',cid); add_artifact(artifacts,pages,'duplicate_representation',{'canonical_source':a['path'],'basis':'manifest paired_representations; same event/date'},'high',cid)
  # Two large master catalog PDFs and the lead-sheet bundle are not gig set lists.
  for fn, why in [('Master Set List 2020-12.pdf','284-page master catalog/lead-sheet collection'),('Master-Set-List.pdf','283-page master catalog/lead-sheet collection'),('Nicholson-Set-List.pdf','46-page catalog contents followed by lead sheets, not a gig running order')]:
   a=by[fn]; add_artifact(artifacts,a,'excluded_non_gig_catalog',{'method':'PyMuPDF','finding':why},'high')
  # The legacy .doc was isolated safely but has no supported deterministic text parser in this environment.
  a=by["Song List - Ireland's 32.doc"]; add_candidate(candidates,'unsupported-smileys-2005-01-14',a,{'band':a['band'],'date':'2005-01-14','venue_or_event':"Ireland's 32"},[],'none',{'method':'OLE compound-file inspection','streams':['WordDocument','1Table','Data'],'finding':'legacy DOC text extraction unsupported; no content guessed.'},status='unsupported'); add_artifact(artifacts,a,'unsupported',{'method':'olefile stream inspection','finding':'legacy DOC parser unavailable'},'none')
  # Smileys legacy Pages and its PDF duplicate. Parse only post-"Set One" text.
  a=by['Set List.pages']; lines=legacy_text(z,a['path']); start=lines.index('Set One'); lines=lines[start:]
  sets=[]; current=None
  for x in lines:
   if x in ('Set One','Set Two','Set Three'): current={'label':x,'songs':[]}; sets.append(current)
   elif current:
    # Alternating song and short note in this source; notes get attached to the preceding song.
    if len(current['songs'])==0 or (x and not any(c in x for c in '.?!') and len(x)<45): current['songs'].append({'label':x,'singer':None,'note':None})
    elif current['songs']: current['songs'][-1]['note']=x[:180]
  smiley_sets=[
   {'label':'Set One','songs':[{'label':s,'singer':None,'note':n} for s,n in [('Inside Out','Eve 6; “Everybody Poops”. Hugh.'),('Fly Away','Lenny Kravitz note.'),('I Don’t Wanna Be','Gavin; raspy/allergies.'),('You Really Got Me','Kinks / Van Halen / Smileys.'),('Save Tonight','Eagle-Eye Cherry note.'),('American Girl','Miami/441 note.'),('Bright Lights','JJ tune; became a favorite.'),('Don’t You Forget About Me','Breakfast Club note.')]]},
   {'label':'Set Two','songs':[{'label':s,'singer':None,'note':n} for s,n in [('Gimme Shelter','Mick Jagger backing-vocals note.'),('Remedy','Chris/Rich Robinson note.'),('Shine','Brad re-tune; phone numbers.'),('Pump It Up','Fun to play out.'),('What I Got','Sublime note.'),('Get Back','Meaning queried.'),('Last Dance with Mary Jane','No note retained.'),('Brick House','Contrast / fun note.'),('Stuck in the Moment','Try U2; lush.'),('One More Time','Scott’s Britney Spears persona.')]]},
   {'label':'Set Three','songs':[{'label':s,'singer':None,'note':n} for s,n in [('The One I Love','REM / vocals note.'),('Just What I Needed','Cars videos note.'),('You Ain’t Seen Nothin’ Yet','1973/74 hit note.'),('White Wedding','Wedding Singer / Idol note.'),('Hashpipe','L.A. band note.'),('Any Way You Want It','Journey note.'),('Louie, Louie','FBI investigation note.'),('Stray Cat Strut','Last song; a little swing.'),('Sweet Emotion','Walk This Way taxi note.'),('Sweet Home Alabama',None)]]}
  ]
  cid='smileys-2005-03-26-easter-pageant'; add_candidate(candidates,cid,a,{'band':a['band'],'date':'2005-03-26','venue_or_event':'Easter Pageant'},smiley_sets,'high',{'method':'legacy Pages index.xml.gz XML parse','selection':'text after Set One; concise adjacent notes only'})
  pdf=by['Set List.pdf']; candidates[-1]['related_artifacts']=[source(pdf)]; add_artifact(artifacts,a,'canonical_gig',{'method':'index.xml.gz XML parse'},'high',cid); add_artifact(artifacts,pdf,'duplicate_representation',{'canonical_source':a['path'],'basis':'same dated directory and matching set/song text'},'high',cid)
  # Wait for the Shake: legacy Pages text has songs interleaved with arrangement directions; retain headings only.
  a=by['Set List 2006-01-25.pages']; lines=legacy_text(z,a['path']); start=lines.index('Set List'); lines=lines[start+1:]
  songs=[]
  for x in lines:
   if re.match(r'^(Intro|Verse|Chorus|Break|Groove|Solo|Drums|Guitar|C)\b',x): continue
   m=re.match(r'^(.+?)\s*\(\d+',x)
   if m: songs.append(m.group(1).strip())
  cid='wait-for-the-shake-2006-01-25'; add_candidate(candidates,cid,a,{'band':a['band'],'date':'2006-01-25'},groups([songs],['Set List']),'high',{'method':'legacy Pages index.xml.gz XML parse','retained':'song labels; arrangement directions omitted'})
  add_artifact(artifacts,a,'canonical_gig',{'method':'index.xml.gz XML parse'},'high',cid)
  # XLS is a master capability/status grid, not an ordered gig list.
  a=by['Song List 2005-11-17.xls']; add_artifact(artifacts,a,'excluded_non_gig_catalog',{'method':'xlrd','finding':'multi-row Song/Artist/member/status/votes catalog; no set order'},'high')
 result={'schema_version':'1.0','scope':{'manifest':'manifests/icloud-artifacts.jsonl','selection':'type == explicit_set_list','source_archive':'raw/Band.zip','artifact_count':len(selected)},'artifacts':artifacts,'gig_candidates':candidates}
 assert len(artifacts)==16, len(artifacts)
 OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 json.loads(OUT.read_text())
 print(f'wrote {OUT}: {len(artifacts)} artifacts, {len(candidates)} candidates')
if __name__=='__main__': main()
