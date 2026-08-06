# Implementation Proposal: Songs

## 1. Executive decision

Build a small, private, Git-backed PWA for cover-band vocalists. The application should be intentionally narrow:

- Git-backed Markdown is the durable source of truth.
- Each song has one lead-sheet page.
- Each gig has one set-list page.
- A small Go server provides authenticated reads, writes, rendering, indexing, and synchronization.
- SQLite is only a rebuildable index, render cache, and offline-operation queue.
- Git commits are created server-side.
- Apex Markdown Processor 1.1.14 is the only Markdown renderer.
- The browser uses vanilla JavaScript, standard CSS, IndexedDB, Cache Storage, and a service worker.
- The primary device is a 12–13 inch iPad Pro on a music stand.
- Live mode must work offline and must never clip a lead sheet.

The product is not a general-purpose music notation system, lyrics search engine, or database-backed CMS. The UI is a safe editing and viewing layer over Markdown files.

The first implementation should prioritize read-only rendering, offline gig mode, and viewport fitting before adding editing and automated song import. Those capabilities establish whether the most important product promise—readable live performance pages—works against the existing corpus.

The repository `kylelundstedt/songs` currently contains planning material only. This proposal is a build plan, not a claim that the application has been implemented.

## 2. What was reviewed

### Notion workspace

The read-only Notion audit used the authenticated API proxy and made no writes, archives, or deletes.

Findings:

- 428 search results were returned across five pages.
- 425 page records, 9,579 recursively discovered blocks, and 1,386 child containers were processed.
- The workspace contains 364 database-backed pages, 38 block-parent pages, 22 page-parent pages, and one workspace page.
- The Lead Sheets database contains 293 records.
- Forty-four additional non-database pages were structurally song-like, although many are nested copies inside gig pages rather than canonical songs.
- The Gigs database direct query returns **52 operational records**. Full page traversal also found one blank orphan record under the database; migration tooling must deduplicate by Notion page ID and quarantine blank/orphan records.
- The Members database contains 18 records and includes contact fields. Member contact information is explicitly out of scope.
- Notion’s Lead Sheets schema is thin: title, created time, and tags. Arrangement, key, credits, provenance, and revision details are generally in free-form page bodies.
- The bodies are visually consistent but presentation-oriented: 283 of 293 lead sheets use section headings, 288 include recognizable arrangement labels, and 274 use Notion column layouts.
- Duplicate or variant candidates include multiple versions of songs such as “Dreams,” “Levitating,” “Stayin Alive,” and “September.” One lead-sheet page is empty and eight contain fewer than 500 analyzed text characters.
- Recent Notion activity extends through the audit date, August 6, 2026, making Notion generally more current operationally.

The Notion API can only see content shared with the integration. It cannot establish a complete workspace inventory if pages or databases are unshared, private, excluded by permissions, or otherwise unavailable to the integration. The migration must therefore include an explicit export/review step rather than assume the API crawl is complete.

### Legacy GitHub repository

The legacy repository audit found:

- 302 tracked files.
- 284 Markdown lead sheets.
- A 284-row master manifest.
- One event manifest.
- One tracked PDF.
- 117 lead sheets with H3 sections.
- 167 lead sheets with no sections.
- Zero sheets with explicit key evidence.
- Seven sheets contain italicized performance annotations, but none provide reliable structured key or chord metadata.
- Three sheets with external links.
- Five title/legacy-slug anomalies.
- Zero canonical slug collisions.
- One tracked VS Code settings file contains a plaintext Snowflake connection password and related connection details. The credential must be rotated/revoked, then removed from current content and Git history without printing it.

A conservative normalized-title comparison found 251 matches between Notion and the legacy corpus, plus 42 Notion-only titles and 33 legacy-only filenames. The legacy corpus is useful because it already approximates a file-per-song Markdown model. Its Markdown is human-oriented and inconsistent, so migration should preserve content and add structure gradually.

The master CSV is not a true song catalog. It lists source paths and an empty second field. Existing event text files provide ordered song paths, but they are not normalized set-list documents.

