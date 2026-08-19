# Preserved Set List research sources

Captured August 19, 2026, before an exe.dev VM image rebuild. These were
previously untracked working data under `raw/` and `work/`, which are
gitignored and therefore would not have survived the rebuild.

## Included here

- `github/` — exact copy of `raw/github`, the extracted per-gig Set List
  sources recovered from the application repository history.
- `icloud-extract/` — exact copy of `work/icloud-extract`, excluding the
  disposable Python `venv/`. Contains `songlist.doc`, `catdoc` output,
  `previews/`, `ocr-prompt.txt`, and `ocr-results.json`.

## Not included: the original iCloud archive

`raw/Band.zip` (27,957,887 bytes) is the untracked original archive and is
deliberately not committed.

```
sha256  fb389f053cdd55d0520f29193a8673680ace72b5d7b4b9b5db83f1b7dc6ab8be
```

Reports refer to this archive as `n.zip`. Retain the original outside this VM.
Every derived artifact needed to review the reconciliation is already committed
under `candidates/`, `manifests/`, and `reports/`, so the archive is required
only to re-run extraction from scratch.

## Rebuilding the environment

`work/icloud-extract/venv` is reproducible: create a virtualenv and install
`openpyxl`, `xlrd`, `PyMuPDF`, and `olefile`, per
`reports/icloud-setlist-extraction.md`.
