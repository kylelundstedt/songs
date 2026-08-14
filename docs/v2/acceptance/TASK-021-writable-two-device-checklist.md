# TASK-021 Two-Device Writable Acceptance Checklist

**Prepared:** August 14, 2026
**Status:** `PENDING_OWNER_EXECUTION`
**Scope:** physical iPad writable acceptance for the disabled-by-default V2 Set
List and lead-sheet workflow. This is not evidence of a pass.

Complete every blocking item on two separately identified physical devices.
Software/Chromium evidence, static source inventory, copied browser storage, and
one person operating two tabs do **not** satisfy a two-device item. Record
`PASS`, `FAIL`, or `PENDING`; an unavailable required control is `FAIL`, not an
assumed pass.

## Safety rules

1. Keep V1 open on a separate device or immediately reachable bookmark/PDF for
   the whole session. V1 is the operational fallback; V2 remains opt-in.
2. Use two distinct Safari/Home Screen profiles with distinct registered device
   identities. Never copy a browser profile, IndexedDB database, credential, or
   device token from device A to device B.
3. Before each destructive/recovery drill, export authored state from **both**
   devices and record each export SHA-256 and timestamp. Exports may contain
   authored material; store them as owner-controlled recovery material and do
   not attach credentials to the record.
4. Do not clear Safari website data, force a worker update, or delete a server
   database before the recovery decision table and backup/restore order in the
   TASK-021 runbook have been followed.
5. A conflict must visibly retain the local candidate and the server candidate.
   Never use DevTools, direct SQLite edits, Git rewrites, or a hidden API call
   as a substitute for the product conflict workflow.

## Session identity

- Owner/tester:
- Absolute start/end time (UTC):
- Git commit and shell release:
- V2 origin and launch mode for A (Safari / Home Screen):
- V2 origin and launch mode for B (Safari / Home Screen):
- Device A model, screen size, iPadOS/Safari build, free storage:
- Device B model, screen size, iPadOS/Safari build, free storage:
- Device A registered device ID (non-secret):
- Device B registered device ID (non-secret):
- Server/release operator:
- V1 fallback location and verification time:
- Initial authored export A SHA-256 / B SHA-256:

## Preflight and labels

| ID | Required observation | Status | Evidence/notes |
|---|---|---|---|
| WRT-001 | V1 default origin opens and is usable before V2 writing begins. | PENDING | |
| WRT-002 | Both V2 clients identify the same approved release, owner, and isolated V2 origin, but distinct device IDs. | PENDING | |
| WRT-003 | Writable gates are intentionally enabled only for this session; Set List and lead-sheet gates are recorded independently. Provider/Shelley gates, if used, are recorded separately. | PENDING | |
| WRT-004 | Each client shows distinguishable local, queued, acknowledged/server, server-validated (lead sheet), published, and conflicted states where applicable; no label is interpreted as another state. | PENDING | |
| WRT-005 | Initial exports from both clients verify and their SHA-256 values are recorded. | PENDING | |
| WRT-006 | A known reviewed Set List and a known reviewed lead sheet open read-only before authoring; no baseline content is modified for the drill. | PENDING | |

## Independent offline durability

Perform the Set List and lead-sheet rows separately. For lead sheets, include a
metadata-only edit and an exact-source/body edit; for Set Lists, include add,
reorder, and occurrence-specific note edits.

| ID | Required observation | Status | Evidence/notes |
|---|---|---|---|
| WRT-010 | A creates a Set List offline, closes the app, reopens offline, and finds the exact local draft, entry identities/order, notes, revision, and queued state. | PENDING | |
| WRT-011 | A edits a Set List offline, including a duplicate occurrence and reorder; B does not receive the draft until an intentional sync. | PENDING | |
| WRT-012 | A creates or edits a lead sheet offline, including an invalid intermediate if the workflow permits it; close/reopen retains exact source, workspace/receipt state, and queued work without silently validating or publishing it. | PENDING | |
| WRT-013 | A interrupts a send (Airplane Mode or controlled network loss), then reopens/retries. The immutable operation/envelope is not replaced, duplicated, or lost; final server result is recorded. | PENDING | |
| WRT-014 | A exports unsynced Set List and lead-sheet work, restores it into a clean approved browser profile, and verifies exact drafts, revisions, outbox/conflicts, and restored device-identity continuity before any sync. | PENDING | |
| WRT-015 | A quota/storage failure is either safely handled with no partial authored commit or is recorded as a blocking failure; never delete data to make this row pass. | PENDING | |

## Two-device concurrent-write and conflict workflow

For each document kind, start both devices from the same acknowledged server
revision. Put B offline before A syncs its divergent edit. Record revision IDs,
operation IDs, cursor before/after, and screenshots of both candidates.

