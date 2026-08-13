# TASK-024: Spreadsheet Set List Exports

- **Priority:** P3 — deferred until TASK-017–022 complete
- **Phase:** Deferred post-writable capability
- **Status:** Deferred (August 13, 2026)
- **Dependencies:** TASK-021 writable acceptance and TASK-022 web design overhaul

## Objective

Export one reviewed Set List and its ordered entries into portable spreadsheet
files without enabling browser edits, provider synchronization, or publication.

## Proposed scope

- download UTF-8 CSV and native XLSX;
- preserve Set List title/date/location/band fields, section order, stable Set
  Entry identity, occurrence number, song title/slug, key, BPM, singer, notes,
  provider/source identity, and resolution status;
- provide a human-readable worksheet and a machine-oriented normalized worksheet;
- include snapshot generation, manifest SHA, source commit, exported-at time, and
  schema version;
- protect against spreadsheet formula injection in user/content-derived cells;
- generate locally from the active verified snapshot and work offline;
- document explicit import into Excel and Google Sheets.

## Google Sheets boundary

The initial Google Sheets path is **download then explicit user import**. Direct
Google Drive/Sheets creation would require separate OAuth authorization,
least-privilege scope review, revocation/error handling, privacy documentation,
and its own acceptance package. It must not be disguised as background provider
sync or become a dependency of offline operation.

## Excluded

- importing spreadsheet changes back into V2;
- editing canonical content;
- automatic cloud upload or synchronization;
- provider credentials embedded in the client;
- changing V1/default routes or granting writable approval.

## Acceptance criteria

- CSV and XLSX preserve exact Set Entry order, duplicates, sections, and stable
  identities;
- Excel and Google Sheets open the reviewed fixtures without formula execution,
  mojibake, dropped leading characters, or type corruption;
- repeated export of the same snapshot/options produces equivalent cell content
  and deterministic package metadata;
- unresolved entries and warnings remain explicit;
- export works offline after bootstrap and introduces no mutation/publication path.
