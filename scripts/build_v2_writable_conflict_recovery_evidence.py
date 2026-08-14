#!/usr/bin/env python3
"""Build deterministic TASK-021 source/test inventory evidence.

This intentionally inventories checked-in automated evidence only. It does not
execute tests, contact a service, inspect a browser profile, or claim any
physical-device result.
"""

import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGET = ROOT / "migration/v2/writable-conflict-recovery/writable-conflict-recovery-evidence.json"

ARTIFACTS = (
    {
        "id": "SW-021-001",
        "scope": "browser-authored-durability-and-client-recovery",
        "source": {
            "v2/packages/web/src/storage/authored.ts": (
                "createAuthoredStateExport",
                "validateAuthoredStateExport",
                "validateConflictRecord",
                "OutboxState",
            ),
            "v2/packages/web/src/storage/index.ts": (
                "exportAuthoredState",
                "restoreAuthoredState",
                "claimNextAuthoredOutbox",
                "commitAuthoredSync",
            ),
        },
        "tests": {
            "v2/packages/web/src/storage/authored.test.ts": (
                "claims and fails retries durably without changing envelope bytes or payload hash",
                "atomically persists sync cursor/conflicts and removes only acknowledged outbox work",
                "exports all authored stores with a hash and restores by safe merge or atomic replace",
                "maps quota aborts and leaves no partial draft, revision, or outbox",
                "uses explicit lease cutoffs so forward or backward wall-clock skew cannot silently steal sending work",
                "re-queues a reviewed resolution against a newer server head after a failed immutable CAS intent",
            ),
            "v2/packages/web/src/storage/authored-leadsheets.test.ts": (
                "builds, replays, claims, syncs, and reopens exact lead-sheet authored records",
                "replace restore overwrites typed TASK-020 workspace and validation receipt records",
                "atomically projects a resolution into an unchanged lead-sheet workspace and preserves a newer workspace by CAS",
            ),
        },
    },
    {
        "id": "SW-021-002",
        "scope": "foreground-sync-retry-device-continuity-and-write-gates",
        "source": {
            "v2/packages/web/src/sync/engine.ts": (
                "Recovered outbox contains more than one device identity",
                "reclaimSendingBefore",
                "PUBLICATION_RESERVED",
                "permittedKind",
            ),
            "cmd/v2api/main.go": (
                "-sync-enabled",
                "-writable-enabled",
                "-lead-sheet-writable-enabled",
            ),
        },
        "tests": {
            "v2/packages/web/src/sync/client.test.ts": (
                "preserves the exact frozen apply envelope and maps nested retryable errors",
                "uses the server pull and acknowledgement wire contracts exactly",
            ),
            "cmd/v2api/main_test.go": (
                "TestRunRejectsWritableControlsWithoutSync",
                "TestRunRejectsLeadSheetControlsWithoutSync",
            ),
        },
    },
    {
        "id": "SW-021-003",
        "scope": "server-conflict-idempotency-revocation-and-restart",
        "source": {
            "internal/v2sync/store.go": (
                "func (s *Store) Apply",
                "func (s *Store) Resolve",
                "func (s *Store) ConflictDocumentKind",
                "func (s *Store) Backup",
            ),
            "internal/v2sync/publication.go": (
                "ErrConflictCAS",
                "ErrPublicationReserved",
            ),
            "internal/v2syncapi/handler.go": (
                "ErrConflictCAS",
                "ErrPublicationReserved",
            ),
        },
        "tests": {
            "internal/v2sync/store_test.go": (
                "TestStaleWritePreservationAndExactConflictResolution",
                "TestConflictResolutionCASPreservesConflictAfterHeadAdvances",
                "TestRevokedDeviceCannotAccessAnyDeviceLedgerOperation",
                "TestRestartPreservesOperationsConflictsAndAcknowledgements",
                "TestOnlineBackupRestorePreservesLedgerAndAuthorizationState",
            ),
            "internal/v2syncapi/handler_test.go": (
                "TestApplyReplayMismatchHashUnknownBaseWrongDocumentAndStaleConflict",
                "TestResolveConflictUsesCompareAndSwapAndIsIdempotent",
                "TestSelfRevokeOnlyAndImmediateCredentialInvalidation",
                "TestDocumentWriteGatesRejectDisabledKinds",
            ),
        },
    },
    {
        "id": "SW-021-004",
        "scope": "publication-fencing-git-reconciliation-and-coordinated-server-recovery",
        "source": {
            "internal/v2publish/coordinated_backup.go": (
                "func (p *Publisher) CoordinatedBackup",
                "func VerifyCoordinatedBackup",
                "func RestoreCoordinatedBackup",
                "remote changed during coordinated backup",
            ),
            "internal/v2sync/publication.go": (
                "ReservePublication",
                "ReleasePublication",
            ),
        },
        "tests": {
            "internal/v2publish/publish_test.go": (
                "TestCommitPushAndFinalizationCrashRecoveryNoDuplicateCommits",
                "TestCoordinatedBackupAndRestorePackage",
                "TestBackupRestoreRepairsRemoteAcceptedUnfinalizedCommit",
                "TestPublicationReservationBlocksEligibilityChangeThroughPush",
            ),
            "internal/v2sync/publication_test.go": (
                "TestPublicationReservationFencesMutationsUntilExactRelease",
                "TestExactMutationReplayPrecedesPublicationReservation",
                "TestExactResolutionReplayPrecedesPublicationReservation",
            ),
        },
    },
    {
        "id": "SW-021-005",
        "scope": "durable-explicit-browser-conflict-review-and-resolution",
        "source": {
            "v2/packages/web/src/conflicts/ConflictReviewPage.tsx": (
                "Keep server",
                "Keep local",
                "Queue manual resolution",
                "Both original candidates remain retained",
            ),
            "v2/packages/web/src/leadsheets/repository.ts": (
                "matchingServerBaseline",
                "workspace.baseServerRevisionId",
                "serverHead",
            ),
            "v2/packages/web/src/storage/authored.ts": (
                "buildConflictResolutionOutbox",
                "reviewedLocalRevisionId",
                "recordType: \"resolution\"",
                "currentRevisionId",
                "candidateRevisionId",
            ),
            "v2/packages/web/src/sync/engine.ts": (
                "resolveConflict",
                "RESNAPSHOT_REQUIRED",
                "CONFLICT_CAS_FAILED",
                "Sync outcome operation identity",
            ),
        },
        "tests": {
            "v2/packages/web/src/authored/remote-head.test.ts": (
                "opens a clean Set List editor from the latest server bytes rather than stale bootstrap bytes",
                "opens a clean lead sheet from the latest server source but binds an older local workspace to its exact baseline",
            ),
            "v2/packages/web/src/conflicts/ConflictReviewPage.test.tsx": (
                "shows both retained candidates and durably queues an explicit keep-local resolution",
            ),
            "v2/packages/web/src/sync/engine.test.ts": (
                "resolves through the conflict endpoint and atomically stores revision/conflict before deleting outbox",
                "keeps a failed CAS resolution and both immutable conflict sides through a required resnapshot",
                "reconciles a lost local resolution response from pull and removes only the exact accepted operation",
                "marks a losing local resolution superseded when another device resolves first",
                "merges current and published mappings when one pull batch contains both events for a document",
                "binds edit-before-first-sync only to an exact matching server baseline revision",
                "rejects a mismatched server operation outcome without deleting durable resolution work",
                "refreshes a compacted cursor snapshot without rebasing never-attempted local edits onto an unseen head",
            ),
            "v2/packages/web/src/authored/status.test.ts": (
                "gives conflicts precedence over publication",
                "distinguishes local, queued, accepted, acknowledged, and published",
            ),
        },
    },
)


