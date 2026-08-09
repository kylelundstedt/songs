#!/usr/bin/env python3
"""Build TASK-006's immutable, chunked v1 bootstrap payload.

The only corpus bytes are read from a fresh ``git archive v1``.  The checked-in
TASK-001 manifest is an identity contract, not a mutable corpus input.
"""
from __future__ import annotations
import argparse, base64, hashlib, io, json, subprocess, sys, tarfile, tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

BASELINE_REF="v1"
BASELINE_COMMIT="546f59b41d9e9bcf0e81b543c27900a31e26c9e6"
SCHEMA_VERSION="1"
GENERATOR_VERSION="1"
CHUNK_TARGET_SOURCE_BYTES=65536
PAYLOAD_DIR=Path("migration/v2/bootstrap/payload")
BASELINE_PATH=Path("migration/v2/bootstrap/bootstrap-baseline.json")
TASK001_PATH=Path("migration/v2/v1-corpus-manifest.json")

def sha256(data: bytes)->str: return hashlib.sha256(data).hexdigest()
def canonical(value: Any)->bytes: return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)+"\n").encode("utf-8")
def fail(message:str)->None: raise ValueError(message)

def archive_docs(repo:Path)->dict[str,bytes]:
    actual=subprocess.check_output(["git","-C",str(repo),"rev-parse",f"{BASELINE_REF}^{{commit}}"],text=True).strip()
    if actual != BASELINE_COMMIT: fail(f"{BASELINE_REF} resolves to {actual}, expected {BASELINE_COMMIT}")
    raw=subprocess.check_output(["git","-C",str(repo),"archive","--format=tar",BASELINE_REF])
    docs={}
    with tarfile.open(fileobj=io.BytesIO(raw),mode="r:") as tf:
        for item in tf:
            p=PurePosixPath(item.name)
            if not item.isfile() or len(p.parts)<2 or p.parts[0] not in {"songs","sets"} or p.suffix != ".md": continue
            source=tf.extractfile(item)
            if source is None: fail(f"cannot read {item.name}")
            docs[item.name]=source.read()
    return dict(sorted(docs.items()))

def task001_records(repo:Path)->dict[str,dict[str,Any]]:
    try: data=json.loads((repo/TASK001_PATH).read_text(encoding="utf-8"))
    except Exception as exc: fail(f"unable to load TASK-001 manifest: {exc}")
    if data.get("baseline") != {"ref":BASELINE_REF,"commit":BASELINE_COMMIT}: fail("TASK-001 baseline is not exact v1")
    records=data.get("records")
    if not isinstance(records,list): fail("TASK-001 records missing")
    return {r["path"]:r for r in records if isinstance(r,dict) and isinstance(r.get("path"),str)}

def identity_bytes(docs:dict[str,bytes])->bytes:
    # length delimiters make exact paths, content hashes, and content unambiguous.
    out=bytearray()
    for path, raw in docs.items():
        encoded=path.encode("utf-8"); digest=sha256(raw).encode("ascii")
        for part in (encoded,digest,raw): out.extend(len(part).to_bytes(8,"big")); out.extend(part)
    return bytes(out)

def chunk_docs(docs:dict[str,bytes])->list[list[tuple[str,bytes]]]:
    chunks=[]; current=[]; size=0
    for path, raw in docs.items():
        if current and size+len(raw)>CHUNK_TARGET_SOURCE_BYTES:
            chunks.append(current); current=[]; size=0
        current.append((path,raw)); size += len(raw)
    if current: chunks.append(current)
    return chunks