The old CI workflow has security and maintenance problems, including credential exposure to logs, mutable action references, unverified binary downloads, and generated artifacts committed automatically. The new application should not reuse that workflow design.

### Apex and iPad constraints

Apex Markdown Processor 1.1.14 was selected as the fixed rendering dependency. It supports standalone HTML, CSS, metadata, front matter, and accessibility-oriented output. The application must pin this exact version, disable unnecessary plugins, and test its output with representative files.

The display target is a 12–13 inch iPad Pro in portrait and landscape, under both dark stage lighting and bright outdoor conditions. The live layout must fit the complete lead sheet in one viewport. Scrolling within a song is not an acceptable fallback.

## 3. Product workflows

### Browse and read a song

The home page shows a fast searchable catalog. Search covers:

- title;
- aliases;
- artist;
- singer;
- key;
- tags;
- normalized filename;
- recently used songs and sets.

Selecting a result opens exactly one lead-sheet page at `/song/:id`. The page has a read mode and an explicit live mode. Live mode removes editing controls and prioritizes the complete sheet, navigation, and set progress.

No song identity depends on an Apex-generated heading ID. Repeated section headings are common; the application assigns its own stable section indexes.

### Edit an existing song

The editor is a Markdown textarea with a small metadata form and Apex-rendered preview. It should not be a WYSIWYG editor that silently rewrites spacing, punctuation, line breaks, or lyric text.

The editor displays:

- Markdown source;
- rendered preview;
- title, artist, key, singer, and notes;
- provenance/license status;
- fit result for supported iPad profiles;
- a diff against the version being edited.

Saving sends the complete Markdown document and the client’s base Git commit to the server. The server validates, renders, and commits. A stale base commit produces a conflict rather than a silent overwrite.

### Create a new song

The new-song workflow is:

1. Enter an approximate song name, optionally with artist, version, key, or arrangement notes.
2. Search the existing Git catalog first.
3. If no suitable sheet exists, search permitted web sources through isolated server-side adapters.
4. Show candidate songs and available source/provenance information.
5. Let the user choose a candidate.
6. Retrieve permitted lyric and approximate-structure data, or provide a source link and paste instructions when automated retrieval is unavailable.
7. Send the selected material to an LLM-assisted extractor.
8. Generate a draft structured Markdown lead sheet.
9. **Always open the draft in the editor for human verification.**
10. Commit only after the user reviews and explicitly saves.

The workflow must never create a song directly from a search result or LLM output.

### Create and use a set list

The set-list builder allows the user to:

- enter title, date, and location;
- select existing lead sheets;
- add songs by search or approximate-name import;
- set per-set overrides such as singer, key, capo, or transition note;
- reorder songs by touch, pointer, or keyboard;
- save the result as one Markdown set-list page.

A set list has one page and one canonical Markdown file. Its live route is a single web document containing every referenced lead sheet as an ordered, full-viewport panel. The performer moves between panels with swipe, previous/next controls, keyboard shortcuts, or a set drawer; changing the live order immediately changes that sequence. No song navigation requires a page reload or network request once the set is cached.

During a gig, reorder operations update a local live order immediately. They are marked unsaved and queued in IndexedDB. Saving or reconnecting later sends one coalesced update to the server. A network failure must not block performance.

### Offline gig mode

Before a gig, the user selects **Make available offline**. The application downloads:

- the selected set;
- all referenced lead sheets;
- rendered HTML;
- source Markdown;
- required CSS, icons, and application shell;
- metadata and the source Git commit.

The service worker and IndexedDB then provide:

- offline set opening;
- offline search within the downloaded material;
- previous/next navigation;
- instant touch reordering;
- queued edits and set changes;
- visible snapshot commit and timestamp.

Offline mode must state clearly when content is stale or unsaved.

## 4. Information architecture and canonical Markdown examples

Recommended repository structure:

```text
songs/
  rebel-yell.md
  1979.md
sets/
  2026-08-06-venue-name.md
config/
  display.md
README.md
```

