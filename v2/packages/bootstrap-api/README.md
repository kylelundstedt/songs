# TASK-010 bootstrap API package

`@songs-v2/bootstrap-api` turns the reviewed TASK-009 projection into the
immutable wire payload served by the isolated Go V2 API.

## Trust boundary

Generation fails unless `v2/packages/read-model` is byte-identical to reviewed
TASK-009 commit `2cbf78adac34fab94487a7b06a782907a257303b` and its import-report and
projection hashes match the pinned values. Source and evidence are then read
only from the TASK-008 commits. Apex is executed only during generation and its
binary, version, flags, source binding, output bytes, and output hashes are
checked against frozen renderer evidence.

The generated manifest is a code-reviewed runtime trust anchor. Go embeds its
exact SHA-256 and rejects a self-consistent but re-signed replacement.
Canonical JSON is sorted, two-space-indented UTF-8 with one final newline;
duplicate keys and alternate numeric spellings are rejected across TypeScript
and Go.

## Payload

The manifest and 12 source-byte-bounded chunks contain:

- 373 lossless typed document projections and exact canonical source bytes;
- 339 source-bound authoritative Apex HTML documents;
- three frozen browser-fit results for every lead sheet;
- 36 snapshot-scoped Set sections and 1,076 Set Entries exactly once;
- 373 exact slug routes;
- transitive projection, document, chunk, snapshot, evidence, and manifest
  hashes.

Generated files live under `internal/v2bootstrap/data/` and are served as exact
preloaded bytes. Request handling does not invoke Node, Git, Apex, the
TypeScript importer, or the filesystem.

## Commands

From the repository root:

```sh
npm --prefix v2 run check
npm --prefix v2 test
npm --prefix v2 run fixtures
# Intentional regeneration after reviewed contract changes:
npm --prefix v2 run fixtures:generate --workspace @songs-v2/bootstrap-api
make v2-api-build
./srv/songs-v2-api -listen :8001
```

API routes require the trusted exe.dev `X-ExeDev-UserID` identity header:

- `GET /api/v2/bootstrap/manifest`
- `GET /api/v2/bootstrap/{generation}/chunks/chunk-NNN.json`

All failures under the isolated API are versioned JSON. There is no HTML shell,
mutation route, Git publication path, or v1 router dependency.
