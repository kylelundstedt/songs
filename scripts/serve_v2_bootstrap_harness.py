#!/usr/bin/env python3
"""Serve the disposable bootstrap harness on loopback and collect observations."""
from __future__ import annotations
import argparse, json, mimetypes, re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
PROFILE=re.compile(r"^(ipad-portrait|ipad-landscape|phone)$")
class Handler(SimpleHTTPRequestHandler):
    root: Path; output: Path
    def translate_path(self,path:str)->str:
        parts=[p for p in Path(urlparse(path).path).parts if p not in ('/','.','..')]
        return str(self.root.joinpath(*parts))
    def end_headers(self):
        if '/payload/' in self.path: self.send_header('Cache-Control','no-store')
        else: self.send_header('Cache-Control','no-cache')
        super().end_headers()
    def do_POST(self):
        match=re.fullmatch(r"/__observations/(ipad-portrait|ipad-landscape|phone)\.json",urlparse(self.path).path)
        if not match: self.send_error(404);return
        try:
            n=int(self.headers.get('Content-Length','-1'))
            if n<0 or n>5_000_000: raise ValueError('invalid Content-Length')
            raw=self.rfile.read(n); value=json.loads(raw.decode('utf-8'))
            if not isinstance(value,dict): raise ValueError('observation must be an object')
        except (ValueError,json.JSONDecodeError,UnicodeDecodeError) as exc: self.send_error(400,str(exc));return
        target=self.output/f'{match.group(1)}.json';target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        response=json.dumps({'stored':target.name},separators=(',',':')).encode();self.send_response(201);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(response)));self.end_headers();self.wfile.write(response)
    def log_message(self,fmt,*args): print('%s - %s'%(self.address_string(),fmt%args))
def main()->int:
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8765);p.add_argument('--root-dir',type=Path);p.add_argument('--output-dir',type=Path,required=True);a=p.parse_args()
    default_root=Path(__file__).resolve().parents[1]/'migration/v2/bootstrap'; Handler.root=(a.root_dir or default_root).resolve();Handler.output=a.output_dir.resolve()
    mimetypes.add_type('application/javascript','.js'); server=ThreadingHTTPServer(('127.0.0.1',a.port),Handler)
    print(f'http://127.0.0.1:{a.port}/harness/?profile=ipad-portrait');server.serve_forever();return 0
if __name__=='__main__':raise SystemExit(main())
