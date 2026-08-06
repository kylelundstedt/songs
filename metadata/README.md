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
