# V2 migration artifacts

## V1 corpus baseline

`v1-corpus-manifest.json` is generated only from a fresh `git archive v1` at
commit `546f59b41d9e9bcf0e81b543c27900a31e26c9e6`; it never reads the mutable
working-tree `songs/` or `sets/` directories. Records are sorted by path and
rendered as UTF-8 JSON with two-space indentation and one final LF. Newline
styles are `LF`, `CRLF`, `CR`, `mixed`, or `none`.

Each Markdown link retains its authored `target` exactly. Relative targets are
resolved against the tagged file and classified as `resolved canonical file` or
`missing`; `unresolved:*`, URL destinations, and `#anchor` destinations are
classified as `unresolved: reference`, `external URL`, and `anchor`.

Regenerate or verify the checked-in artifact with:

```sh
python3 scripts/build_v2_baseline.py
python3 scripts/build_v2_baseline.py --check
```

The recorded `verification.output_sha256` is the SHA-256 of the canonical JSON
render with that field set to `null`, avoiding a self-referential hash.
