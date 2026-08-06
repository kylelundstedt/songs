# Loosely Covered Notion workspace — read-only audit

Audit run: 2026-08-06T17:38:19.973163+00:00

## Method and scope

- Used only the authenticated API proxy at `https://notion-songs.int.exe.xyz/v1`; no Notion write, archive, or delete endpoints were called.
- Exhaustively paginated `POST /search` at 100 results/page: **5 pages / 428 results**.
- Retrieved each discovered page to inspect complete page properties, retrieved each database schema, paginated each database query, and recursively fetched children for every discovered page and every nested block reporting `has_children`.
- Crawl processed **425 page records**, **2631 blocks**, and **425 block-child containers**. Text was analyzed only for length, block type, and generic arrangement-label occurrences; full page text was not retained in this report.
- The report deliberately does not reproduce lyrics or member contact details. The temporary analysis inventory redacted email, phone, URL, and body-rich property values and was not committed.

## Workspace hierarchy

- **block_id**: 38 pages
- **database_id**: 364 pages
- **page_id**: 22 pages
- **workspace**: 1 pages

Discovered databases:

- **Gigs** — 52 queried records; parent `page_id`; properties: `Date` (date), `Reference Versions` (rich_text), `Sound` (rich_text), `Participating` (relation), `Venue` (select), `Gig Name` (title).
- **Lead Sheets** — 293 queried records; parent `page_id`; properties: `Created` (created_time), `Tags` (multi_select), `Name` (title).
- **Members** — 18 queried records; parent `page_id`; properties: `Photo` (files), `Related to Gigs (Participating)` (relation), `Cell Phone` (phone_number), `Email` (email), `Property` (rich_text), `Name` (title).

## Songs / lead sheets

- The **Lead Sheets** database contains **293 pages**. Its schema is intentionally thin: title (`Name`), created time, and an empty-options `Tags` multi-select. Arrangement, keys, credits, provenance, status, and revision data reside (if anywhere) in page bodies rather than queryable fields.
- **14** non-database pages are structurally song-like by conservative block heuristics; this supports a hybrid workspace with a main Lead Sheets corpus plus hand-authored/legacy song pages.
- Content is primarily free-form blocks. The crawl found the following block-type mix across the workspace: `paragraph` 2262, `column_list` 309, `heading_3` 31, `child_page` 21, `bulleted_list_item` 3, `child_database` 3, `synced_block` 2.
- Arrangement cues were found as unstructured inline/page-body labels (e.g., intro, verse, chorus, bridge, solo, outro, repeat); their presence is useful for conversion heuristics, but their inconsistent use means migration needs review rather than deterministic parsing.
- The title corpus contains key/arrangement qualifiers in names (for example parenthetical keys and vocal/arrangement notes). Preserve original titles, but derive a separate normalized song identity plus one or more arrangement/version records.

### Duplicate / variant candidates

- **dreams** — 6 pages: `Dreams`
- **levitating** — 4 pages: `Levitating`; `Levitating (Am)`
- **sweetesttaboo** — 4 pages: `SweetestTaboo`; `SweetestTaboo (Am)`
- **777** — 3 pages: `777`; `777 (G)`
- **keep your hands to yourself** — 3 pages: `Keep your hands to yourself`
- **stayin alive** — 3 pages: `Stayin Alive`; `Stayin Alive (E)`; `Stayin' Alive`
- **you got the love** — 3 pages: `You got the love`
- **charlie theobald** — 2 pages: `@charlie theobald`; `Charlie Theobald`
- **dancing queen** — 2 pages: `Dancing Queen`; `Dancing queen `
- **good times** — 2 pages: `Good Times`; `Good times`
- **groove is in the heart** — 2 pages: `Groove is in the Heart`
- **hit me with your best shot** — 2 pages: `Hit Me with Your Best Shot`; `Hit me with your best shot`
- **i wanna dance with somebody** — 2 pages: `I Wanna Dance With Somebody`; `I Wanna Dance with Somebody`
- **listen to her heart** — 2 pages: `Listen to Her Heart (A)`; `Listen to Her Heart (A) `
- **magic man** — 2 pages: `Magic Man`; `Magic Man (G)`
- **murphy s lc acoustic** — 2 pages: `Murphy's - LC Acoustic`
- **september** — 2 pages: `September`
- **she talks to angels** — 2 pages: `She Talks to Angels (E)`
- **you oughta know** — 2 pages: `You Oughta Know`

## Set lists and gigs

