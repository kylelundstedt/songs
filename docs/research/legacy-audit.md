# Legacy migration audit: set-lists-reference

**Scope.** Read-only audit of current tracked content at commit `6cfbda8` (6cfbda8e4d8a99e8fbe2762d7e4a5add89b5f659); working tree was clean. The repository itself was not modified. This audit examined current tracked blobs only, not prior Git history.

## Executive inventory

| Measure | Count |
|---|---|
| Tracked files | 302 |
| Markdown lead sheets | 284 |
| Master manifest rows | 284 |
| Event manifests | 1 |
| Tracked PDFs | 1 |
| Lead sheets with H3 sections | 117 |
| Lead sheets with no sections | 167 |
| Lead sheets with explicit key evidence | 0 |
| Lead sheets with styled chord spans | 0 |
| Lead sheets with external links | 3 |
| Lead sheets with title/legacy-slug anomaly | 5 |
| Canonical slug collisions | 0 |
| Tracked plaintext credential configurations | 1 |

The audit generated a machine-readable inventory during analysis; this repository keeps the human-readable findings rather than committing source hashes and the complete per-file inventory.

## Lead-sheet format and conventions

All 284 sheets start with one H1 on line 1; no H2/H4+ headings were found. Heading totals: H1=284, H3=1256.
Only 2/284 end with the README-requested blank line; 262/284 have a final newline. All use LF line endings.

`###` is overloaded as a performance-section marker. There are 1256 H3 headings; 1206 carry informal timing/bar notation. Controlled category inference is deliberately heuristic: `chorus` 402, `verse` 329, `intro` 145, `prechorus` 85, `solo` 76, `break` 47, `bridge` 47, `vamp` 25, `other` 24, `breakdown` 21, `outro` 21, `guitar` 17, `drums` 12, `groove` 4, `riff` 1.

Most common raw H3 labels (verbatim, before normalization):

| Raw label | Occurrences |
|---|---|
| Chorus  8x | 167 |
| Verse  16x | 74 |
| Verse  8x | 57 |
| Chorus  16x | 54 |
| Intro  4x | 36 |
| Chorus  12x | 33 |
| Intro  8x | 32 |
| Break  4x | 24 |
| Verse 1  8x | 22 |
| Bridge  8x | 20 |
| Verse 2  16x | 19 |
| Pre chorus  8x | 18 |
| Verse 1  16x | 17 |
| Prechorus  8x | 17 |
| Verse 2  8x | 16 |
| Solo  8x | 13 |
| Pre chorus  4x | 11 |
| Guitar Solo  8x | 11 |
| Chorus | 10 |
| Pre-chorus  4x | 10 |
| Verse 3  16x | 10 |
| Verse | 9 |
| Chorus  10x | 9 |
| Break  2x | 9 |
| Guitar Vamp  4x | 8 |
| Guitar Solo  16x | 8 |
| Intro Vamp  4x | 8 |
| Verse 3  8x | 7 |
| Intro  16x | 7 |
| Intro Vamp  8x | 7 |

## Titles, filenames, and canonical IDs

The canonical-slug policy produces **0 collisions** and **0 duplicate exact titles** across 284 sheets. It is therefore safe to use `songs/<id>.md` with a hard collision check. 5 legacy stems differ from a loose punctuation/case-insensitive title slug; these require an explicit mapping rather than a rename-by-assumption.

| Legacy path | H1 title | Proposed ID |
|---|---|---|
| lead-sheet/Have-A-Drink-On-Me.md | Have A Drink On | have-a-drink-on |
| lead-sheet/Redemption-Song-Live.md | Redemption Song | redemption-song |
| lead-sheet/Rock-and-Roll-Ain-t-Noise-Pollution.md | Rock n Roll Ain t Noise Pollution | rock-n-roll-ain-t-noise-pollution |
| lead-sheet/Superstition-Single-Version.md | Superstition | superstition |
| lead-sheet/Thank-You-Falettinme-Be-Mice-Elf-Agin.md | Thank You Falettinme | thank-you-falettinme |

`{short="..."}` on the H1 is a legacy Pandoc presentation feature, not song identity; 25 sheets use it. Extract it to `short_title` and remove it from the H1 during canonicalization. The migration tool should preserve both raw and parsed H1 values in its generated review manifest.

## Links, keys, and chords

Only 3 sheets contain external URLs, all to `www.youtube.com`. One local Markdown link is broken: `README.md:61` → `./Rebel-Yell.md`.

No sheets have explicit `Key:` or key-heading evidence. Do not manufacture a song key from chord text. Seven sheets use italic spans for performance annotations, but none provide reliable structured chord or key data.

## Existing set-list mechanics

`Master-Set-List.csv` has 284 rows and covers all 284 lead-sheet paths exactly once: missing=0, extra=0, duplicates=0. Despite the extension, each row is a source filename plus an empty/whitespace second CSV field, so it is a generated import manifest, not a normalized song catalog. Its order is not case-fold sorted; it is produced by `ls ./lead-sheet/*.md`, so sort semantics are locale/shell dependent.

One tracked event manifest, `2021-02-20-Murphys.txt`, has 32 ordered source paths; all resolve and none are duplicated. Its companion PDF is tracked. The workflow’s `for f in *.txt; ... -o ${f}.pdf` instead generates `*.txt.pdf`, which does not match the tracked companion naming.