During initial migration, retain existing `lead-sheet/` paths where practical. Renaming all files immediately creates unnecessary churn. The index can assign stable IDs and aliases while preserving legacy paths.

### Song document

One file represents one lead-sheet version. If a song has materially different arrangements or keys, use separate version files with distinct IDs and a shared normalized song identity in metadata.

```markdown
---
schema_version: 1
id: rebel-yell
title: Rebel Yell
artist: Billy Idol
aliases:
  - Rebel Yell live
performance:
  key: E
  capo: null
  tempo: null
  time_signature: null
  singers:
    - Kyle
  tags:
    - electric
provenance:
  status: user-supplied
  source_url: null
  retrieved_at: null
  note: Band-maintained rehearsal material
rights:
  status: unknown
  note: Verify applicable display and performance permissions
---

# Rebel Yell

## Intro

[Band count-in and entrance notes]

## Verse 1

[Verified user-provided lead-sheet content]

## Chorus

[Verified user-provided lead-sheet content]

## Bridge

[Performance notes]
```

Rules:

- `id` is stable and immutable after publication.
- Exactly one H1 is required.
- New documents should use H2 section headings, but old H3 conventions remain readable during migration.
- `performance.key` is null unless explicitly supplied or human-reviewed. Chords must not be used to infer it.
- Provenance records where the material came from and how it entered the system.
- Rights status is an editorial flag, not a legal determination.
- The Markdown body remains the authoritative performance content.

### Set-list document

One file represents one ordered set list.

```markdown
---
schema_version: 1
id: 2026-08-06-venue-name
title: Venue Name
date: 2026-08-06
location: Venue Name
status: draft
---

# Venue Name — August 6, 2026

1. [Rebel Yell](../songs/rebel-yell.md) — singer: Kyle — key: E
2. [1979](../songs/1979.md) — singer: Kyle — note: short count-in
3. [Another Song](../songs/another-song.md) — singer: Kiana
```

The link target is authoritative. Text after the link is a set-specific override or performance note. The parser must resolve every target, reject duplicate or missing entries, and preserve ordinary notes.

The application may generate a catalog or cache JSON file, but generated data is never the source of truth.

## 5. Technical architecture and security

### Server

Use a small Go service with these responsibilities:

- authenticated API;
- Git repository access;
- Markdown validation;
- Apex CLI invocation;
- index and render-cache maintenance;
- import-provider orchestration;
- operation synchronization;
- offline snapshot generation.

Use a dedicated server-side working clone or bare repository plus worktree. The server must never expose Git credentials to the browser.

Suggested API surface:

```text
GET  /api/catalog
GET  /api/songs/:id
POST /api/songs
PUT  /api/songs/:id
GET  /api/sets/:id
POST /api/sets
PUT  /api/sets/:id
POST /api/import/candidates
POST /api/import/extract
POST /api/sync
GET  /api/snapshots/:commit/:set-id
```

Every mutable request includes `baseCommit`. Responses include repository commit, file path, blob SHA, and render version.

### SQLite

SQLite stores only derived or operational data:

- searchable catalog index;
- normalized title and alias index;
- Apex HTML cache;
- offline snapshot metadata;
- pending operation queue;
- import candidate/provenance records;
- fit-test diagnostics;
- audit metadata for server operations.

SQLite must be disposable. A rebuild command recreates it from Git. No lyric, set order, or metadata is considered durable merely because it exists in SQLite.

### Git writes

On save:

1. Verify authentication and authorization.
2. Verify the path is permitted.
3. Check that `baseCommit` equals current repository HEAD.
4. Validate Markdown and metadata.
5. Resolve links.
6. Render with Apex 1.1.14.
7. Run fit checks where applicable.
8. Write the file atomically.
9. Create a server-side commit with a clear message.
10. Reindex and return the new commit.

Concurrent writes are serialized. Conflicts return HTTP 409 and include the latest version. Set-list reordering should be represented as a permutation of song IDs so local order can be rebased onto a newer set without destructive text merging.

### Security controls