- **Gigs** returned **52 records in the direct database query**. It stores `Gig Name`, `Date`, `Venue`, free-text `Sound`, free-text `Reference Versions`, and a relation to **Members** (`Participating`). A broader crawl produced one extra intermediate entry, so import code must deduplicate by page ID and validate against the direct query.
- The Gigs schema does **not** expose a relation to Lead Sheets or a first-class ordered set-list item model. Set-list order/links appear to be carried in page blocks; this makes cross-gig repertoire, order, and actual-played status difficult to query or migrate without parsing bodies.
- **Members** has 18 records and stores names, contact/photo fields, and the reciprocal gig relation. For the new app, membership/contact data should be out of scope or separately access-controlled.

Gig records (date/venue metadata when present):

- **9Tease Stripped** — date: `{'start': '2025-10-13', 'end': None, 'time_zone': None}`; venue: `Castello Golightly`; participating relation count: `{'count': 4}`; page blocks: 1.
- **LC Acou: BV Party** — date: `{'start': '2023-12-03', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 4}`; page blocks: 8.
- **SF: 12-13-25** — date: `{'start': '2023-12-01', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 0}`; page blocks: 51.
- **FF: Vintage Space** — date: `{'start': '2023-11-25', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 0}`; page blocks: 35.
- **Oktoberfest 10/7/2023** — date: `{'start': '2023-10-07', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 4}`; page blocks: 37.
- **LC Acou: BV xmas** — date: `{'start': '2023-09-24', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 3}`; page blocks: 5.
- **JLL - LC Electric 6/27** — date: `{'start': '2023-09-21', 'end': None, 'time_zone': None}`; venue: `Jack London Saloon`; participating relation count: `{'count': 5}`; page blocks: 1.
- **LC Acou: Murphys** — date: `{'start': '2023-08-24', 'end': None, 'time_zone': None}`; venue: `Murphy's`; participating relation count: `{'count': 0}`; page blocks: 1.
- **LC Elec:  Ellen’s Wedding** — date: `{'start': '2023-07-15', 'end': None, 'time_zone': None}`; venue: `Wedding`; participating relation count: `{'count': 6}`; page blocks: 1.
- **LC Elec:  Raymond** — date: `{'start': '2023-07-01', 'end': None, 'time_zone': None}`; venue: `Wedding`; participating relation count: `{'count': 6}`; page blocks: 2.
- **LC Elec:  Raymond - Start/Stop Notes** — date: `{'start': '2023-07-01', 'end': None, 'time_zone': None}`; venue: `Wedding`; participating relation count: `{'count': 6}`; page blocks: 3.
- **LC Elec:  Nicholson** — date: `{'start': '2023-06-10', 'end': None, 'time_zone': None}`; venue: `Nicholson Ranch`; participating relation count: `{'count': 7}`; page blocks: 2.
- **JLL - LC Acoustic** — date: `{'start': '2023-04-13', 'end': None, 'time_zone': None}`; venue: `Jack London Saloon`; participating relation count: `{'count': 6}`; page blocks: 1.
- **NYE 22** — date: `{'start': '2022-12-31', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 4}`; page blocks: 34.
- **GDE Holiday Jam** — date: `{'start': '2022-12-20', 'end': None, 'time_zone': None}`; venue: `Castello Golightly`; participating relation count: `{'count': 11}`; page blocks: 14.
- **LCA: Annadel Estate Winery** — date: `{'start': '2022-10-15', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 5}`; page blocks: 2.
- **LC Elec: Glen Ellen Fair** — date: `{'start': '2022-10-09', 'end': None, 'time_zone': None}`; venue: `Downtown Glen Ellen`; participating relation count: `{'count': 0}`; page blocks: 18.
- **FF: Crooked Goat & Campo Fina** — date: `{'start': '2022-10-01', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 6}`; page blocks: 2.
- **Last Sunday (R&B) - LC Electric - Set up inside** — date: `{'start': '2022-09-25T15:30:00.000-07:00', 'end': None, 'time_zone': None}`; venue: `Reel and Brand`; participating relation count: `{'count': 6}`; page blocks: 1.
- **NYE 22 print** — date: `{'start': '2022-09-22T17:30:00.000-07:00', 'end': None, 'time_zone': None}`; venue: `Jack London Saloon`; participating relation count: `{'count': 6}`; page blocks: 2.
- **Last Sunday (R&B) - LC Electric 7/28** — date: `{'start': '2022-08-28', 'end': None, 'time_zone': None}`; venue: `Reel and Brand`; participating relation count: `{'count': 6}`; page blocks: 1.
- **FF: Red & White Ball 8/27** — date: `{'start': '2022-08-27', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 6}`; page blocks: 2.
- **LC Acou: Ellen (JR)’s party - 8/20/22** — date: `{'start': '2022-08-20T12:30:00.000-07:00', 'end': '2022-08-20T18:30:00.000-07:00', 'time_zone': None}`; venue: `Ellen's House`; participating relation count: `{'count': 7}`; page blocks: 1.
- **SleaZZy Tom** — date: `{'start': '2022-08-04', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 7}`; page blocks: 23.
- **FF: Nicholson Pigs n Pinot 7/9** — date: `{'start': '2022-07-09', 'end': None, 'time_zone': None}`; venue: `Nicholson Ranch`; participating relation count: `{'count': 6}`; page blocks: 2.
- **Kenwood Party - LC Acoustic 7/8** — date: `{'start': '2022-07-08', 'end': None, 'time_zone': None}`; venue: `Kenwood Residence (Neat Chateau St Jean)`; participating relation count: `{'count': 7}`; page blocks: 1.
- **Acoustic 90s-ish List (for Ted)** — date: `{'start': '2022-07-08', 'end': None, 'time_zone': None}`; venue: `Kenwood Residence (Neat Chateau St Jean)`; participating relation count: `{'count': 7}`; page blocks: 1.
- **Last Sunday (R&B) - LC Electric 6/26** — date: `{'start': '2022-06-26', 'end': None, 'time_zone': None}`; venue: `Reel and Brand`; participating relation count: `{'count': 7}`; page blocks: 1.
- **JLL - LC Acoustic 6/16** — date: `{'start': '2022-06-16', 'end': None, 'time_zone': None}`; venue: `Jack London Saloon`; participating relation count: `{'count': 7}`; page blocks: 1.
- **DG/ET -  LC Acoustic** — date: `{'start': '2022-05-04', 'end': None, 'time_zone': None}`; venue: `Murphy's`; participating relation count: `{'count': 5}`; page blocks: 1.
- **LC** — date: `{'start': '2022-01-01', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 0}`; page blocks: 0.
- **NYE 2021 - SZ Ideas** — date: `{'start': '2021-12-31', 'end': None, 'time_zone': None}`; venue: `Castello Golightly`; participating relation count: `{'count': 6}`; page blocks: 18.
- **Reel & Brand - LC Acoustic** — date: `{'start': '2021-11-19T19:00:00.000-08:00', 'end': '2021-11-19T21:00:00.000-08:00', 'time_zone': None}`; venue: `Reel and Brand`; participating relation count: `{'count': 7}`; page blocks: 1.
- **Oktoberfest 2021 - LC Electric** — date: `{'start': '2021-10-02', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 7}`; page blocks: 53.
- **FF: Sarah’s 50th (candidate)** — date: `{'start': '2021-10-02', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 6}`; page blocks: 1.
- **Oktoberfest - FF** — date: `{'start': '2021-10-02', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 6}`; page blocks: 1.
- **Sarah 50th Bday** — date: `{'start': '2021-10-02', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 7}`; page blocks: 53.
- **Jack London - LC Acoustic** — date: `{'start': '2021-09-23', 'end': None, 'time_zone': None}`; venue: `Jack London Saloon`; participating relation count: `{'count': 5}`; page blocks: 1.
- **Banned** — date: `{'start': '2021-08-07', 'end': None, 'time_zone': None}`; venue: `Wölffer Estate`; participating relation count: `{'count': 1}`; page blocks: 37.
- **City Party - Berry Brothers** — date: `{'start': '2021-08-05', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 5}`; page blocks: 24.
- **City Party - FF** — date: `{'start': '2021-08-05', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 6}`; page blocks: 33.
- **Berry Bros Guitar Notes** — date: `{'start': '2021-08-05', 'end': None, 'time_zone': None}`; venue: `Sonoma Plaza`; participating relation count: `{'count': 5}`; page blocks: 32.
- **MattMere Wedding - FF** — date: `{'start': '2021-07-10', 'end': None, 'time_zone': None}`; venue: `Castello Golightly`; participating relation count: `{'count': 6}`; page blocks: 1.
- **Murphy's - LC Acoustic** — date: `{'start': '2021-06-19T19:00:00.000-07:00', 'end': '2021-06-19T21:00:00.000-07:00', 'time_zone': None}`; venue: `Murphy's`; participating relation count: `{'count': 7}`; page blocks: 1.
- **Murphy's - LC Acoustic** — date: `{'start': '2021-05-15', 'end': None, 'time_zone': None}`; venue: `Murphy's`; participating relation count: `{'count': 5}`; page blocks: 1.
- **Reel and Brand - LC Acoustic** — date: `{'start': '2021-04-10', 'end': None, 'time_zone': None}`; venue: `Reel and Brand`; participating relation count: `{'count': 6}`; page blocks: 1.
- **Taylor's Birthday** — date: `{'start': '2021-04-03', 'end': None, 'time_zone': None}`; venue: `Castello Golightly`; participating relation count: `{'count': 3}`; page blocks: 1.
- **Murphy's - LC** — date: `{'start': '2021-02-20', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 4}`; page blocks: 1.
- **Naz Pahtay** — date: `{'start': '2021-01-01', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 0}`; page blocks: 24.
- **** — date: `{'start': '2021-01-01', 'end': None, 'time_zone': None}`; venue: `None`; participating relation count: `{'count': 0}`; page blocks: 0.
- **** — date: `None`; venue: `None`; participating relation count: `{'count': 0}`; page blocks: 0.
- **** — date: `None`; venue: `None`; participating relation count: `{'count': 0}`; page blocks: 0.
- **LC Acou: JLL - 9/22/22** — date: `None`; venue: `Ellen's House`; participating relation count: `{'count': 7}`; page blocks: 1.

