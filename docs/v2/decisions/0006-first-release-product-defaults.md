# Decision 0006: Delegated First-Release Product Defaults

- **Status:** Accepted provisionally; owner review required before pilot
- **Date:** 2026-08-09

## Decision

Use these conservative defaults while implementation remains autonomous:

- first release is single-owner across multiple devices;
- client framework is React + TypeScript + Vite;
- full-library offline bootstrap is the default;
- 13-inch tablet portrait is the primary browser profile, with landscape supported and fit warnings explicit;
- Live uses the last server-validated/published revision by default;
- local stage-ready drafts require a future explicit owner opt-in and acknowledgement before Live use;
- dashboard selection uses an explicitly pinned active Set List and otherwise recent-use/date fallback, not legacy `status` metadata.

## Consequences

Authorization may remain owner-first but must not prevent later role expansion. Physical iPad model and minimum Safari version remain unresolved acceptance inputs. These defaults do not authorize writable work or cutover.