def build(repo:Path)->dict[str,bytes]:
    docs=archive_docs(repo); contract=task001_records(repo)
    if set(docs)!=set(contract): fail("v1 archive paths do not exactly match TASK-001")
    for path, raw in docs.items():
        r=contract[path]
        if r.get("bytes") != len(raw) or r.get("sha256") != sha256(raw): fail(f"TASK-001 mismatch: {path}")
    if len(docs)!=351 or sum(map(len,docs.values()))!=743078: fail("unexpected v1 corpus cardinality")
    snapshot_digest=sha256(identity_bytes(docs))
    generation="v1-"+snapshot_digest[:24]
    outputs={}
    chunks=[]
    for index, entries in enumerate(chunk_docs(docs)):
        chunk={"documents":[{"bytes":len(raw),"content_base64":base64.b64encode(raw).decode("ascii"),"path":path,"sha256":sha256(raw)} for path,raw in entries],"generation":generation,"index":index,"schema_version":SCHEMA_VERSION}
        encoded=canonical(chunk); name=f"chunk-{index:03d}.json"; outputs[f"{PAYLOAD_DIR}/{name}"]=encoded
        chunks.append({"doc_count":len(entries),"file_bytes":len(encoded),"first_path":entries[0][0],"index":index,"last_path":entries[-1][0],"path":name,"sha256":sha256(encoded),"source_bytes":sum(len(raw) for _,raw in entries)})
    manifest={"baseline":{"commit":BASELINE_COMMIT,"ref":BASELINE_REF},"chunks":chunks,"corpus":{"bytes":743078,"documents":351,"sets":60,"songs":291},"generation":generation,"schema_version":SCHEMA_VERSION,"snapshot_digest":snapshot_digest}
    manifest_bytes=canonical(manifest); outputs[f"{PAYLOAD_DIR}/manifest.json"]=manifest_bytes
    assets = {}
    for name in ("index.html", "app.js", "sw.js"):
        raw = (repo / "migration/v2/bootstrap/harness" / name).read_bytes()
        assets[f"harness/{name}"] = {"bytes": len(raw), "sha256": sha256(raw)}
    baseline={"assets":assets,"baseline":{"commit":BASELINE_COMMIT,"ref":BASELINE_REF},"generation":generation,"generator":{"name":"scripts/build_v2_bootstrap_baseline.py","version":GENERATOR_VERSION},"payload":{"chunk_count":len(chunks),"manifest_path":"payload/manifest.json","manifest_sha256":sha256(manifest_bytes),"source_chunk_target_bytes":CHUNK_TARGET_SOURCE_BYTES,"snapshot_digest":snapshot_digest},"schema_version":SCHEMA_VERSION,"verification":{"documents":351,"source_bytes":743078,"output_sha256":None}}
    baseline["verification"]["output_sha256"]=sha256(canonical(baseline))
    outputs[str(BASELINE_PATH)]=canonical(baseline)
    return outputs

def main(argv:Iterable[str]|None=None)->int:
    p=argparse.ArgumentParser(description=__doc__); p.add_argument("--check",action="store_true"); args=p.parse_args(argv)
    repo=Path(__file__).resolve().parents[1]; expected=build(repo); changed=[]
    expected_chunks={Path(relative).name for relative in expected if relative.startswith(f"{PAYLOAD_DIR}/chunk-")}
    actual_chunks={path.name for path in (repo/PAYLOAD_DIR).glob("chunk-*.json") if path.is_file()}
    stale_chunks=sorted(actual_chunks-expected_chunks)
    for relative, data in expected.items():
        target=repo/relative
        if not target.is_file() or target.read_bytes()!=data: changed.append(target)
    changed.extend(repo/PAYLOAD_DIR/name for name in stale_chunks)
    if args.check:
        if changed:
            print("generated bootstrap artifacts differ:\n"+"\n".join(map(str,changed)),file=sys.stderr); return 1
        print("bootstrap payload: OK"); return 0
    for name in stale_chunks:
        target=repo/PAYLOAD_DIR/name
        target.unlink()
        print(f"removed {target}")
    for relative,data in expected.items():
        target=repo/relative
        target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists() or target.read_bytes()!=data: target.write_bytes(data); print(f"wrote {target}")
    return 0
if __name__=="__main__": raise SystemExit(main())
