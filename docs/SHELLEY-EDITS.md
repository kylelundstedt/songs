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