## Current / latest activity

Notion API timestamps in this authenticated workspace currently extend to **August 6, 2026** (the audit date). The most recently edited items returned by the paginated, descending search are:

- `2026-08-06T17:24:00.000Z` — **Sonoma Bands** (workspace)
- `2026-08-06T01:13:00.000Z` — **Just Like Heaven** (database_id)
- `2026-08-06T00:42:00.000Z` — **9Tease Stripped** (database_id)
- `2026-08-06T00:17:00.000Z` — **Higher** (database_id)
- `2026-06-07T04:41:00.000Z` — **Smooth Operator** (page_id)
- `2026-06-07T04:41:00.000Z` — **SF: 12-13-25** (database_id)
- `2026-06-07T03:59:00.000Z` — **Locked Out of Heaven (C)** (database_id)
- `2026-06-07T03:25:00.000Z` — **Fuck You (C)** (database_id)
- `2026-06-06T18:38:00.000Z` — **I Wanna Dance With Somebody** (page_id)
- `2026-05-08T03:43:00.000Z` — **Dancing queen ** (page_id)
- `2026-03-15T22:58:00.000Z` — **Californication (Am)** (database_id)
- `2026-01-21T02:29:00.000Z` — **I Melt With You add vox back** (database_id)

## Comparison to `set-lists-reference`

