# TASK-009 typed read model

`@songs-v2/read-model` projects the immutable TASK-008 source and evidence tags
into typed, read-only `LeadSheet`, `SetList`, `SetSection`, and `SetEntry`
objects. It does not read canonical Markdown or identity contracts from the
worktree.

## Frozen inputs

- source bytes: `v2-phase1-content-2026-08-10` at `17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5`;
- manifest and identities: `v2-phase1-evidence-2026-08-10` at `5ea535b53b94445084586828389f44c1a5136877`.

The Git adapter verifies both annotated tag objects and peeled commits, then
loads canonical files only from `git archive v2-phase1-content-2026-08-10`.
Contract self-hashes, source hashes, byte counts, identities, slug routes, Set
Entry fingerprints, duplicate occurrences, ordinals, and resolved targets are
validated before a snapshot is returned.

## Model boundary

Canonical Markdown remains authoritative and is retained both as strict UTF-8
text and exact base64 bytes. Parsed front matter retains its raw lexical source
and complete YAML mapping, including unknown fields. Set List source nodes
retain every body line exactly; parsing never silently discards source text.

Set Entry IDs come only from the frozen identity sidecar. TASK-008 contains no
persistent Set Section sidecars, so `SetSection.projectionKey` is explicitly
scoped to the frozen snapshot and must not be treated as a future writable
identity.

The package does not render Markdown, expose mutation APIs, submit sync work, or
write `songs/` or `sets/`.

## Commands

From `v2/`:

```sh
npm install
npm run check
npm test
npm run build
npm run fixtures
# Regenerate intentionally after a reviewed contract/parser change:
npm run fixtures:generate
```

`fixtures/current/import-report.json` covers all 373 documents and 1,076 Set
Entries. `representative-projections.json` records a legacy-sidecar song, a
declared-ID song, and the three-section current Set List. Both are generated
without timestamps, host paths, or mutable worktree input.