- Use GitHub App or deploy-key permissions limited to the repository.
- Keep all credentials in the server environment or secret manager.
- Never log tokens, raw authorization headers, fetched lyric bodies, or member contact data.
- Apply strict Content Security Policy.
- Sanitize Apex output and disable unsafe HTML/plugins unless specifically required and tested.
- Never execute scripts from Markdown.
- Restrict imported links to HTTPS and validate internal paths.
- Rate-limit writes and external provider calls.
- Add CSRF protection for cookie-authenticated browser sessions.
- Use secure, HttpOnly, SameSite cookies or short-lived access tokens.
- Back up Git refs and verify repository health.
- Exclude member contact information from migration and application schemas.
- Scan commits and CI configuration for secrets; pin CI actions by commit SHA and verify downloaded artifacts.

## 6. iPad one-viewport fitting and themes

Live mode must fit the complete lead sheet without clipping or hidden scrolling.

Supported profiles:

- 12.9-inch iPad Pro portrait, approximately 1024×1366 CSS pixels;
- 12.9-inch iPad Pro landscape, approximately 1366×1024 CSS pixels;
- safe-area and browser chrome must be accounted for with `100dvh`.

### Fitting algorithm

The renderer should:

1. Render Markdown through Apex.
2. Convert sections into application-owned blocks.
3. Measure the actual live container using `ResizeObserver` and `visualViewport`.
4. Try one through four columns.
5. For each column count, find the largest font that fits.
6. Bound body text at a readable minimum of 16 px.
7. Bound line-height between 1.12 and 1.28.
8. Preserve section integrity where possible with `break-inside: avoid`.
9. Test both vertical and horizontal overflow.
10. Select the layout with the largest readable text, preferring fewer columns when sizes are equivalent.

The implementation must not simply apply `overflow: hidden`. If four columns at 16 px still overflow, the page enters an explicit **Needs editing for live mode** state. The UI identifies the sections causing overflow and suggests human actions such as removing redundant spacing, replacing repeated material with an approved band shorthand, or splitting an unnecessarily verbose note.

A failed sheet remains viewable in authoring mode, but live mode must refuse to present it as safe. The failure must be visible before the gig snapshot is prepared.

The fitter must run in CI against representative legacy sheets, including the longest sheets, unsectioned sheets, repeated headings, hard breaks, and unusual Unicode.

### Themes

**Stage dark**

- near-black blue-gray background;
- warm white text;
- subdued but distinct section labels;
- no pure-white bloom;
- controls hidden unless requested.

**Bright outdoor**

- white or near-white background;
- near-black text;
- strong solid section labels;
- heavier borders and controls;
- no translucent overlays that disappear in sunlight.

Provide a manual theme switch independent of OS preference. Font-size bias is adjustable, but increasing it may produce a needs-editing failure. The user must not be offered a setting that silently causes clipping.

## 7. Web-assisted song import design and rights/provenance safeguards

The required web-assisted workflow should be implemented, but as a controlled provider system rather than an open scraper.

### Provider adapters

Create a small interface:

```go
type SongSource interface {
    Search(ctx context.Context, query SongQuery) ([]Candidate, error)
    Retrieve(ctx context.Context, candidate Candidate) (SourceMaterial, error)
}
```

Each adapter is isolated and contains:

- provider name and version;
- allowed endpoints;
- robots and terms assessment;
- rate-limit policy;
- attribution requirements;
- maximum retained content;
- parser tests;
- failure behavior.

Provider configuration should allow an adapter to be disabled without changing the importer. Do not couple the application to website HTML. Prefer licensed APIs, public-domain repositories, user-authorized sources, or provider endpoints whose terms explicitly permit the intended automated use.

The server must respect robots directives, terms of service, rate limits, caching rules, authentication requirements, and applicable licensing restrictions. A source is not automatically permitted merely because it is publicly viewable.

### Candidate search

The user enters an approximate name. The server may query approved providers for:

- title;
- artist;
- recording/version;
- approximate structure;
- source URL;
- provider attribution;
- rights or usage metadata when supplied.

Candidate results are shown for explicit user selection. The application must not select a candidate solely because it has the highest score when close alternatives exist.

