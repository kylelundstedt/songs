# Notion Gigs collection

Read-only collection from the `notion-songs` integration. No Notion writes were made.

## Counts

- **gigs**: 52
- **body blocks examined**: 1990
- **song evidence**: 1437
- **set breaks**: 38
- **with song evidence**: 49
- **empty bodies**: 3
- **column order ambiguous**: 34
- **high**: 8
- **medium**: 41
- **low**: 3

## Evidence policy

- Includes Gigs page IDs, gig metadata, page and evidence timestamps, source block IDs/paths, brief song labels, links where present, set-break labels, and confidence/ambiguity.
- Excludes participating-member data, contact information, full lyrics, lead-sheet bodies, and other unstructured gig prose.
- Order is API block-tree preorder. Notion columns and multi-list pages can make this differ from visual or actual performance order; those records are flagged in JSON.
- High evidence means a child-page title, an inline link, or a Lead Sheets title match. Medium evidence is a short title-like unlinked label. Apparent performer headers and performance directions were excluded. Low means no conservatively extractable song evidence.

## Blockers / limitations

- Gigs has no first-class ordered set-list-item relation, so body layout is the only source for ordering.
- Many pages use Notion columns, which do not expose a definitive performance sequence through the API.
- A body label can represent a proposal, reference/version, transition, or notes rather than a confirmed performed song.
- The database query returned 52 records; known blank/orphan pages not returned by that endpoint are outside this collection.
