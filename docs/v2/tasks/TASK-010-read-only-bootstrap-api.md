# TASK-010: Versioned Read-Only Bootstrap API

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Ready
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
