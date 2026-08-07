# iCloud Band archive inventory

## Scope and method

- Source: `raw/Band.zip`; archive integrity test passed.
- Inventory scope: 175 logical artifacts under `Band/`.
- Ignored 126 archive entries that were `__MACOSX`, `.DS_Store`, or AppleDouble (`._*`) metadata. Directory placeholders were not counted as artifacts.
- A directory-form `.pages` document is represented by **one** JSONL record (30 such logical Pages packages). Its `size_bytes` is the sum of its non-metadata member bytes; its SHA-256 is a deterministic digest of each package-relative member name plus bytes. Regular files, including ZIP-form `.pages` documents, are hashed from their file bytes.
- `filename_hints` is deliberately filename-derived only (for example, `dated`, `venue_or_event`, `revision`, `lead_sheets`, `set_list`, and `master`). It is not a claim about document contents.

The machine-readable, one-record-per-artifact inventory is `manifests/icloud-artifacts.jsonl`. Every record includes `band`, archive-relative `path`, logical `type`, `format`, `size_bytes`, `sha256`, filename hints, timestamp, package-member count, and any matched `paired_representations`.

## Classification totals

| Type | Count |
|---|---:|
| `explicit_set_list` | 16 |
| `gig_lead_sheet_bundle` | 70 |
| `master_lead_sheet_collection` | 3 |
| `individual_song_lead_sheet` | 77 |
| `audio` | 1 |
| `unknown` | 8 |
| **Total** | **175** |

### By band

| Band | Artifacts |
|---|---:|
| Isabel's Basement | 24 |
| Loosely Covered | 36 |
| One Flap Down | 6 |
| The Smileys | 79 |
| Wait for the Shake | 30 |

## Paired representations

Five filename-normalized Pages/PDF pairs were found (10 records with a counterpart):

1. `Band/Loosely Covered/LC Lead Sheets - 2016-10-29 Rossi updated.pages` ↔ `.pdf`
2. `Band/Loosely Covered/LC Lead Sheets - 2016-12-31 New Years Eve.pages` ↔ `.pdf`
3. `Band/Loosely Covered/LC Lead Sheets - 2017-04-01 SIFF.pages` ↔ `.pdf`
4. `Band/Loosely Covered/LC Lead Sheets - 2017-05-23.pages` ↔ `.pdf`
5. `Band/Loosely Covered/LC Set List - 2017-04-01 SIFF.pages` ↔ `.pdf`

The paths for each counterpart are recorded in the manifest rather than inferred at use time. Matching is filename-normalized and does **not** establish that paired files have identical content.

## Representative extraction-feasibility probes

No full lyrics or document text was retained in this report.

| Representative | Result | Feasibility |
|---|---|---|
| Directory Pages package: `Isabel's Basement/Lead Sheets 2009-01 La Barca.pages/` | 4 members: `index.xml.gz`, QuickLook preview PDF/JPEG, and package metadata | Feasible to unpack. Legacy Pages XML is gzip-compressed; preview assets are directly usable for review. |
| ZIP-form Pages: `Loosely Covered/LC Lead Sheets - 2017-04-01 SIFF.pages` | ZIP integrity test passed; 13 members including `Index/*.iwa`, metadata plists, and JPEG previews | Feasible to unpack and use previews; structured IWA extraction requires an Apple-iWork-aware parser/converter. |
| PDF: paired `LC Lead Sheets - 2017-04-01 SIFF.pdf` | Recognized as PDF 1.3 with 8 pages by local file identification | Direct page/render extraction is feasible; text-extraction utilities were not installed for this probe. |
| Word `.doc`: `The Smileys/One Headlight.doc` | Recognized as a legacy Microsoft Word compound document | Feasible with a legacy-Office converter/parser; no converter was installed locally. |
| Excel `.xls`: `Wait for the Shake/Song List 2005-11-17.xls` | Recognized as a legacy Microsoft Excel compound document | Feasible with an XLS parser/converter; no converter was installed locally. |
| MP3: `The Smileys/Birthday.mp3` | `ffprobe` identified MP3 audio, 162.882 seconds, 2,610,200 bytes | Directly usable; metadata/audio decoding is feasible. |

## Notes on `unknown`

Eight artifacts remain `unknown` because their filenames do not reliably indicate one of the requested classes: two Isabel's Basement `Track Sheet` Pages files; two date/initial-only Loosely Covered PDFs; three Loosely Covered Acoustic-at-Hopmonk Pages revisions; and one Smileys `.3gp` video clip. Their manifest records still preserve type/format, hashes, size, and filename hints where available.
