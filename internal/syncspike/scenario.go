package syncspike

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// RunScenario executes the complete isolated TASK-005 proof. It emits only
// fixed semantic identifiers and hashes; temporary paths and clocks stay local.
func RunScenario(root string) (map[string]any, error) {
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, err
	}
	s, err := Open(filepath.Join(root, "sync-spike.sqlite"))
	if err != nil {
		return nil, err
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		return nil, err
	}
	seedBodyA := []byte("---\nartist: Example\n---\n\n# Song A\n\nSeed A\n")
	seedBodyB := []byte("---\nschema_version: 1\n---\n\n# Song B\n\nSeed B\n")
	seedA, err := s.Apply(Operation{"op-seed-a", "device-a", "song-a", "", "Song A", seedBodyA})
	if err != nil {
		return nil, err
	}
	seedB, err := s.Apply(Operation{"op-seed-b", "device-b", "song-b", "", "Song B", seedBodyB})
	if err != nil {
		return nil, err
	}
	pubSeedA, err := g.Publish(s, seedA.RevisionID, Failure{})
	if err != nil {
		return nil, err
	}
	pubSeedB, err := g.Publish(s, seedB.RevisionID, Failure{})
	if err != nil {
		return nil, err
	}
	initialA, err := s.Pull(0, 20)
	if err != nil {
		return nil, err
	}
	if err = s.AckCursor("device-a", initialA.Cursor); err != nil {
		return nil, err
	}
	initialB, err := s.Pull(0, 20)
	if err != nil {
		return nil, err
	}
	if err = s.AckCursor("device-b", initialB.Cursor); err != nil {
		return nil, err
	}

	editA := Operation{"op-a-edit", "device-a", "song-a", seedA.RevisionID, "Song A", []byte("# Song A\n\nDevice A edit\n")}
	editB := Operation{"op-b-edit", "device-b", "song-b", seedB.RevisionID, "Song B", []byte("# Song B\n\nDevice B edit\n")}
	batch, err := s.PushBatch([]Operation{editA, editB})
	if err != nil {
		return nil, err
	}
	fullReplay, err := s.PushBatch([]Operation{editA, editB})
	if err != nil {
		return nil, err
	}
	stale := Operation{"op-b-stale-a", "device-b", "song-a", seedA.RevisionID, "Song A", []byte("# Song A\n\nDevice B stale candidate\n")}
	partial, err := s.PushBatch([]Operation{editB, stale})
	if err != nil {
		return nil, err
	}
	if partial[1].Status != "conflict" {
		return nil, errors.New("stale write did not conflict")
	}
	if _, err = s.Apply(Operation{"op-a-edit", "device-a", "song-a", seedA.RevisionID, "Song A", []byte("# Song A\n\ntampered\n")}); err == nil {
		return nil, errors.New("payload-mismatched replay accepted")
	}
	candidatePublish, candidateErr := g.Publish(s, partial[1].RevisionID, Failure{})
	if candidateErr == nil || candidatePublish.State != "ineligible" {
		return nil, errors.New("conflict candidate was publishable")
	}

	// Simulate response loss: the first returned page is not acked. Resume from
	// the last durable acknowledgement, then acknowledge the complete response.
	ackBeforeLoss, err := s.DeviceCursor("device-a")
	if err != nil {
		return nil, err
	}
	lostPage, err := s.Pull(ackBeforeLoss, 1)
	if err != nil {
		return nil, err
	}
	resume, err := s.Pull(ackBeforeLoss, 20)
	if err != nil {
		return nil, err
	}
	if err = s.AckCursor("device-a", resume.Cursor); err != nil {
		return nil, err
	}
	ackAfterResume, err := s.DeviceCursor("device-a")
	if err != nil {
		return nil, err
	}

	resolvedStale, err := s.Resolve(partial[1].ConflictID, Operation{"op-a-resolve", "device-a", "song-a", batch[0].RevisionID, "Song A", []byte("# Song A\n\nResolved deliberately\n")})
	if err != nil {
		return nil, err
	}
	bad, err := s.Apply(Operation{"op-b-invalid", "device-b", "song-b", batch[1].RevisionID, "Song B", []byte("# Different H1\n\nAccepted but not publishable\n")})
	if err != nil {
		return nil, err
	}
	badResult, badErr := g.Publish(s, bad.RevisionID, Failure{})
	if badErr == nil || badResult.State != "validation_failed" {
		return nil, errors.New("validation failure was not durable")
	}
	commitRecovery, err := s.Apply(Operation{"op-a-commit-recovery", "device-a", "song-a", resolvedStale.RevisionID, "Song A", []byte("# Song A\n\nCommit failure recovery\n")})
	if err != nil {
		return nil, err
	}
	commitFail, commitErr := g.Publish(s, commitRecovery.RevisionID, Failure{Commit: true})
	if commitErr == nil || commitFail.State != "commit_failed" {
		return nil, errors.New("commit injection did not fail")
	}
	commitOK, err := g.Publish(s, commitRecovery.RevisionID, Failure{})
	if err != nil {
		return nil, err
	}
	pushRecovery, err := s.Apply(Operation{"op-a-push-recovery", "device-a", "song-a", commitRecovery.RevisionID, "Song A", []byte("# Song A\n\nPush failure recovery\n")})
	if err != nil {
		return nil, err
	}
	pushFail, pushErr := g.Publish(s, pushRecovery.RevisionID, Failure{Push: true})
	if pushErr == nil || pushFail.State != "push_failed" {
		return nil, errors.New("push injection did not fail")
	}
	pushOK, err := g.Publish(s, pushRecovery.RevisionID, Failure{})
	if err != nil {
		return nil, err
	}
	idempotent, err := g.Publish(s, pushRecovery.RevisionID, Failure{})
	if err != nil || !idempotent.Idempotent || idempotent.Commit != pushOK.Commit {
		return nil, errors.New("published retry was not repaired/idempotent")
	}

	finalizationLoss, err := s.Apply(Operation{"op-a-finalization-loss", "device-a", "song-a", pushRecovery.RevisionID, "Song A", []byte("# Song A\n\nRemote accepted finalization recovery\n")})
	if err != nil {
		return nil, err
	}
	beforeFinalizationCount, err := g.RemoteCommitCount()
	if err != nil {
		return nil, err
	}
	finalizationFailed, finalizationErr := g.Publish(s, finalizationLoss.RevisionID, Failure{Finalize: true})
	if finalizationErr == nil || finalizationFailed.State != "finalization_lost" {
		return nil, errors.New("remote-accepted finalization loss was not injected")
	}
	afterAcceptedCount, err := g.RemoteCommitCount()
	if err != nil || afterAcceptedCount != beforeFinalizationCount+1 {
		return nil, errors.New("finalization-loss push did not reach remote exactly once")
	}
	pendingIntent, err := s.Publication(finalizationLoss.RevisionID)
	if err != nil || pendingIntent.State != "commit_created" || pendingIntent.ExpectedPublished != pushRecovery.RevisionID {
		return nil, errors.New("commit-created intent did not persist predecessor")
	}
	beforeRepairPointer, err := s.PublishedRevision("song-a")
	if err != nil || beforeRepairPointer != pushRecovery.RevisionID {
		return nil, errors.New("finalization-loss unexpectedly advanced published pointer")
	}
	finalizationOK, err := g.Publish(s, finalizationLoss.RevisionID, Failure{})
	if err != nil || finalizationOK.Commit != finalizationFailed.Commit {
		return nil, errors.New("finalization-loss retry did not repair existing remote commit")
	}
	afterRepairCount, err := g.RemoteCommitCount()
	if err != nil || afterRepairCount != afterAcceptedCount {
		return nil, errors.New("finalization-loss retry created another commit")
	}
	afterRepairPointer, err := s.PublishedRevision("song-a")
	if err != nil || afterRepairPointer != finalizationLoss.RevisionID {
		return nil, errors.New("finalization-loss retry did not repair published pointer")
	}
	laterPublication, err := s.Apply(Operation{"op-a-later-publication", "device-a", "song-a", finalizationLoss.RevisionID, "Song A", []byte("# Song A\n\nLater publication B\n")})
	if err != nil {
		return nil, err
	}
	laterPub, err := g.Publish(s, laterPublication.RevisionID, Failure{})
	if err != nil {
		return nil, err
	}
	oldAcknowledgement, err := g.Publish(s, finalizationLoss.RevisionID, Failure{})
	if err != nil || oldAcknowledgement.State != "acknowledged" || !oldAcknowledgement.Idempotent {
		return nil, errors.New("old remote publication was not acknowledged after later publication")
	}
	pointerAfterOldAck, err := s.PublishedRevision("song-a")
	lastAfterOldAck, baseAfterOldAck, stateErr := s.GitState()
	if err != nil || stateErr != nil || pointerAfterOldAck != laterPublication.RevisionID || lastAfterOldAck != laterPub.Commit || baseAfterOldAck != laterPub.Commit {
		return nil, errors.New("old publication retry rewound pointer or Git baseline")
	}

	unpublished, err := s.Apply(Operation{"op-a-unpublished", "device-a", "song-a", laterPublication.RevisionID, "Song A", []byte("# Song A\n\nUnpublished local revision\n")})
	if err != nil {
		return nil, err
	}
	externalBody := []byte("# Song A\n\nExternal Git editor change\n")
	externalCommit, err := g.ExternalEditWithSidecar("song-a", externalBody)
	if err != nil {
		return nil, err
	}
	if err := g.fetch(); err != nil {
		return nil, err
	}
	externalSideRaw, err := g.treeBlob(externalCommit, ".songs-v2/documents/song-a.json")
	if err != nil {
		return nil, err
	}
	var externalSide sidecar
	if err := json.Unmarshal(externalSideRaw, &externalSide); err != nil {
		return nil, err
	}
	sidecarClaimChanged := externalSide.RevisionID != laterPublication.RevisionID && externalSide.ContentHash != bodyHash(externalBody)
	driftResult, driftErr := g.Publish(s, unpublished.RevisionID, Failure{})
	if driftErr == nil || driftResult.State != "remote_drift" {
		return nil, errors.New("remote drift was not durable")
	}
	reconciled, err := g.ReconcileExternal(s)
	if err != nil {
		return nil, err
	}
	if len(reconciled) != 1 || reconciled[0].Kind != "conflict" || reconciled[0].ConflictID == "" {
		return nil, errors.New("external drift did not produce typed conflict")
	}
	publishedImmediatelyAfterReconcile, err := s.PublishedRevision("song-a")
	if err != nil || publishedImmediatelyAfterReconcile != reconciled[0].RevisionID {
		return nil, errors.New("reconciliation did not move published pointer to external revision")
	}
	if again, err := g.ReconcileExternal(s); err != nil || len(again) != 0 {
		return nil, errors.New("reconciliation retry duplicated work")
	}
	blocked, blockedErr := g.Publish(s, unpublished.RevisionID, Failure{})
	if blockedErr == nil || blocked.State != "ineligible" {
		return nil, errors.New("open external conflict did not block publication")
	}
	resolvedExternal, err := s.Resolve(reconciled[0].ConflictID, Operation{"op-a-external-resolve", "device-a", "song-a", unpublished.RevisionID, "Song A", []byte("# Song A\n\nMerged external and local revision\n")})
	if err != nil {
		return nil, err
	}
	beforeMergedCount, err := g.RemoteCommitCount()
	if err != nil {
		return nil, err
	}
	mergedPub, err := g.Publish(s, resolvedExternal.RevisionID, Failure{})
	if err != nil {
		return nil, err
	}
	afterMergedCount, err := g.RemoteCommitCount()
	if err != nil || afterMergedCount != beforeMergedCount+1 {
		return nil, errors.New("post-reconciliation publish did not advance exactly once")
	}

	directBody := []byte("# Song A\n\nDirect external import after merge\n")
	directCommit, err := g.ExternalEditWithSidecar("song-a", directBody)
	if err != nil {
		return nil, err
	}
	direct, err := g.ReconcileExternal(s)
	if err != nil {
		return nil, err
	}
	if len(direct) != 1 || direct[0].Kind != "imported" || direct[0].ConflictID != "" {
		return nil, errors.New("direct external import was not typed")
	}

	counts, err := s.Counts()
	if err != nil {
		return nil, err
	}
	gitSafety, err := g.SafetyProof()
	if err != nil {
		return nil, err
	}
	integrity, fk, err := s.Integrity()
	if err != nil {
		return nil, err
	}
	remoteHead, err := g.RemoteHead()
	if err != nil {
		return nil, err
	}
	remoteCount, err := g.RemoteCommitCount()
	if err != nil {
		return nil, err
	}
	openConflicts, err := s.OpenConflictCount("song-a")
	if err != nil {
		return nil, err
	}
	commitAttempts, err := s.PublicationAttempts(commitRecovery.RevisionID)
	if err != nil {
		return nil, err
	}
	pushAttempts, err := s.PublicationAttempts(pushRecovery.RevisionID)
	if err != nil {
		return nil, err
	}
	finalizationAttempts, err := s.PublicationAttempts(finalizationLoss.RevisionID)
	if err != nil {
		return nil, err
	}
	validationAttempts, err := s.PublicationAttempts(bad.RevisionID)
	if err != nil {
		return nil, err
	}
	driftAttempts, err := s.PublicationAttempts(unpublished.RevisionID)
	if err != nil {
		return nil, err
	}
	audit, err := s.Audit()
	if err != nil {
		return nil, err
	}
	externalActor := ""
	for _, event := range audit {
		if event["action"] == "external_reconciled" && event["source_commit"] == externalCommit {
			externalActor = event["actor"]
		}
	}
	if externalActor == "" {
		return nil, errors.New("external actor was not durably audited")
	}
	seedBlob, err := g.treeBlob(pubSeedA.Commit, "songs/song-a.md")
	if err != nil {
		return nil, err
	}
	mergedBlob, err := g.treeBlob(mergedPub.Commit, "songs/song-a.md")
	if err != nil {
		return nil, err
	}
	sideRaw, err := g.treeBlob(mergedPub.Commit, ".songs-v2/documents/song-a.json")
	if err != nil {
		return nil, err
	}
	var side sidecar
	if err := json.Unmarshal(sideRaw, &side); err != nil {
		return nil, err
	}
	proofs := map[string]bool{
		"exact_replay":                           fullReplay[0] == batch[0] && fullReplay[1] == batch[1] && partial[0] == batch[1],
		"cursor_response_loss_safe":              ackBeforeLoss == initialA.Cursor && lostPage.Cursor == resume.Events[0].Sequence && ackAfterResume == resume.Cursor,
		"cursor_acknowledged_resume":             len(resume.Events) >= 2 && resume.Events[0].Sequence == lostPage.Events[0].Sequence,
		"conflict_candidate_rejected":            candidateErr != nil && candidatePublish.State == "ineligible",
		"both_conflicts_resolved":                openConflicts == 0,
		"post_reconcile_publish_once":            afterMergedCount == beforeMergedCount+1,
		"typed_direct_import":                    direct[0].Kind == "imported" && direct[0].ConflictID == "",
		"external_sidecar_claim_not_trusted":     sidecarClaimChanged && reconciled[0].Kind == "conflict",
		"git_body_seed_preserved":                bytesEqual(seedBlob, seedBodyA),
		"git_body_later_preserved":               bytesEqual(mergedBlob, []byte("# Song A\n\nMerged external and local revision\n")),
		"sidecar_identity_outside_body":          side.DocumentID == "song-a" && side.RevisionID == resolvedExternal.RevisionID && !containsBytes(mergedBlob, []byte(".songs-v2")),
		"integrity":                              integrity && fk,
		"remote_drift_recorded":                  driftErr != nil && driftResult.State == "remote_drift",
		"publication_open_conflict_rejected":     blockedErr != nil && blocked.State == "ineligible",
		"git_safety":                             gitSafety,
		"remote_history_consistent":              remoteHead == directCommit && remoteCount == afterMergedCount+1,
		"finalization_loss_repaired_once":        finalizationFailed.Commit == finalizationOK.Commit && afterRepairCount == afterAcceptedCount && afterAcceptedCount == beforeFinalizationCount+1 && afterRepairPointer == finalizationLoss.RevisionID,
		"old_remote_acknowledged_without_rewind": oldAcknowledgement.State == "acknowledged" && pointerAfterOldAck == laterPublication.RevisionID && lastAfterOldAck == laterPub.Commit && baseAfterOldAck == laterPub.Commit,
		"external_published_pointer_proven":      publishedImmediatelyAfterReconcile == reconciled[0].RevisionID,
		"external_actor_durable":                 externalActor == "External Editor",
	}
	feasible := true
	for _, ok := range proofs {
		feasible = feasible && ok
	}
	return map[string]any{
		"schema_version": "1.0",
		"scope":          map[string]any{"task": "TASK-005 sync feasibility spike", "non_production": true, "http_api_exposed": false, "canonical_corpus_modified": false, "remote": "isolated local bare repository only", "fixture_source": "two small embedded representative legacy Markdown byte strings"},
		"protocol":       map[string]any{"schema_migration": SchemaVersion, "operations": "(device_id, operation_id) identity; kind and conflict target participate in payload hash", "batch": "PushBatch is a non-atomic list of independently idempotent operations", "cursors": "read-only Pull plus monotonic AckCursor", "conflicts": "known same-document base required; stale candidates and resolved history are durable", "publication": "serialized isolated materialization with durable retry state and reconciliation baseline"},
		"scenario": map[string]any{
			"sequences":  map[string]any{"seed": []int64{seedA.Sequence, seedB.Sequence}, "different_documents": []int64{batch[0].Sequence, batch[1].Sequence}, "stale_conflict": partial[1].Sequence, "stale_resolution": resolvedStale.Sequence, "validation_failure": bad.Sequence, "commit_recovery": commitRecovery.Sequence, "push_recovery": pushRecovery.Sequence, "finalization_loss": finalizationLoss.Sequence, "later_publication": laterPublication.Sequence, "unpublished": unpublished.Sequence, "external_conflict": reconciled[0].Sequence, "external_resolution": resolvedExternal.Sequence, "direct_external_import": direct[0].Sequence},
			"pull":       map[string]any{"initial_ack": initialA.Cursor, "ack_before_response_loss": ackBeforeLoss, "lost_response_cursor": lostPage.Cursor, "resumed_from_ack_sequences": eventSequences(resume.Events), "ack_after_resume": ackAfterResume, "device_b_ack": initialB.Cursor},
			"operations": map[string]any{"operation_count": counts["operations"], "full_replay_sequences": []int64{fullReplay[0].Sequence, fullReplay[1].Sequence}, "partial_replay_sequence": partial[0].Sequence, "same_payload_exact_outcome": proofs["exact_replay"], "different_payload_rejected": true},
			"revisions":  map[string]any{"seed_a": seedA.RevisionID, "seed_b": seedB.RevisionID, "stale_candidate": partial[1].RevisionID, "stale_resolution": resolvedStale.RevisionID, "commit_recovery": commitRecovery.RevisionID, "push_recovery": pushRecovery.RevisionID, "finalization_loss": finalizationLoss.RevisionID, "later_publication": laterPublication.RevisionID, "unpublished": unpublished.RevisionID, "external_candidate": reconciled[0].RevisionID, "external_resolution": resolvedExternal.RevisionID, "direct_import": direct[0].RevisionID},
			"conflicts":  map[string]any{"stale": partial[1].ConflictID, "external": reconciled[0].ConflictID, "open_after_proof": openConflicts},
		},
		"publication":             map[string]any{"validation": validationAttempts, "commit_failure_recovery": commitAttempts, "push_failure_recovery": pushAttempts, "finalization_loss_recovery": finalizationAttempts, "remote_drift": driftAttempts, "seed_commits": []string{pubSeedA.Commit, pubSeedB.Commit}, "commit_recovery_commit": commitOK.Commit, "push_recovery_commit": pushOK.Commit, "finalization_loss_commit": finalizationOK.Commit, "finalization_remote_count_before": beforeFinalizationCount, "finalization_remote_count_after_push": afterAcceptedCount, "finalization_remote_count_after_repair": afterRepairCount, "finalization_expected_predecessor": pendingIntent.ExpectedPublished, "later_publication_commit": laterPub.Commit, "old_publication_acknowledgement": oldAcknowledgement.State, "merged_commit": mergedPub.Commit, "post_reconcile_remote_count_before": beforeMergedCount, "post_reconcile_remote_count_after": afterMergedCount},
		"git":                     map[string]any{"deterministic_author": "Songs V2 Sync Spike", "safety_controls_verified": gitSafety, "remote_head": remoteHead, "remote_commit_count": remoteCount, "seed_body_sha256": sha256Hex(seedBlob), "later_body_sha256": sha256Hex(mergedBlob), "sidecar_identity": side.DocumentID, "sidecar_revision": side.RevisionID, "sidecar_content_hash": side.ContentHash, "seed_body_byte_identical": proofs["git_body_seed_preserved"], "later_body_byte_identical": proofs["git_body_later_preserved"], "identity_not_injected_into_body": proofs["sidecar_identity_outside_body"]},
		"external_reconciliation": map[string]any{"conflict_source_commit": externalCommit, "direct_source_commit": directCommit, "conflict_result": reconciled[0].Kind, "direct_result": direct[0].Kind, "sidecar_changed_but_body_imported": sidecarClaimChanged, "published_pointer_immediately_after_reconciliation": publishedImmediatelyAfterReconcile, "published_pointer_moved_to_external_before_resolution": publishedImmediatelyAfterReconcile == reconciled[0].RevisionID, "audit_source_actor": externalActor},
		"database":                map[string]any{"integrity_check_ok": integrity, "foreign_key_check_ok": fk, "counts": counts, "audit_reconstruction": audit},
		"proofs":                  proofs,
		"limitations_and_rejected_alternatives": []string{
			"No HTTP/auth/ACL implementation: this is intentionally an internal spike.",
			"The in-process mutex is not a multi-process or distributed publication lease.",
			"No CRDT: stale lead-sheet writes preserve both revisions for explicit resolution.",
			"External deletion and rename reconciliation are outside this edit-focused spike.",
			"No production remote or canonical corpus access: Git uses ephemeral bare repositories and worktrees.",
			"The materializer validates a minimal UTF-8/NUL/H1-title contract; Apex parity is outside this spike.",
		},
		"recommendation": map[string]any{"feasible": feasible, "statement": "Feasible only with the demonstrated ledger, CAS, cursor acknowledgement, isolated Git, reconciliation, and retry invariants retained as production components."},
	}, nil
}
func eventSequences(events []Event) []int64 {
	out := make([]int64, len(events))
	for i, e := range events {
		out[i] = e.Sequence
	}
	return out
}
func sha256Hex(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
func containsBytes(a, b []byte) bool {
	for i := 0; i+len(b) <= len(a); i++ {
		if bytesEqual(a[i:i+len(b)], b) {
			return true
		}
	}
	return false
}
func CanonicalEvidence(v map[string]any) ([]byte, error) {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return nil, e
	}
	return append(b, '\n'), nil
}