### Retrieval and fallback

For an approved provider, retrieve only the fields permitted by that provider. If full lyric retrieval is not permitted, retrieve metadata and approximate structure only.

When automated retrieval is not permitted:

- show the source link;
- explain that the content must be obtained and pasted by the user;
- provide a paste area;
- record the user-declared provenance;
- continue the workflow without scraping.

The fallback is part of the product, not an error path.

Raw fetched material should be retained only as long as necessary for the user’s draft workflow, subject to provider terms and the band’s retention policy. Do not build a permanent third-party lyric archive by default.

### LLM-assisted extraction

The LLM receives the selected material, the chosen candidate metadata, and an explicit extraction schema. It returns a draft containing:

- title and artist;
- key only when explicitly present;
- approximate sections such as intro, verse, chorus, bridge, solo, and outro;
- count/repeat notes when present;
- band-facing performance notes;
- source/provenance metadata;
- uncertain fields marked for review.

The LLM must not be instructed to invent missing lyrics, keys, counts, or structure. Unknown values become `null` or an editor warning. The prompt and response schema should explicitly distinguish:

- source text;
- model-generated organization;
- user-authored notes;
- uncertain inference.

The draft is never committed automatically. The editor must open every generated sheet for verification, and the Save button must remain a deliberate user action.

The system should store provider, source URL, retrieval timestamp, extractor model/version, and a content hash where appropriate. Do not store secret values, raw provider credentials, or unnecessary personal information.

## 8. Migration strategy and conflict/review rules

Treat the legacy repository and Notion as complementary sources:

- the legacy repository is the cleaner Markdown baseline;
- Notion is generally more current;
- neither source may blindly overwrite the other.

### Import sequence

1. Freeze the legacy repository commit used for migration.
2. Export all API-visible Notion pages and database records needed for review.
3. Record source paths, hashes, timestamps, and non-sensitive provenance in a migration manifest.
4. Exclude Members contact fields and all member PII.
5. Normalize legacy Markdown conservatively.
6. Preserve original bodies in a private migration archive or Git branch where necessary.
7. Generate canonical song and set-list Markdown candidates.
8. Reindex and render all candidates.
9. Present review queues before publishing the migrated branch.

### Matching

Match records using:

- normalized title;
- artist where available;
- key or arrangement qualifier;
- aliases;
- content fingerprint;
- source timestamps;
- explicit human confirmation.

Do not match or overwrite based only on title. Preserve distinct performance versions such as different keys, vocal arrangements, or acoustic/electric treatments.

### Review queues

Require human review for:

- 167 legacy sheets with no sections;
- all missing or ambiguous keys, since the legacy audit found zero explicit key evidence;
- five title/filename anomalies;
- 24 unrecognized H3 labels;
- duplicate and variant candidates;
- empty or minimal pages;
- Notion pages whose song structure cannot be parsed;
- gigs whose song order cannot be unambiguously extracted;
- records visible in one source but not the other;
- rights/provenance marked unknown.

### Conflict rules

- If the legacy file is newer by Git history but Notion has newer content, preserve both and create a review record.
- If Notion has a newer page timestamp but only metadata changed, merge metadata without rewriting the legacy body.
- If both contain materially different bodies, create separate draft versions and ask Kyle to select or merge.
- Never delete a source during migration.
- Never infer a key from chord text.
- Never convert a title qualifier into a new canonical version without review.
- Never treat Notion `last_edited_time` as a line-level revision history.
- After migration, Git becomes the canonical source for the application. Notion remains an input/reference system, not a synchronization peer.

The migration should be delivered in reviewable commits: imported source preservation, normalized Markdown, set-list conversion, then approved metadata corrections.

## 9. Delivery phases with acceptance criteria

### Phase 0: fixtures and migration proof

- Pin Apex 1.1.14.
- Build Markdown parser, validator, and catalog index.
- Import the 284 legacy sheets without changing body content.
- Create migration candidates for the 293 Notion Lead Sheets records.
- Produce conflict and review queues.

