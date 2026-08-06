# Focused Shelley edits

Song and live-set pages provide an **Edit with Shelley** dialog that stays over the current lead sheet while a correction runs.

The endpoint is deliberately narrower than a general coding-agent session:

- An authenticated request must identify an indexed canonical song.
- The fast Shelley model receives the current Markdown body and a short user request.
- Front matter is preserved byte-for-byte.
- The proposed body must retain the title and section structure and stay within a bounded line-edit distance.
- Only that song's canonical Markdown path may be written.
- Song creation and focused edits share the same write lock.
- The revision must render successfully with Apex before it is committed and pushed.
- The file hash is checked again before publication to reject concurrent changes.

General application changes still use the full Shelley conversation link from non-song pages.
