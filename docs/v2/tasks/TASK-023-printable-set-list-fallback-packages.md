# TASK-023: Printable Set List Fallback Packages

- **Priority:** P2 — deferred until TASK-017–022 complete
- **Phase:** Deferred post-writable capability
- **Status:** Deferred (August 13, 2026)
- **Dependencies:** TASK-021 writable acceptance and TASK-022 web design overhaul

## Objective

Allow an owner to produce a deterministic print or PDF fallback package for one
Set List and its associated lead sheets without adding browser content mutation,
provider sync, publication, or default-route changes.

## Proposed scope

- select one existing reviewed Set List;
- preserve Set Entry order, duplicates, sections, performance notes, singer/key/BPM
  metadata, and immutable source identities;
- include each associated authoritative lead sheet exactly once per occurrence or
  according to an explicit reviewed de-duplication option;
- include unresolved/missing-entry failures, landscape/fit warnings, generation,
  source commit, and package timestamp;
- provide print CSS for US Letter and an owner-approved additional paper size;
- support browser Print → PDF and paper output while fully offline after bootstrap;
- produce deterministic package metadata/checksums for the selected snapshot.

## Excluded

- editing Set Lists or lead sheets;
- silently rewriting content to improve print fit;
- emailing, cloud upload, Google Drive, or print-provider integration;
- replacing V1 or the physical acceptance fallback requirement before this feature
  is itself reviewed.

## Acceptance criteria

- printed order and occurrence count match the selected Set List exactly;
- all pages identify the Set List and page position, and no required content is
  silently clipped;
- warning songs remain explicitly warned/scroll-safe in the app and are clearly
  marked in print output;
- repeated export from the same snapshot/options produces equivalent document
  content and deterministic package metadata;
- output works from the installed iPad web app and desktop browsers;
- no mutation, sync, provider, publication, or permission path is introduced.
