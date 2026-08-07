# GitHub set-list collection

## Scope and safeguards

Collected public repository metadata and only allowlisted files from `loosely-covered`: `_bookdown.yml`, `cover2.tex`, `index.Rmd`, and README variants. No repository was cloned; no history was traversed; and no lead-sheet body, credential, OAuth, secret, or workflow-secret content was accessed. Branch-tip SHAs were read using public `git ls-remote ... refs/heads/master` only.

## Results

- **Candidates:** 6
- **Quarantined repositories:** 2
- **Ordered song entries:** 185
- **Singer values recovered:** 140
- **Singer values null:** 45 (the two repositories without usable generated table rows)
- **Branch commit SHAs recovered:** 6 / 6

### loosely-covered/set_list_ty_caton_2017_06

- Branch commit: `b49889703b9c20b387fb30b91874f0e4a4e9cbeb`
- Gig title: `2017-06 Ty Caton`
- Likely date/location: `2017-06` / `Ty Caton` (medium confidence, derived from `book_filename`)
- Songs: 32; groups/sets: none encoded; singers populated: 0/32.
- Singer evidence: cover2.tex is absent or contains no generated Title/Singer/Group rows; singer values remain null.
- Conflicts:
  - `location/title`: book_filename corresponds to the repository/gig naming while index.Rmd title is reused/stale. Preferred: `Ty Caton`; conflicting: `Ty Caton Winery`.

### loosely-covered/set_list_jack_london_2017_06

- Branch commit: `d1dd110820e106c6f684320793275bc339f50b25`
- Gig title: `2017-06 Jack London`
- Likely date/location: `2017-06` / `Jack London` (medium confidence, derived from `book_filename`)
- Songs: 34; groups/sets: 1, 2, 3, 4, 5, 6, 7; singers populated: 34/34.
- Singer evidence: All 34 singer values and group numbers aligned positionally after exact normalized title matching against _bookdown.yml; raw cover2.tex singer strings preserved.

### loosely-covered/set_list_nicholson_ranch_2017_06

- Branch commit: `fa917c3208fa76d1113efe65096bfdc9bb8f7cd0`
- Gig title: `20171102 Nicholson`
- Likely date/location: `2017-11-02` / `Nicholson` (high confidence, derived from `book_filename`)
- Songs: 13; groups/sets: none encoded; singers populated: 0/13.
- Singer evidence: cover2.tex has 0 generated rows while _bookdown.yml has 13 songs; no singer/group alignment applied.
- Conflicts:
  - `location/title`: book_filename corresponds to the repository/gig naming while index.Rmd title is reused/stale. Preferred: `Nicholson`; conflicting: `Jack London`.
  - `date`: book_filename has a specific gig date/month and index.Rmd date is reused/stale. Preferred: `2017-11-02`; conflicting: `2017-06`.
  - `cover2_alignment`: row count differs, so positional alignment is unsafe. Preferred: `do not assign table singers/groups`; conflicting: `0 cover rows vs 13 ordered songs`.

### loosely-covered/set_list_hopmonk_2017_11

- Branch commit: `3e0c9454037f37d8068cfcfb47003caa1b7f3e24`
- Gig title: `20171110 Hopmonk`
- Likely date/location: `2017-11-10` / `Hopmonk` (high confidence, derived from `book_filename`)
- Songs: 32; groups/sets: 1, 2, 3, 4, 5, 6, 7; singers populated: 32/32.
- Singer evidence: All 32 singer values and group numbers aligned positionally after exact normalized title matching against _bookdown.yml; raw cover2.tex singer strings preserved.
- Conflicts:
  - `location/title`: book_filename corresponds to the repository/gig naming while index.Rmd title is reused/stale. Preferred: `Hopmonk`; conflicting: `Jack London`.
  - `date`: book_filename has a specific gig date/month and index.Rmd date is reused/stale. Preferred: `2017-11-10`; conflicting: `2017-06`.

### loosely-covered/set_list_bv_2018_02

- Branch commit: `915c30bb695cd80ed125d4656c481c02d934a60b`
- Gig title: `20180224 BV`
- Likely date/location: `2018-02-24` / `BV` (high confidence, derived from `book_filename`)
- Songs: 37; groups/sets: 1, 2, 3, 4, 5, 6, 7; singers populated: 37/37.
- Singer evidence: All 37 singer values and group numbers aligned positionally after exact normalized title matching against _bookdown.yml; raw cover2.tex singer strings preserved.
- Conflicts:
  - `location/title`: book_filename corresponds to the repository/gig naming while index.Rmd title is reused/stale. Preferred: `BV`; conflicting: `Jack London`.
  - `date`: book_filename has a specific gig date/month and index.Rmd date is reused/stale. Preferred: `2018-02-24`; conflicting: `2017-06`.
  - `ordered_songs`: the permitted _bookdown.yml lists are identical in order/grouping despite distinct gig filenames; possible copied/reused set list. Preferred: `preserve this repository as an independent gig candidate`; conflicting: `loosely-covered/set_list_nicholson_2018_06`.

### loosely-covered/set_list_nicholson_2018_06

- Branch commit: `a8c66e776803b09e37cbdc5269cf1cd2f0529c8b`
- Gig title: `20180609 Nicholson`
- Likely date/location: `2018-06-09` / `Nicholson` (high confidence, derived from `book_filename`)
- Songs: 37; groups/sets: 1, 2, 3, 4, 5, 6, 7; singers populated: 37/37.
- Singer evidence: All 37 singer values and group numbers aligned positionally after exact normalized title matching against _bookdown.yml; raw cover2.tex singer strings preserved.
- Conflicts:
  - `location/title`: book_filename corresponds to the repository/gig naming while index.Rmd title is reused/stale. Preferred: `Nicholson`; conflicting: `Jack London`.
  - `date`: book_filename has a specific gig date/month and index.Rmd date is reused/stale. Preferred: `2018-06-09`; conflicting: `2017-06`.
  - `ordered_songs`: the permitted _bookdown.yml lists are identical in order/grouping despite distinct gig filenames; possible copied/reused set list. Preferred: `preserve this repository as an independent gig candidate`; conflicting: `loosely-covered/set_list_bv_2018_02`.

## Quarantine

- `loosely-covered/set_list_ty_caton_2018_06` at `7fec26b2f7c246f792f1f4cfe14e618ed81fdafc`: _bookdown.yml declares book_filename "Master" and enumerates a master song catalog rather than a gig-specific set list.
- `loosely-covered/set-lists` at `6cfbda8e4d8a99e8fbe2762d7e4a5add89b5f659`: README describes the current master lead-sheet/catalog and Google Sheets workflow; no gig-specific ordered list was collected.

## Alignment method

For each usable `cover2.tex`, the generated `Title`/`Singer`/`Group` rows were parsed without altering singer strings (for example, `K/E` and `E/D/K`). Rows were applied only when their count equaled the `_bookdown.yml` song count and every row title matched its same-position filename after case/punctuation normalization. Four repositories met that strict test. `set_list_ty_caton_2017_06` has no `cover2.tex`; `set_list_nicholson_ranch_2017_06` has an empty/non-tabular `cover2.tex`, so their singers remain `null`.