def read_required(relative: str, required: tuple[str, ...], kind: str) -> dict:
    path = ROOT / relative
    if not path.is_file():
        raise SystemExit(f"missing {kind} artifact: {relative}")
    data = path.read_bytes()
    text = data.decode("utf-8")
    missing = [needle for needle in required if needle not in text]
    if missing:
        raise SystemExit(f"{relative}: missing required {kind} marker(s): {', '.join(missing)}")
    return {
        "path": relative,
        "sha256": hashlib.sha256(data).hexdigest(),
        "required_markers": list(required),
    }


def evidence() -> dict:
    artifacts = []
    for artifact in ARTIFACTS:
        artifacts.append({
            "id": artifact["id"],
            "scope": artifact["scope"],
            "source_inventory": [
                read_required(path, markers, "source")
                for path, markers in artifact["source"].items()
            ],
            "test_inventory": [
                read_required(path, markers, "test")
                for path, markers in artifact["tests"].items()
            ],
        })
    return {
        "schema_version": "1",
        "kind": "songs-v2.task-021.writable-conflict-recovery.evidence",
        "prepared_date": "2026-08-14",
        "evidence_boundary": {
            "automated_software": "CHECKED_IN_SOURCE_AND_TEST_INVENTORY",
            "generator_test_execution": "NOT_EXECUTED_BY_GENERATOR",
            "physical_ipad_g4_and_writable_workflows": "PENDING_OWNER_EXECUTION",
            "physical_non_claim": "No physical iPad G4 or writable workflow has been run or passed by this generator.",
        },
        "automated_software_evidence": artifacts,
        "make_check_contract": {
            "target": "v2-writable-conflict-recovery-check",
            "runs_before_inventory_check": [
                "npm --prefix v2 run check --workspace @songs-v2/web",
                "npm --prefix v2 run test --workspace @songs-v2/web",
                "go test -race ./internal/v2auth/... ./internal/v2author/... ./internal/v2sync/... ./internal/v2syncapi/... ./internal/v2bootstrap/... ./internal/v2publish/... ./cmd/v2api ./cmd/v2publisher",
            ],
            "inventory_check": "python3 scripts/build_v2_writable_conflict_recovery_evidence.py --check",
        },
        "physical_owner_execution": {
            "status": "PENDING",
            "prepared_date": "2026-08-14",
            "carry_forward_pending_read_only_g4": ["PHY-028", "PHY-029", "PHY-032", "PHY-037", "PHY-038"],
            "required_new_checklist": "docs/v2/acceptance/TASK-021-writable-two-device-checklist.md",
            "required_signoff_template": "docs/v2/acceptance/TASK-021-writable-signoff-template.md",
            "required_recovery_runbook": "docs/v2/runbooks/TASK-021-writable-conflict-recovery.md",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    output = (json.dumps(evidence(), indent=2) + "\n").encode("utf-8")
    if args.check:
        if not TARGET.is_file() or TARGET.read_bytes() != output:
            print(f"{TARGET}: stale", file=sys.stderr)
            raise SystemExit(1)
        return
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_bytes(output)


if __name__ == "__main__":
    main()
