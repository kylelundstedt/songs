# Notion migration candidates

Generate review-only candidates from the authenticated read-only Notion proxy:

```sh
python3 scripts/export_notion_lead_sheet_candidates.py --validate-apex
```

The exporter discovers and queries only the `Lead Sheets` database. It does not
query `Members`, makes no Notion writes, and replaces only this dedicated output
directory. `manifest.json` and `REVIEW.md` document the snapshot and conversion
limits. Candidate files are not canonical song files.
