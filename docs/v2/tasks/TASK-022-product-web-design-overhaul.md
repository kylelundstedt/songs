# TASK-022: Product-Wide Web Design Overhaul

- **Priority:** P0 after writable workflows function end to end
- **Phase:** Post-Phase-1 writable productization
- **Status:** Planned after TASK-021
- **Dependencies:** Functional Set List and lead-sheet writable workflows plus owner review of current design
- **Estimate:** To be scoped from workflow/design discovery

## Objective

Replace the current evidence-oriented, visually weak interface with a coherent,
usable product design grounded in the real read/write/sync/conflict workflows.
Do not polish placeholder workflows before they exist.

## Scope

- conduct owner-led workflow and information-architecture review;
- redesign Library, Songs, Set Lists, editor, outbox/sync, conflict, Status, and
  locked Live surfaces as one system;
- establish typography, density, hierarchy, navigation, forms, feedback,
  destructive-action safety, responsive behavior, and reusable components;
- reduce diagnostic/evidence language on ordinary product surfaces while keeping
  detailed diagnostics available in Status/support views;
- design explicitly for the approved 13-inch iPad, desktop, keyboard/touch, and
  offline states;
- test complete create/edit/reorder/sync/conflict/recovery workflows, not static
  mockups alone;
- preserve accessibility fundamentals even where optional assistive-technology
  certification is outside the selected device contract.

## Excluded

- changing sync/publication correctness to simplify UI;
- hiding local/queued/conflicted/published distinctions;
- printing and spreadsheet export unless needed for design integration later;
- default-route cutover or V1 retirement.

## Acceptance criteria

- owner approves the information architecture and primary workflow prototypes;
- common read and writable tasks require clear, predictable steps with no
  evidence-oriented clutter;
- all mutation states and failure/recovery actions remain truthful and visible;
- complete physical iPad and desktop workflow usability tests pass;
- locked Live remains fast, uncluttered, and protected from accidental editing;
- visual changes introduce no data-loss, sync, publication, offline, or route
  regression.

## Rollback

Keep the prior functional writable UI behind a temporary release rollback while
correcting design regressions; never roll back durable authored data.
