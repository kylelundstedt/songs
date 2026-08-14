#!/usr/bin/env python3
import argparse, pathlib, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
TARGET=ROOT/'migration/v2/writable-set-lists/writable-set-list-evidence.json'
p=argparse.ArgumentParser(); p.add_argument('--check',action='store_true'); a=p.parse_args()
out=subprocess.check_output(['node','--import','tsx','packages/web/scripts/writable-evidence.ts'],cwd=ROOT/'v2')
if a.check:
    if not TARGET.exists() or TARGET.read_bytes()!=out:
        print(f'{TARGET}: stale',file=sys.stderr); sys.exit(1)
else:
    TARGET.write_bytes(out)
