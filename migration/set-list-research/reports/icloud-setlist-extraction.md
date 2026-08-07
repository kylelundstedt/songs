# iCloud explicit-set-list extraction

## Scope and method

- Input: `raw/Band.zip`; selection: all 16 manifest records where `type` is `explicit_set_list`.
- Output: `candidates/icloud-set-lists.json` (validated with `python3 -m json.tool`).
- Reusable extractor: `scripts/extract_icloud_setlists.py`; run it with `work/icloud-extract/venv/bin/python`.
- The extractor reads selected archive members only. It keeps gig/event metadata, song labels in observed order, set/group headings, singer values when present, and concise notes. It intentionally omits lyrics and lead-sheet bodies.
- Local parser environment: `work/icloud-extract/venv` (`openpyxl`, `xlrd`, `PyMuPDF`, `olefile`). Legacy Pages packages use `index.xml.gz`. Modern Pages/IWA packages were inspected for embedded PDF/text and preview assets; only targeted preview OCR results with readable song labels were retained.

## Results

| Disposition | Artifacts | Outcome |
|---|---:|---|
| Canonical gig | 7 | Extracted candidates: Hopmonk (2015-09), Prestwood (2016-05), Stonetree (2016-07-08), SIFF (2017-04-01), SVSA (2017-10), Smileys Easter Pageant (2005-03-26), Wait for the Shake (2006-01-25). |
| Duplicate representation | 2 | SIFF Pages is paired with canonical SIFF PDF; Smileys PDF duplicates the legacy Pages set list. |
| Excluded non-gig catalog | 4 | Two Loosely Covered master PDFs, Nicholson lead-sheet/catalog PDF, and Wait for the Shake spreadsheet capability/status catalog. |
| Unsupported | 3 | Two IWA Pages previews were not readable enough to transcribe reliably; one legacy DOC has been safely inspected as OLE but not guessed. |

## Important evidence / confidence

- **High:** spreadsheet cell order, PDF text, and legacy `index.xml.gz` XML. The SIFF PDF is the canonical member of its Pages/PDF pair.
- **Medium:** readable, targeted `preview.jpg` transcription for Hopmonk, Prestwood, and SVSA. Some labels visibly use shortened forms (for example `Folsom`, `Streets`, and `That’s/Shake/Lucky`) and are preserved rather than expanded.
- **None / unsupported:** `LC Set List - 2015-10 Halloween at Rossi's.pages`, `LC Set List - 2017-06 Nicholson.pages`, and `Song List - Ireland's 32.doc`. Their sources and hashes remain in JSON, with inspection evidence.

## Non-gig classification corrections

`Master Set List 2020-12.pdf` (284 pages), `Master-Set-List.pdf` (283 pages), and `Nicholson-Set-List.pdf` (46 pages) are catalogs/lead-sheet collections rather than ordered gig running orders. `Song List 2005-11-17.xls` is a Song/Artist/member/status/votes grid rather than a gig set list. They remain documented at artifact level but do not create gig candidates.

## Reproducibility

```bash
work/icloud-extract/venv/bin/python scripts/extract_icloud_setlists.py
python3 -m json.tool candidates/icloud-set-lists.json >/dev/null
```

No source archive members were modified and no commit was created.
