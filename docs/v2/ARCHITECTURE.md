# V2 Architecture

This is the agreed target shape; `docs/V2-PROPOSAL.md` remains the detailed rationale and delivery plan.

## Direction

V2 is a **controlled rewrite**: build a TypeScript local-first PWA beside the proven Go service, preserve v1 routes and Git/Markdown portability during migration, and retain v1 as the rollback baseline. Do not rewrite every layer at once.

## Runtime boundaries

```text
TypeScript PWA
  UI + domain services + local parser/renderer/fitter
  IndexedDB: documents, revisions, search projection, outbox, conflicts
  service worker: versioned app shell and deliberate immutable assets
             │ versioned pull/push sync
Go service
  auth/ACL + sync + validation/rendering + providers
  durable SQLite operation/audit ledger
  Git materializer/exporter
             │
Published Markdown in Git
```

- Local IndexedDB is the operational source for browser reads and writes.
- Every mutation validates and commits locally before entering the durable outbox.
- Sync is explicit, idempotent, observable, and conflict-preserving; it is never required for core rehearsal or performance workflows.
- Git is authoritative for **published archive content**. After cutover, the application is the sole automated writer; external Git changes require deliberate reconciliation.
- Apex remains the initial authoritative publication validator and regression oracle while a constrained local parser/renderer is proven.
- Live mode is a locked performance surface, separate from authoring.

## Initial domain

Use stable immutable IDs for `LeadSheet`, `LeadSheetRevision`, `SetList`, `SetSection`, and `SetEntry`. Filenames are slugs, not identity. Preserve legacy Markdown byte-for-byte through sidecar identity manifests and lossless parsing.

Start with validated strings for band and location. Add broader entities only when a concrete workflow requires them.

## Readiness states

Keep `local stage-ready`, `server-validated`, and `published` distinct. Never collapse them into an unqualified `Ready` state.