**Acceptance:** every approved legacy sheet is discoverable; Apex renders every valid file; no member contact data is imported; source differences are reviewable.

### Phase 1: read-only PWA and live mode

- Search catalog.
- Song and set pages.
- Apex render cache.
- Stage-dark and bright themes.
- One-viewport fitter.
- Offline snapshot download and live navigation.

**Acceptance:** a prepared set opens in airplane mode on a target iPad; current, next, and previous sheets work without network; no approved sheet clips.

### Phase 2: Git-backed editing

- Markdown editor and metadata form.
- Apex preview.
- Server-side validation and commits.
- Base-commit conflict handling.
- Audit-friendly commit messages.

**Acceptance:** two stale editors cannot silently overwrite one another; every saved document is recoverable from Git and renders successfully.

### Phase 3: set builder and offline reorder

- Create one set-list page from selected songs.
- Touch reorder and keyboard controls.
- Local live-order overlay.
- Coalesced save and reconnect queue.

**Acceptance:** a 30-song set can be reordered instantly offline; the saved Markdown order matches the live order after synchronization.

### Phase 4: web-assisted import

- Provider adapter interface.
- Approved-source candidate search.
- Source-link and paste fallback.
- LLM extraction with schema and uncertainty markers.
- Mandatory editor verification.
- Provenance and rights fields.

**Acceptance:** no import commits automatically; ambiguous candidates require selection; disabled or disallowed providers fall back cleanly to links and paste.

### Phase 5: pilot and hardening

- Real iPad Safari testing.
- Dark-stage and bright-outdoor trials.
- Accessibility and security review.
- Backup/restore runbook.
- One rehearsal and one gig pilot.

**Acceptance:** no unresolved critical rendering, offline, security, or data-loss defects; Kyle confirms that live operation is simpler than the existing workflow.

## 10. Risks and explicit non-goals

### Risks

- **Rights risk:** automated lyric retrieval may violate provider terms or applicable rights. Mitigate with allowlisted adapters, legal review, provenance, and paste fallback.
- **Incorrect song matching:** use high confidence thresholds, margin checks, and mandatory confirmation for ambiguity.
- **LLM hallucination:** mark uncertainty, prohibit invention, and require editor verification.
- **Unreadable long sheets:** enforce the 16 px floor and an explicit needs-editing state; never clip.
- **Git conflicts:** use base commits, local live overlays, and conflict-preserving synchronization.
- **Apex drift:** pin 1.1.14 and maintain golden rendering fixtures.
- **Notion incompleteness:** the API can see only shared content; require a human-confirmed export and review.
- **Unsafe Markdown:** sanitize output, disable plugins, apply CSP, and prevent scripts.
- **Stale offline data:** show commit/time and require explicit snapshot refresh.

### Explicit non-goals

- Member contact information, rosters, or personnel management.
- Public sharing of lead sheets.
- Automatic scraping of arbitrary lyric websites.
- Automatic copyright clearance or legal advice.
- Audio playback, karaoke, transcription, or automatic chord recognition.
- Automatic overwrite between Notion and GitHub.
- Database-first storage.
- Infinite scrolling or multi-page live lead sheets.
- A full collaborative editor with real-time cursors.
- PDF as the canonical output.

## 11. Recommended next action

Approve Phase 0 and Phase 1 as the first implementation milestone.

Start by freezing the legacy migration input, pinning Apex 1.1.14, building the disposable SQLite index, and implementing the read-only Go/API/vanilla-JS PWA. Test the complete 284-sheet legacy corpus, the Notion review candidates, and real target iPad viewports before enabling writes.

The go/no-go decision after that milestone is straightforward:

- If the corpus renders and fits, proceed to Git-backed editing and set-list mutation.
- If sheets fail fitting, fix the Markdown structure or create a reviewed compact form; do not weaken the live-mode requirement.
- If a web source cannot be used lawfully or technically, retain the source-link-plus-paste workflow rather than adding an unapproved scraper.

This sequence keeps Git durable, the server small, the browser simple, and the performer’s live experience dependable.