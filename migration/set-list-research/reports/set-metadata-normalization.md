# Imported Set List metadata normalization

## Scope and method

This normalization applies only to the 59 imported `sets/*.md` files that carry a `draft_id`. It changes audited front matter, the H1 title, and the derived review note; ordered Set List items and all remaining body lines are hash-validated and preserved.

The decisions in [`set-metadata-decisions.json`](../set-metadata-decisions.json) are explicit per `draft_id`. User-confirmed aliases override source inconsistencies; evidence-based inferences remain marked `proposed`.

## Validation

- 59 decisions: 42 confirmed and 17 proposed.
- Dates are empty, `YYYY-MM`, or `YYYY-MM-DD`, with matching precision.
- Every line after the H1 is protected by a recorded SHA-256 hash.
- `python3 scripts/normalize_setlist_metadata.py --check` verifies a deterministic no-op.

## Decisions

| File | Title | Gig name | Date | Location | Band / review | Metadata review | Rationale |
|---|---|---|---|---|---|---|---|
| `2005-03-26-easter-pageant.md` | Easter Pageant | Easter Pageant | 2005-03-26 (day) | — | The Smileys (confirmed) | proposed | "Easter Pageant" describes the event, not a supported venue; retain the explicit source band. |
| `2006-01-25-wait-for-the-shake-set-list-2006-01-25.md` | Wait for the Shake | Wait for the Shake | 2006-01-25 (day) | — | Wait for the Shake (confirmed) | confirmed | Explicit source band; remove the embedded date and set-list wording from the title. |
| `2015-09-acoustic-at-hopmonk.md` | LC Acoustic | HopMonk Tavern | 2015-09 (month) | HopMonk Tavern | Loosely Covered (confirmed) | proposed | Normalize the acoustic Loosely Covered configuration; Hopmonk expansion is a proposed venue normalization. |
| `2016-05-prestwood.md` | Prestwood | Prestwood | 2016-05 (month) | Prestwood | Loosely Covered (confirmed) | confirmed | Keep the explicit source month, venue, and band. |
| `2016-07-08-stonetree.md` | Stonetree | Stonetree | 2016-07-08 (day) | Stonetree | Loosely Covered (confirmed) | confirmed | Keep explicit source metadata. |
| `2017-04-01-siff.md` | SIFF | SIFF | 2017-04-01 (day) | SIFF | Loosely Covered (confirmed) | confirmed | Keep explicit source metadata. |
| `2017-06-2017-06-jack-london.md` | Jack London | Jack London | 2017-06 (month) | Jack London Lodge | Loosely Covered (confirmed) | confirmed | Remove the embedded numeric date; user-confirmed Jack London location mapping. |
| `2017-06-2017-06-ty-caton.md` | Ty Caton | Ty Caton | 2017-06 (month) | Ty Caton Winery | Loosely Covered (confirmed) | confirmed | Remove the embedded numeric date; user-confirmed Ty Caton Winery mapping. |
| `2017-10-svsa.md` | SVSA | SVSA | 2017-10 (month) | SVSA | Loosely Covered (confirmed) | confirmed | Keep explicit source metadata. |
| `2017-11-02-20171102-nicholson.md` | Nicholson | Nicholson | 2017-11-02 (day) | Nicholson Ranch | Loosely Covered (confirmed) | confirmed | Remove numeric date prefix; user-confirmed Nicholson Ranch mapping. |
| `2017-11-10-20171110-hopmonk.md` | HopMonk Tavern | HopMonk Tavern | 2017-11-10 (day) | HopMonk Tavern | Loosely Covered (confirmed) | proposed | Remove numeric date prefix; Hopmonk expansion is proposed. |
| `2018-02-24-20180224-bv.md` | Buena Vista Winery | Buena Vista Winery | 2018-02-24 (day) | Buena Vista Winery | Loosely Covered (confirmed) | proposed | Remove numeric date prefix; BV expansion is proposed. |
| `2018-06-09-20180609-nicholson.md` | Nicholson | Nicholson | 2018-06-09 (day) | Nicholson Ranch | Loosely Covered (confirmed) | confirmed | Remove numeric date prefix; user-confirmed Nicholson Ranch mapping. |
| `2021-01-01-naz-pahtay.md` | Naz Pahtay | Naz Pahtay | 2021-01-01 (day) | — | — | confirmed | No supported band or location evidence; retain blanks. |
| `2021-04-03-taylor-s-birthday.md` | Taylor's Birthday | Taylor's Birthday | 2021-04-03 (day) | Castello Golightly | Loosely Covered (proposed) | proposed | User-directed Loosely Covered proposal based on duplicate/sequence evidence. |
| `2021-04-10-reel-and-brand-lc-acoustic.md` | LC Acoustic | Reel & Brand | 2021-04-10 (day) | Reel & Brand | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and user-confirmed Reel & Brand mapping. |
| `2021-05-15-murphy-s-lc-acoustic.md` | LC Acoustic | Murphy's | 2021-05-15 (day) | Murphy's | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and Murphy’s spelling. |
| `2021-06-19-murphy-s-lc-acoustic.md` | LC Acoustic | Murphy's | 2021-06-19 (day) | Murphy's | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and Murphy’s spelling. |
| `2021-07-10-mattmere-wedding-ff.md` | Funk Fatale | MattMere Wedding | 2021-07-10 (day) | Castello Golightly | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale. |
| `2021-08-05-berry-bros-guitar-notes.md` | Berry Brothers | Guitar Notes | 2021-08-05 (day) | Sonoma Plaza | Berry Brothers (confirmed) | confirmed | User-confirmed Berry Bros mapping. |
| `2021-08-05-city-party-ff.md` | Funk Fatale | City Party | 2021-08-05 (day) | Sonoma Plaza | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale. |
| `2021-08-07-banned.md` | Banned | Banned | 2021-08-07 (day) | Wölffer Estate | — | confirmed | No supported band evidence; retain blank band. |
| `2021-09-23-jack-london-lc-acoustic.md` | LC Acoustic | Jack London Lodge | 2021-09-23 (day) | Jack London Lodge | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and user-confirmed Jack London Lodge mapping. |
| `2021-10-02-ff-sarah-s-50th-candidate.md` | Funk Fatale | Sarah’s 50th (candidate) | 2021-10-02 (day) | Sonoma Plaza | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale. |
| `2021-10-02-oktoberfest-2021-lc-electric.md` | LC Electric | Oktoberfest 2021 | 2021-10-02 (day) | Sonoma Plaza | Loosely Covered (confirmed) | confirmed | Normalize LC electric configuration. |
| `2021-10-02-oktoberfest-ff.md` | Funk Fatale | Oktoberfest | 2021-10-02 (day) | Sonoma Plaza | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale. |
| `2021-10-02-sarah-50th-bday.md` | Sarah 50th Bday | Sarah 50th Bday | 2021-10-02 (day) | Sonoma Plaza | Loosely Covered (proposed) | proposed | User-directed Loosely Covered proposal based on duplicate/sequence evidence. |
| `2021-11-19-reel-brand-lc-acoustic.md` | LC Acoustic | Reel & Brand | 2021-11-19 (day) | Reel & Brand | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and user-confirmed Reel & Brand mapping. |
| `2021-12-31-nye-2021-sz-ideas.md` | Sleazzy Top | NYE 2021 Ideas | 2021-12-31 (day) | Castello Golightly | Sleazzy Top (confirmed) | confirmed | User-confirmed SZ mapping. |
| `2022-05-04-dg-et-lc-acoustic.md` | LC Acoustic | DG/ET | 2022-05-04 (day) | Murphy's | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and Murphy’s spelling. |
| `2022-06-16-jll-lc-acoustic-6-16.md` | LC Acoustic | Jack London Lodge | 2022-06-16 (day) | Jack London Lodge | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and user-confirmed Jack London Lodge mapping. |
| `2022-06-26-last-sunday-r-b-lc-electric-6-26.md` | LC Electric | Last Sunday (R&B) | 2022-06-26 (day) | Reel & Brand | Loosely Covered (confirmed) | confirmed | Normalize LC electric configuration and user-confirmed Reel & Brand mapping. |
| `2022-07-08-acoustic-90s-ish-list-for-ted.md` | Acoustic 90s-ish List (for Ted) | Acoustic 90s-ish List (for Ted) | 2022-07-08 (day) | Kenwood Residence (near Château St. Jean) | Loosely Covered (proposed) | proposed | User-directed Loosely Covered proposal based on duplicate/sequence evidence. |
| `2022-07-08-kenwood-party-lc-acoustic-7-8.md` | LC Acoustic | Kenwood Party | 2022-07-08 (day) | Kenwood Residence (near Château St. Jean) | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration. |
| `2022-07-09-ff-nicholson-pigs-n-pinot-7-9.md` | Funk Fatale | Nicholson Pigs n Pinot | 2022-07-09 (day) | Nicholson Ranch | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale; normalize Nicholson location. |
| `2022-08-04-sleazzy-tom.md` | Sleazzy Top | — | 2022-08-04 (day) | Sonoma Plaza | Sleazzy Top (confirmed) | confirmed | User-confirmed SleaZZy Tom mapping. |
| `2022-08-20-lc-acou-ellen-jr-s-party-8-20-22.md` | LC Acoustic | Ellen (JR)’s party | 2022-08-20 (day) | Ellen's House | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration. |
| `2022-08-27-ff-red-white-ball-8-27.md` | Funk Fatale | Red & White Ball | 2022-08-27 (day) | Sonoma Plaza | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale. |
| `2022-08-28-last-sunday-r-b-lc-electric-7-28.md` | LC Electric | Last Sunday (R&B) | 2022-08-28 (day) | Reel & Brand | Loosely Covered (confirmed) | confirmed | Retain 2022-08-28 despite the 7/28 title typo; normalize LC electric and Reel & Brand. |
| `2022-09-22-nye-22-print.md` | Funk Fatale | NYE 22 | 2022-12-31 (day) | Jack London Lodge | Funk Fatale (proposed) | proposed | NYE date, Funk Fatale repertoire inference, and Jack London Lodge are proposed from the counterpart. |
| `2022-09-25-last-sunday-r-b-lc-electric-set-up-inside.md` | LC Electric | Last Sunday (R&B) — Set up inside | 2022-09-25 (day) | Reel & Brand | Loosely Covered (confirmed) | confirmed | Normalize LC electric configuration and Reel & Brand. |
| `2022-10-01-ff-crooked-goat-campo-fina.md` | Funk Fatale | Crooked Goat & Campo Fina | 2022-10-01 (day) | Crooked Goat & Campo Fina | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale; location is explicit in title. |
| `2022-10-09-lc-elec-glen-ellen-fair.md` | LC Electric | Glen Ellen Fair | 2022-10-09 (day) | Downtown Glen Ellen | Loosely Covered (confirmed) | confirmed | Normalize LC electric configuration. |
| `2022-10-15-lca-annadel-estate-winery.md` | LC Acoustic | Annadel Estate Winery | 2022-10-15 (day) | Annadel Estate Winery | Loosely Covered (confirmed) | confirmed | Normalize LCA to LC Acoustic; user-confirmed Annadel location mapping. |
| `2022-12-20-gde-holiday-jam.md` | GDE Holiday Jam | GDE Holiday Jam | 2022-12-20 (day) | Castello Golightly | Various (proposed) | proposed | User-directed Various proposal because the source has mixed lineups. |
| `2022-12-31-nye-22.md` | Funk Fatale | NYE 22 | 2022-12-31 (day) | Jack London Lodge | Funk Fatale (proposed) | proposed | NYE date is user-confirmed; Funk Fatale repertoire inference and Jack London Lodge are proposed from print counterpart. |
| `2023-04-13-jll-lc-acoustic.md` | LC Acoustic | Jack London Lodge | 2023-04-13 (day) | Jack London Lodge | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and user-confirmed Jack London Lodge mapping. |
| `2023-06-10-lc-elec-nicholson.md` | LC Electric | Nicholson | 2023-06-10 (day) | Nicholson Ranch | Loosely Covered (confirmed) | confirmed | Normalize LC electric configuration and Nicholson Ranch. |
| `2023-07-01-lc-elec-raymond.md` | LC Electric | Raymond | 2023-07-01 (day) | — | Loosely Covered (confirmed) | proposed | Normalize LC electric configuration; source "Wedding" is not a supported venue, so leave location blank. |
| `2023-07-15-lc-elec-ellen-s-wedding.md` | LC Electric | Ellen’s Wedding | 2023-07-15 (day) | — | Loosely Covered (confirmed) | proposed | Normalize LC electric configuration; source "Wedding" is not a supported venue, so leave location blank. |
| `2023-08-24-lc-acou-murphys.md` | LC Acoustic | Murphy's | 2023-08-24 (day) | Murphy's | Loosely Covered (confirmed) | confirmed | Normalize LC acoustic configuration and Murphy’s spelling. |
| `2023-09-21-jll-lc-electric-6-27.md` | LC Electric | Jack London Lodge | 2023-06-27 (day) | Jack London Lodge | Loosely Covered (confirmed) | proposed | Title date overrides conflicting source property; 2023-06-27 is proposed. Normalize JLL location. |
| `2023-09-24-lc-acou-bv-xmas.md` | LC Acoustic | BV Xmas | 2023-09-24 (day) | Buena Vista Winery | Loosely Covered (confirmed) | proposed | Normalize LC acoustic configuration; BV expansion is proposed. |
| `2023-10-07-oktoberfest-10-7-2023.md` | Funk Fatale | Oktoberfest | 2023-10-07 (day) | Sonoma Plaza | Funk Fatale (proposed) | proposed | FF-like repertoire supports proposed Funk Fatale assignment; Sonoma Plaza is proposed from the recurring Oktoberfest venue evidence. |
| `2023-11-25-ff-vintage-space.md` | Funk Fatale | Vintage Space | 2023-11-25 (day) | Vintage Space | Funk Fatale (confirmed) | confirmed | Explicit FF abbreviation maps to Funk Fatale; location is explicit in title. |
| `2023-12-01-sf-12-13-25.md` | Funk Fatale | SF | 2025-12-13 (day) | — | Funk Fatale (proposed) | proposed | Title supplies proposed 2025-12-13 date; FF-like repertoire supports only a proposed band. |
| `2023-12-03-lc-acou-bv-party.md` | LC Acoustic | BV Party | 2023-12-03 (day) | Buena Vista Winery | Loosely Covered (confirmed) | proposed | Normalize LC acoustic configuration; BV expansion is proposed. |
| `2025-10-13-9tease-stripped.md` | 9Tease Stripped | — | 2026-08-05 (day) | Castello Golightly | 9Tease Stripped (confirmed) | confirmed | User-confirmed 9Tease Stripped mapping and 2026-08-05 performance date. |
| `undated-lc-acou-jll-9-22-22.md` | LC Acoustic | Jack London Lodge | 2022-09-22 (day) | Jack London Lodge | Loosely Covered (confirmed) | confirmed | Explicit user-confirmed mapping for this draft. |

## Key user-confirmed mappings

- `LC`, `LC Acou`, `LC Elec`, and `LCA` map to **Loosely Covered**.
- `JLL` and imported Jack London references normalize to **Jack London Lodge**.
- `Berry Bros` maps to **Berry Brothers**; `SleaZZy Tom`/`SZ` map to **Sleazzy Top**; `9Tease Stripped` is both title and band.
- `LC Acou: JLL - 9/22/22` is `LC Acoustic`, Loosely Covered, Jack London Lodge, dated `2022-09-22`.
- Explicit `FF` pages map to **Funk Fatale**; repertoire-based assignments remain proposed.
