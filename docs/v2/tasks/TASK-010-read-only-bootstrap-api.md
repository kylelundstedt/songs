# TASK-010: Versioned Read-Only Bootstrap API

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Done on August 10, 2026
- **Estimate:** 2–3 focused engineering days

## Objective

Expose TASK-009's immutable typed projection through a production-shaped,
versioned read-only bootstrap API. Deliver deterministic manifest/chunk DTOs
with canonical source metadata and authoritative Apex HTML for the isolated V2
client without invoking Node per request or changing v1 routes.

## Scope

- generate one immutable bootstrap DTO package from `@songs-v2/read-model/git`;
- include versioned schema, source/evidence commits, document IDs, source hashes,
  source bytes, typed projections, slug routes, fit status, and authoritative
  Apex HTML tied to the same source hash;
- serve an explicit manifest plus deterministic chunks under `/api/v2/`;
- return typed JSON errors for missing/corrupt/unsupported resources and never
  fall through to an HTML application shell;
- enforce the existing private-read authentication boundary;
- verify complete snapshot and chunk hashes before publication.

Do not add browser writes, local Markdown rendering authority, sync submission,
Git publication, V2 shell routing, or default-route cutover.

## Acceptance criteria

- every frozen TASK-009 document and Set Entry appears exactly once;
- repeated generation produces byte-identical manifest/chunk output;
- all source, projection, chunk, and Apex hashes verify transitively;
- corrupt, missing, reordered, duplicate, or unsupported chunks fail explicitly;
- API failures use a versioned JSON error schema and cannot return HTML fallback;
- v1 APIs and default routes remain unchanged;
- tests demonstrate that request handling loads immutable generated data rather
  than executing the TypeScript importer per request.

## Completed evidence

- `@songs-v2/bootstrap-api` requires the read-model tree and report/projection hashes from reviewed TASK-009 commit `2cbf78a` before generation;
- source and evidence bytes are read only from pinned TASK-008 Git commits, and all 339 lead sheets are rendered once with the frozen Apex binary identity/flags and matched to frozen output hashes;
- generation produces one reviewed manifest and 12 chunks containing 373 typed documents, 36 Set section projections, 1,076 Set Entries, 373 slug routes, 748,034 canonical source bytes, 339 Apex HTML documents, and 1,017 fit records;
- transitive source, projection, document, chunk, snapshot, evidence, and manifest hashes verify in both TypeScript and Go;
- the exact manifest SHA-256 is compiled as a runtime trust anchor, so fully re-signed source/projection/Apex/fit/route substitutions fail closed;
- Go embeds and validates all bytes once at startup, rejects missing/unexpected/corrupt/noncanonical assets, and serves exact in-memory bytes without Node, Git, Apex, filesystem, or importer calls per request;
- the canonical JSON domain is shared across TypeScript and Go and rejects duplicate keys, unsafe/alternate numbers, ambiguous key ordering, escaped separator drift, and lone surrogates;
- `cmd/v2api` serves only authenticated JSON on isolated port 8001; v1's frozen `srv/` tree and routes remain unchanged;
- `songs-v2-api.service` is enabled and running with generation `phase1-f9634173e25ef4ca4b8330a3`;
- final adversarial architecture and code reviews found no remaining material issues.
