# Reusable template — you probably don't want these

Use `../RUN-THIS-IN-PROD.sql` instead. It is these pieces already
assembled with the exported flows baked in.

These three are only for exporting again later:

- `1-export-flows-from-local.sql` — run on local, produces `flows.json`
- `flows.json` — the export taken 2026-09-02 (2 flows, 18 nodes)
- `2-import-flows-to-prod.sql` — BLANK template. Its payload is
  `{"flows": []}`, so running it as-is fails with
  "The payload has no flows". Paste a `flows.json` into it first.