| ID | Required observation | Status | Evidence/notes |
|---|---|---|---|
| WRT-020 | **Set List conflict setup:** A and B make divergent edits to the same base revision; A syncs first and B later syncs. B receives an explicit conflict rather than an overwrite or silent merge. | PENDING | |
| WRT-021 | **Set List conflict inspection:** conflict UI shows document, current/server revision, local candidate revision, status, and both candidate contents/identities; duplicate occurrences remain distinguishable. | PENDING | |
| WRT-022 | **Set List keep-server:** choose the explicit keep-server flow. The server candidate becomes current only through a recorded resolution; B's local candidate remains recoverable until the resolution is durably recorded/exported. | PENDING | |
| WRT-023 | **Set List keep-local:** choose the explicit keep-local flow. It creates/records a resolution against the current server head; it does not resend an obsolete base or erase the server candidate. | PENDING | |
| WRT-024 | **Set List manual resolution:** create a deliberate merged result using explicit user-visible content, resolve it, and verify A/B converge after pull/ack. If manual resolution is unavailable, record `FAIL`. | PENDING | |
| WRT-025 | **Lead-sheet conflict setup:** repeat WRT-020 with divergent exact source/metadata edits. The conflict is explicit; neither candidate's untouched bytes are silently normalized. | PENDING | |
| WRT-026 | **Lead-sheet inspection/resolution:** repeat WRT-021 through WRT-024 for lead sheets, including keep-server, keep-local, and manual resolution. Server validation is rerun as required and no local preview is treated as publication approval. | PENDING | |
| WRT-027 | A stale cursor, exact retry after uncertain response, and a refresh/pull do not produce duplicate revisions or hide an open conflict. | PENDING | |
| WRT-028 | Revoke one device during a controlled session. Its credential stops working immediately; its already committed local work remains exportable and the other device remains owner-isolated. | PENDING | |

## Server, publication, and recovery drills

These are engineering-assisted and must follow the runbook. Do not perform them
against an unbacked production-like instance.

| ID | Required observation | Status | Evidence/notes |
|---|---|---|---|
| WRT-030 | Controlled server restart during queued/offline work preserves local drafts and allows later idempotent sync or explicit conflict. | PENDING | |
| WRT-031 | Failed server/Apex validation retains the authored lead-sheet workspace and durable receipt/issues; fixing/retrying does not lose exact source. | PENDING | |
| WRT-032 | Publication reservation/failed push or finalization recovery does not lose accepted revisions; affected clients show a safe queued/retry/error state and no false published label. | PENDING | |
| WRT-033 | Coordinated backup verifies sync ledger, publication ledger, and Git bundle as one package. Restore is first performed into a new isolated destination and verified before cutover. | PENDING | |
| WRT-034 | A controlled external Git reconciliation or skewed accepted/unfinalized recovery converges Git bytes, publication mapping, and server ledger without overwriting an external change. | PENDING | |
| WRT-035 | After any server restore/recovery, both devices pull/ack, compare final current/published revisions, and retain all pre-drill local candidate exports. | PENDING | |

## Carried-forward blocking read-only G4 checks

These earlier physical checks remain prerequisites for writable physical
acceptance. On August 14, 2026 they are all `PENDING`, not passed by this
checklist or its deterministic evidence.

| ID | Required observation | Status | Evidence/notes |
|---|---|---|---|
| PHY-028 | Background/resume after 5 minutes preserves safe state. | PENDING | |
| PHY-029 | Background/resume after 30 minutes preserves safe state. | PENDING | |
| PHY-032 | Reboot and offline reopen succeeds. | PENDING | |
| PHY-037 | Engineering-assisted V2-origin eviction surrogate and online rebootstrap restores exact counts; skip only if Safari cannot isolate the port-8001 entry. | PENDING | |
| PHY-038 | Owner-approved low-free-storage test passes or is recorded as a blocking failure. | PENDING | |

## End-of-session recovery and decision

| ID | Required observation | Status | Evidence/notes |
|---|---|---|---|
| WRT-040 | Final exports from A and B verify; their hashes, outbox/conflict counts, and any unresolved conflict IDs are recorded. | PENDING | |
| WRT-041 | Both devices are returned to read-only/disabled writable gates unless a separately approved controlled test remains active. | PENDING | |
| WRT-042 | V1 fallback is verified after the drill. Any pending/failed row, including PHY-028/029/032/037/038, keeps writable pilot approval `NO`. | PENDING | |

Attach a completed copy of the writable signoff template. A completed checklist
is evidence for owner review only; pilot approval, V1 retirement, default-route
change, and broad-device support are separate decisions.