- The reference repository has **284 Markdown lead-sheet files** in `lead-sheet/` plus a master set-list CSV and a rendered gig PDF. Its file-per-song model is closer to the desired Markdown source of truth than Notion’s body-block model.
- Notion is more current operationally (recent edits through August 2026), but its use of free-form body blocks, thin Lead Sheets metadata, and gig bodies for sequence information creates a migration-normalization problem.
- The reference file corpus and Notion should be treated as complementary import sources. Match using normalized title + title qualifiers/key + content fingerprint/review queue; do not overwrite a source based solely on title.

## Migration implications for a Markdown songs app

1. Model `Song` (stable canonical id/title/artist metadata) separately from `LeadSheetVersion` (key, arrangement, vocal notes, source, updated date) to preserve Notion title variants without collapsing useful performance versions.
2. Use a readable single Markdown file per lead-sheet version with explicit front matter (canonical song id, display title, artist, key, capo, tempo, time signature, tags, status, source links, revision) and structured headings/cues (`Intro`, `Verse`, `Chorus`, `Bridge`, `Outro`).
3. Introduce `SetList` and ordered `SetListItem` documents rather than encoding order as page text. Each item should link a particular lead-sheet version and permit runtime reorder plus notes, transitions, and status.
4. Preserve Notion page/block IDs and source timestamps in import manifests. Import bodies losslessly to a quarantine/original source field or private archive, but export normalized Markdown only after review; keep copyrighted lyric handling within authorized/private user workflows.
5. Build a review queue for title collisions, unknown keys, pages with minimal/no body, body-only manual songs, and gig blocks whose song links/order cannot be unambiguously parsed.
6. Separate performer-facing rendering from authoring. The iPad single-page renderer should use semantic cues and controllable typography/contrast, not raw Notion block layouts; retain a print/PDF view only as an export.

## Gaps, quality risks, and API limitations

- API-visible `Tags` options are empty; the Lead Sheets database therefore contributes little taxonomy for filtering, discovery, or migration confidence.
- Page-body conventions are not enforced. Song structure appears as prose/labels rather than a schema; empty/minimal pages and multiple arrangements require human review.
- The search endpoint is comprehensive only for content shared with the integration. This audit cannot see unshared/private workspace content, comments, page history, UI-only views, or anything excluded by integration permissions.
- The legacy `2022-06-28` API database query endpoint worked through the proxy. The database payload also advertises data-source IDs, but this audit did not depend on the newer data-source query API because the legacy database endpoint supplied the entries; this should be revalidated before a production importer.
- Relation property values can be paginated/truncated by Notion in unusually large relations; this workspace did not require reading member identities for the audit. Files/media URLs are temporary/private and were counted, not downloaded.
- Notion `last_edited_time` represents page-level edits and does not provide a durable per-line/per-lyric diff. Treat it as an import synchronization hint, not conflict-free revision history.

## Deliverable

This document is the committed, human-readable audit. Temporary machine inventories used during analysis were intentionally not committed.
