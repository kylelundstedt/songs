# Metadata enrichment artifacts

This directory contains compact, auditable inventory, proposal, decision, and review files. Provider response bodies are cached in `.metadata-cache/`, which is ignored by Git.

The canonical lead-sheet body must not change during metadata application.

```sh
python3 tools/populate_metadata.py inventory
python3 tools/populate_metadata.py harvest --pilot --output metadata/pilot-proposals.json
python3 tools/populate_metadata.py apply \
  --proposals metadata/pilot-proposals.json \
  --decisions metadata/pilot-decisions.json
python3 -m unittest tests/test_populate_metadata.py
```

`source_provider`/`source_url` are intentionally not assigned to migrated lead sheets. The external LRCLIB match is stored as `lyrics_reference_*`; actual text provenance remains the legacy Git import.

## Original-key estimates

Original-recording keys can be estimated from the selected recording using AcousticBrainz where available and three Essentia key profiles over a transient Deezer preview:

```sh
python3 -m venv /tmp/songs-keyenv
/tmp/songs-keyenv/bin/pip install -r tools/metadata-key-requirements.txt
/tmp/songs-keyenv/bin/python tools/populate_keys.py harvest
/tmp/songs-keyenv/bin/python tools/populate_keys.py apply --proposals metadata/key-proposals.json
```

Audio previews remain only in the ignored `.metadata-cache/`. Canonical files record the estimated key, estimate kind, confidence, and analyzed recording URL. A leading `~` in the app indicates that the displayed original key is an estimate rather than a confirmed band performance key.

After original metadata is reviewed, seed missing editable performance values from it:

```sh
python3 tools/populate_keys.py seed-performance
```

This only fills missing `performance_key` and `bpm` fields. Existing band-arrangement values are never overwritten. The header always displays the editable performance values; original key/BPM remain in the footer for comparison.

## Estimated song structure

Unsectioned lead sheets can receive headings without rewriting their canonical content:

```sh
python3 tools/populate_structure.py propose
python3 tools/populate_structure.py merge \
  --proposals metadata/structure-proposals.json \
  --decisions /path/to/review-decisions.json
python3 tools/populate_structure.py apply \
  --proposals metadata/structure-proposals.json
```

The pipeline first aligns headings from matching Notion candidates, then uses reviewed model plans for unresolved songs. Application inserts headings only, records `structure_status: estimated` and `structure_source`, and verifies that every original non-heading content line remains unchanged and in order. Measure counts are retained only when supported by Notion; model-only plans do not invent them.
