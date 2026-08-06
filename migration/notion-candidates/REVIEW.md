# Notion Lead Sheets migration review

## Scope and safeguards

- Read-only Notion API export from the `Lead Sheets` database only.
- No Members records or Member properties were queried or imported.
- Files are review candidates only; no canonical song path is read, changed, or overwritten.
- Candidate filenames are `<normalized-title>--<Notion-page-UUID>.md`, so collisions remain stable and distinct.

## Counts

- Lead Sheets records exported: **293**
- Candidate Markdown files: **293**
- Empty converted bodies: **1**
- Candidates with unsupported blocks noted inline: **0**
- Duplicate normalized-title groups: **0**

## Converted block types

- `bulleted_list_item`: 6 — converted
- `column`: 549 — converted
- `column_list`: 274 — converted
- `heading_3`: 2528 — converted
- `paragraph`: 2890 — converted

## Duplicate normalized titles

- None

## Rendering validation

- **Passed:** all candidate Markdown files rendered with Apex using `--no-plugins --no-unsafe -m gfm`.

## Limitations requiring review

- Notion page bodies are presentation-oriented; columns are flattened left-to-right, then top-to-bottom within each column.
- Literal newlines inside a Notion paragraph become Markdown hard line breaks.
- Visible rich text is retained, but source links/URLs and unsupported inline-only formatting are intentionally not imported.
- Unsupported block types are not guessed; each is called out in its candidate and recorded in `manifest.json`.
- This is an API-visible snapshot, not Notion history or a bidirectional synchronization mechanism.
