# Focused Shelley edits

Song and live-set pages provide an **Edit with Shelley** dialog that stays over the current lead sheet while a correction runs.

The endpoint is deliberately narrower than a general coding-agent session:

- An authenticated request must identify an indexed canonical song.
- The model returns only small, numbered line-range replacements; the server applies them to the untouched original body.
- Front matter, unrelated lyrics, spacing, and line endings are preserved byte-for-byte.
- Only that song's canonical Markdown path may be written.
- Song creation and focused edits share the same write lock.
- The revision must render successfully with Apex before it is committed and pushed.
- The file hash is checked again before publication to reject concurrent changes.

General application changes still use the full Shelley conversation link from non-song pages.

## Direct Markdown editing

Song and live-set pages also expose **Edit Markdown**. The editor loads the complete canonical file, including front matter, and saves it with an optimistic source hash. The server rejects stale saves, validates the result with Apex, writes only the indexed song path, commits and pushes the revision, and rebuilds the search index.
