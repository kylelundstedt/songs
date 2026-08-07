# Set List Drafts — Product and Implementation Memory

Updated: August 7, 2026

## Core decision

Creation, cloning, and importing are not separate Set List systems. They are three ways to initialize the same structured `SetListDraft`, after which one shared editor, validator, publisher, and Git-backed persistence path is used.

External importers must produce drafts or import candidates. They must not write canonical Set List Markdown directly.

## Draft model

A draft contains:

- draft identity and revision;
- optional Band name;
- Gig name/title;
- date;
- optional location;
- ordered sections such as Set 1, Set 2, and Encore;
- ordered Set List items;
- validation issues;
- optional creation provenance;
- local autosave state.

Each item has its own stable item identity, separate from Song identity, so the same Song can appear more than once if explicitly intended. An item contains:

- stable draft item ID;
- canonical Song reference when resolved;
- display label;
- optional singer;
- optional gig-specific note;
- section membership and position;
- for imported items only: raw source title, proposed match, confidence, evidence, and resolution status.

## Three initialization paths

### Create blank

Create an empty draft and open the shared editor. Band is optional free text, Gig name and date are required for publication, and location is optional.

### Clone existing

Create a new draft without modifying the source Set List. Defaults:

- copy Songs and order;
- copy Set breaks/sections;
- copy singer assignments;
- do not copy gig-specific notes unless selected;
- request new Gig name, date, and location;
- assign a new canonical ID and path at publication;
- record `cloned_from` provenance.

Cloning copies references to canonical Songs, not the Song lead sheets themselves.

### Import external material

A source adapter extracts an import candidate containing metadata, sections, raw song titles, singers, notes, source hashes, confidence, and evidence. The candidate is converted into the same draft model and opened in the same editor.

Import-only capabilities are:

- source-format extraction;
- title normalization and Song matching;
- confidence and evidence display;
- duplicate-gig detection;
- unresolved and ambiguous item review;
- source provenance.

Unresolved imported items may exist in a draft but block canonical publication until resolved or explicitly removed.

## Shared editor

All initialization paths use one editor that supports:

- metadata editing;
- Song search and selection;
- adding and deleting items;
- drag, pointer, touch, and keyboard reordering;
- adding, renaming, removing, and reordering Set sections;
- moving items between sections;
- singer and note editing;
- duplicate warnings and explicit repeated-Song handling;
- validation status;
- preview and live-mode readiness;
- local draft autosave;
- explicit publication.

The Set Lists page should expose:

- **New Set List**;
- **Import Set List**;
- **Clone** on each existing Set List.

## Persistence and publication

Drafts are structured working state, preferably autosaved locally so network failure does not lose edits. They are not canonical Git content.

Explicit publication:

1. validates required metadata;
2. requires every retained item to resolve to a canonical Song;
3. validates item identities, ordering, sections, links, and allowed repeats;
4. generates one canonical Markdown file;
5. validates and renders it with the application toolchain;
6. writes atomically;
7. creates a clear Git commit;
8. rebuilds the application index.

A newly published clone or imported Set List must never overwrite its source.

## Canonical Set List metadata

The intended metadata includes:

- schema version;
- canonical ID;
- Band;
- Gig name/title;
- date;
- location;
- status;
- optional `cloned_from`;
- optional import source type, reference, and hash.

Section headings in Markdown preserve Set breaks. Items link to canonical Song files and retain per-gig singer and notes.

## Source collection relationship

The separate source-collection process may gather Set Lists, gig-specific lead-sheet bundles, master lead-sheet collections, and individual lead sheets. It produces inventories and candidates only.

- Explicit Set Lists become Set List candidates.
- Gig-specific lead-sheet bundles may provide lower-confidence order evidence.
- Master lead-sheet collections are repertoire evidence, not gigs.
- Individual lead sheets are matched as historical Song-source evidence; they never overwrite canonical Songs.
- Unmatched lead sheets become separate Song candidates for later review.

No collected source becomes canonical merely because extraction or matching succeeded.

## Implementation order

1. Define the shared structured draft model and invariants.
2. Build the shared Set List editor.
3. Implement cloning to exercise the complete editing workflow.
4. Add blank creation.
5. Make all import adapters produce drafts/import candidates.
6. Add cross-source reconciliation, duplicate detection, and historical import review.

## Non-negotiable invariants

- One shared editor and publication path.
- Importers never bypass human review.
- Canonical Song links are authoritative.
- External source text and LLM output are evidence, not facts.
- Raw private documents remain outside the application Git repository.
- Source provenance is retained.
- Existing Set Lists and Songs are never silently overwritten.
