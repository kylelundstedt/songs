# TASK-014: Offline Set List Detail and Locked Live Mode

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Status:** Complete (August 11, 2026)
- **Estimate:** 3–5 focused engineering days

## Objective

Run every reviewed Set List as a complete performance-only Live sequence from
the matching active IndexedDB snapshot with no network dependency or mutation
surface.

## Scope

- resolve every Set Entry occurrence locally by immutable entry and lead-sheet
  identity;
- add exact Set List detail and `#/sets/:slug/live` routes;
- render authoritative verified Apex HTML through the proven automatic fitter;
- preserve the 21px-to-16px tablet search, two-column layout, 20px scrolling
  phone layout, explicit column breaks, and fit warnings;
- add bounded previous/next controls, progress, exit, and bright/stage-dark
  performance themes;
- expose singer, note, key, BPM, section, and landscape warning context without
  provider or authoring controls;
- keep Live available after a failed update only while the matching active
  pointer remains valid.

Do not add editing, font persistence, pin mutations, provider links, Shelley,
outbox writes, sync submission, Git publication, a browser Markdown renderer,
v1 changes, or route cutover.

## Acceptance criteria

- all 34 current Set Lists open and all 1,076 Set Entry occurrences resolve;
- duplicate song occurrences retain distinct entry identity and sequence;
- Live reads only the matching active pointer generation and makes zero network
  requests after bootstrap with the API unavailable;
- previous/next controls and keyboard navigation are bounded and occurrence
  based, with progress and focus announcements;
- authoritative Apex output remains the only lead-sheet rendering source;
- the production fitter matches the frozen corpus semantic contract at its
  reviewed measurement surfaces: 339 portrait fits, 334 landscape fits plus
  five explicit warnings, and 339 one-column scrolling phone results; actual
  Live geometry separately reports runtime scrolling warnings and never a false
  fit;
- Stage Dark and Bright modes preserve layout and have no content or storage
  mutation beyond in-memory presentation state;
- touch targets, reduced motion, contrast, keyboard behavior, and Chromium axe
  checks pass;
- physical Safari/iPad acceptance remains pending and mandatory.

## Completion evidence

- immutable performance models resolve all 34 current Set Lists and all 1,076
  Set Entry occurrences, retaining duplicate occurrence identity and authored
  order;
- exact `#/sets/:slug/live` routing is available only for the matching active
  IndexedDB pointer, with mounted-pointer revalidation and safe reload on drift;
- locked Live exposes only Exit, Bright/Stage Dark, Previous, and Next controls;
  Apex remains the hidden verified authority and cloned links are inert while
  their text remains accessible;
- the production fitter preserves v1 sectionization, explicit breaks, balancing,
  21px-to-16px tablet search, 20px phone layout, rendered overflow checks, and
  readable one-column fallback;
- the real-browser corpus gate matches all 1,017 frozen semantic fit results
  with zero false fits; actual latest-set Live traversal records 58 portrait
  fits and 57 landscape fits plus the expected Can’t Stop warning at occurrence
  39;
- direct locked-Live reload with the API process inactive uses the active
  IndexedDB snapshot, makes zero API/post-ready navigation requests, and writes
  no local presentation preference;
- Chromium axe, 48px touch targets, responsive overflow, fixed phone controls,
  and active-pointer invalidation observations pass; unit tests cover keyboard
  navigation, focused-column paging, focus announcements, strict Apex
  sanitization, and memory-only theme behavior;
- 85 web tests pass, and reproducible evidence is recorded under
  `migration/v2/phase1/live/` for shell release
  `shell-8e20346e9b3ac2579dee901a`;
- physical Safari/iPad acceptance remains pending and mandatory.