`set-lists.R` reads a Google Drive spreadsheet, excludes exactly three sheet names, reads only column A, turns its values into `./lead-sheet/<Song>.md`, writes one root-level `.txt` per remaining sheet, and never deletes stale manifests. Singer data described in the README is not represented in the generated manifest. It does not validate sheet names or song/path values before writing. Pandoc then treats the manifest paths as input documents. `_header.sty` hard-codes `2021-02-20 Murphys`, so other event PDFs can be mislabeled.

## Security / unsafe tracked content

Current-blob review found a tracked `.vscode/settings.json` entry containing a plaintext Snowflake username/password and related connection details. Values are intentionally suppressed. Treat that credential as compromised: rotate or revoke it, remove the file from current content, and purge it from Git history as a separate security task. The workflow also contains an explicit secret-to-log step.

| Path | Finding | Line | Why it matters |
|---|---|---|---|
| .vscode/settings.json | plaintext_database_credential | — | Contains a tracked Snowflake username/password and connection configuration. Rotate/revoke immediately; remove it from current content and Git history. |
| .github/workflows/pandoc.yml | secret_exposure_to_logs | 57 | Workflow explicitly writes a credential environment variable to job output. |
| .github/workflows/pandoc.yml | mutable_or_legacy_action_tags | — | Third-party/GitHub Actions are referenced by mutable major-version tags (v1/v2/v7), not commit SHAs. |
| .github/workflows/pandoc.yml | unverified_binary_download | — | Downloads and installs a Pandoc .deb without a checksum/signature verification step. |
| .github/workflows/pandoc.yml | credential_path_contract_is_implicit | — | Workflow places a secret string in GOOGLE_KEY; set-lists.R passes that string as a filesystem path to drive_auth without writing a credential file. |
| .github/workflows/pandoc.yml | generated_artifacts_committed_by_ci | — | Workflow force-commits CSV, TXT, and PDF outputs, mixing generated releases with source and making reproducibility/history cleanup harder. |
| _header.sty | stale_hard_coded_event_header | — | Rendered header hard-codes one 2021 event/date, so output for other manifests is mislabeled. |
| Master-Set-List.csv | generated_manifest_misnamed_as_csv | — | Rows are path manifests plus an empty second CSV field, not normalized song metadata. |

Priority remediation: remove the credential-echo step immediately; rotate any credential that may have reached CI logs; use least-privilege credentials; pin Actions by commit SHA; verify downloaded artifacts; and move generated PDFs/manifests to release artifacts or an explicitly managed generated-content policy. `.gitignore` covers common R/OAuth local files, but no history scan was performed.

## Deterministic migration transform

1. Freeze the source commit and generate a per-file SHA-256 mapping as the migration input contract.
2. Parse each H1; strip only a terminal `{short="..."}` attribute into `short_title`; derive `id` with the policy below; fail on duplicate ID.
3. Preserve lyric lines byte-for-byte in content (except LF normalization); extract absolute links in encounter order; only promote explicit key labels.
4. Map H3 performance labels to a controlled section type where safe. Retain raw heading, bar notation, and styled chord notation as `legacy` data whenever a parser would be lossy. Never infer chords/keys from ordinary lyric text.
5. Emit canonical song files deterministically sorted by ID; regenerate master and event manifests from IDs, validate all references, and render only after validation.

### Canonical Markdown schema (v1)

```markdown
---
schema_version: 1
id: rebel-yell
title: Rebel Yell
short_title: null
legacy:
  path: lead-sheet/Rebel-Yell.md
  sha256: <64-hex-source-digest>
performance:
  key: null              # set only from explicit evidence or reviewed editorial data
links: []
---

# Rebel Yell

## intro

Lyrics / performance notes retained here.
```

Use `songs/<id>.md`. `id` is Unicode NFKD ASCII-folded title text; apostrophes are removed, `&` becomes `and`, remaining non-alphanumeric runs become one hyphen, and edge hyphens are stripped. Example: “Let’s Dance” → `lets-dance`. Migration tooling must emit the complete proposed mapping for review before renaming files.

### Validation gate

1. UTF-8, LF, final newline; no tab-based layout requirement.
2. YAML front matter validates against schema_version 1; id matches ^[a-z0-9]+(?:-[a-z0-9]+)*$ and filename is id.md.
3. id and normalized title are globally unique; legacy.source path and SHA-256 are retained during migration.
4. Exactly one H1 and it equals front-matter title; no additional H1.
5. Only H2 section headings after H1; section type must be controlled or declared `custom` with legacy_label.
6. performance.key is null or matches ^[A-G](?:#|b)?(?:maj|min|m)?$; never infer it from a chord progression.
7. Chord tokens, if structured, match documented chord grammar; unparseable notation remains a review item rather than silently rewritten.
8. links are absolute https URLs, exact-deduplicated, and optionally checked for reachability separately; no bare local paths in song content.
9. Set-list manifests contain canonical IDs (one per line), no duplicate IDs, all IDs resolve, and event IDs match ^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$.
10. CI rejects secret-pattern matches, workflow secret echoing, generated PDFs, and generated manifests unless explicitly produced in a release artifact.

## Migration decisions needing human review

- **167 unsectioned sheets**: retain as a single implicit `body` section or add reviewed labels; do not invent structure.
- **0 explicit keys vs. 284 missing/ambiguous keys**: keep `null` until an editor verifies the performance key.
- **5 title/filename anomalies**: use the emitted mapping; do not derive event references from visual title alone.
- **24 unrecognized H3 labels**: preserve as `custom`/legacy labels until controlled vocabulary review.
- Determine whether external video links are required metadata, optional references, or should be removed; the existing corpus has very sparse coverage.
- Replace external Google Sheets as the set-list system of record only after importing its full catalog; this repository contains only one materialized event manifest.
