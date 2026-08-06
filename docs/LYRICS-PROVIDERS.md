# Lyrics provider policy

The Add a Song workflow searches provider APIs and requires the user to choose a recording before lyrics are retrieved.

## Enabled adapters

- **LRCLIB**: machine-oriented search and lyrics API.
- **Lyrics.ovh**: recording suggestions and lyrics API, with Deezer recording metadata used when available for original BPM.

Search responses expose recording metadata only. Full lyrics are fetched only after the authenticated user selects a result. The generated Markdown is always reviewable before it is committed.

## Unsupported automated sources

AZLyrics does not expose a supported lyrics API and its crawler policy excludes automated search and song retrieval. It must not be scraped or proxied by this application. A future provider may be added only through an API or license that permits the intended private workflow.

## Lead-sheet structuring

After a recording is selected, the raw lyric lines are numbered and sent to the fast `gpt-5.6-luna` model through the VM's Shelley LLM integration. The model returns only a section plan with headings and line ranges; the server—not the model—reassembles the original lyric text verbatim. Invalid plans fall back to deterministic stanza/repetition heuristics.

Repeated sections are abbreviated to a heading only when their normalized lines exactly match an earlier section. This reduces one-page iPad pressure without silently dropping changed lyrics.

## Provenance and performance metadata

Generated song front matter records:

- `source_provider` and `source_url`
- `original_key` and `original_bpm`
- `performance_key` and `bpm`

Original-recording metadata and the band's performance arrangement remain separate. Lyrics are formatted from provider line and stanza breaks, repeated passages are identified as chorus candidates, and the vocalist reviews the result before creation.
