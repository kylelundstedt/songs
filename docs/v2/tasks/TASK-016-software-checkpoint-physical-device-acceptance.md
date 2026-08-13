# TASK-016: Software Checkpoint and Physical-Device Acceptance Package

- **Priority:** P0
- **Phase:** 1 read-only vertical slice
- **Phase packet:** P1-009
- **Status:** Software complete; read-only physical evaluation in progress with deferred G4 checks (August 13, 2026)
- **Estimate:** 2–3 focused software days; physical validation separately 3–5 days plus owner/device time

## Objective

Issue a reproducible software checkpoint for the isolated read-only V2 pilot and
provide an executable physical iPad/Safari install, recovery, rollback, and
acceptance package without changing default routes or overstating Chromium as
physical-device evidence.

## Scope

- bind frozen source/evidence/rollback refs, current bootstrap and shell trust
  anchors, release binary, service unit, and supporting evidence summaries;
- publish deterministic software and physical test matrices with distinct
  statuses;
- document V2 installation, upgrade, service health, diagnostics, safe recovery,
  worker lifecycle, and layered rollback;
- state storage persistence and export limitations explicitly;
- provide a physical iPad/Safari checklist and owner signoff template;
- verify V1 remains active and default while V2 remains opt-in on port 8001;
- preserve all writable, cutover, and read-only physical-evaluation gates;
- classify VoiceOver as optional/nonblocking unless it is part of an explicitly
  approved supported-device contract;
- keep rehearsal and real-gig trials optional and separate from this design
  evaluation.

Do not execute or infer owner signoff, declare Safari/iPad compatibility, add
writes, change the default origin, retire v1, or claim rehearsal/gig readiness.

## Acceptance criteria

- every required software matrix item is supported by deterministic evidence or
  checkpoint observations;
- checkpoint status is `SOFTWARE_PASS_PHYSICAL_PENDING`;
- physical matrix items remain `PENDING` until completed on an owner-approved
  device;
- install/upgrade/rollback commands affect only V2 unless explicitly verifying
  V1 health;
- public port-8001 TLS/private-login behavior and loopback service health are
  recorded;
- release binary builds reproducibly and matches the deployed binary;
- service-unit bytes match the installed unit;
- persistence remains advisory and no read-only export/import is falsely claimed;
- the package states that browser export/recovery is mandatory before writable
  operation;
- V1 remains available as immediate fallback at the default URL;
- required read-only physical evaluation remains mandatory before claiming that
  evaluation complete; optional VoiceOver omission is nonblocking and optional
  G6/G7 trials are not implied next steps;
- no physical result in this package covers writable behavior, which remains
  unimplemented and untested.

## Completion evidence

- `migration/v2/phase1/checkpoint/checkpoint-summary.json` records the complete
  software matrix and all immutable identities/hashes; the final package commit
  is published by annotated tag `v2-p1-009-software-checkpoint-2026-08-12`,
  which is not an input to its own evidence generation;
- `docs/v2/runbooks/P1-009-install-upgrade-rollback.md` documents service and
  client operation, diagnostics, recovery, and rollback;
- `docs/v2/acceptance/P1-009-ipad-safari-checklist.md` defines 57 physical checks
  through install, offline workflows, lifecycle, update, ergonomics, plus
  optional rehearsal and real-gig trials;
- `docs/v2/acceptance/P1-009-signoff-template.md` prevents software evidence from
  being mistaken for owner/device acceptance;
- `migration/v2/phase1/checkpoint/update-drill/` contains a deterministic,
  bootstrap-compatible successor release for the physical PHY-039 worker drill;
- the V2 binary builds from two independent clean Git exports with
  `-trimpath -buildvcs=false`, produces the same SHA-256, and matches the
  deployed checkpoint binary;
- both `songs.service` and `songs-v2-api.service` are enabled and active, with V2
  bound to loopback port 8001 and V1 remaining the default port-8000 app;
- the public port-8001 proxy negotiates TLS/private login and rejects a forged
  identity header before application access;
- the package explicitly records no user-facing V2 export/import, physical
  status `PENDING`, stage readiness `false`, writable allowed `false`, and cutover
  allowed `false`.

## Remaining work

The owner completed substantial read-only physical evaluation on August 13,
2026. Deferred blocking G4 reliability checks remain for a later session. G6/G7
are optional operational trials and are not recommended as the next step while
the current design requires further work. Writable behavior is outside this
slice: it has not been implemented or physically tested.
