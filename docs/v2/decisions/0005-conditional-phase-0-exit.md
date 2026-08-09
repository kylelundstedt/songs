# Decision 0005: Conditional Phase 0 Exit and Read-Only Phase 1

- **Status:** Accepted
- **Date:** 2026-08-09

## Decision

Phase 0 validates the controlled-rewrite architecture but is not declared fully closed. The `v1` evidence remains the rollback oracle, while current `main` has changed enough to require a separate current-content baseline before user-visible V2 work.

TASK-008 will freeze current content and refresh corpus, renderer/fit, route, recovery, and bootstrap evidence. Phase 1 then delivers an isolated read-only React/TypeScript PWA. A separate origin is preferred; `/v2/` is acceptable only with an explicit root v1-worker bypass and tested controller handoff. The client uses authoritative Apex HTML and exposes no mutation path.

Writable V2, physical readiness claims, default-route changes, and cutover remain no-go decisions until their explicit gates pass.

## Consequences

The original proposal's phase numbering is superseded by the Phase 0 exit review and Phase 1 plan. Minimum identity/read API foundation is included inside the read-only vertical slice. Production sync hardening and writable Set List work follow as a separate phase.
