package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"songs.exe.dev/internal/v2publish"
)

func runEvidence() (evidence, error) {
	var result evidence
	result.SchemaVersion = "1.0"
	result.Task = "TASK-018"
	result.Execution.TemporarySQLite = true
	result.Execution.IsolatedBareGit = true
	result.Execution.CanonicalJSON = true

	realApex, err := exec.LookPath("apex")
	if err != nil {
		return result, fmt.Errorf("locate real Apex: %w", err)
	}
	root, err := os.MkdirTemp("", "songs-v2-publication-evidence-")
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(root)

	steps := []func(string, string, *evidence) error{
		runLeaseFencing,
		runIntentBeforeGit,
		runValidation,
		runDeterministicPublication,
		runCrashRecovery,
		runExpectedBaseCAS,
		runExternalReconciliation,
		runUnownedAddition,
		runBackupRestore,
		runDeploymentGuard,
	}
	for _, step := range steps {
		if err := step(root, realApex, &result); err != nil {
			return result, err
		}
	}
	result.Execution.RealApexValidPublication = result.Validation.RealApexInvoked
	result.Acceptance.AllPassed = true
	return result, nil
}

func runLeaseFencing(root, _ string, result *evidence) error {
	path := filepath.Join(root, "lease", "publication.sqlite")
	lock := filepath.Join(root, "lease", "publication.lock")
	first, err := v2publish.OpenLedger(path, lock)
	if err != nil {
		return fmt.Errorf("open first lease ledger: %w", err)
	}
	defer first.Close()
	second, err := v2publish.OpenLedger(path, lock)
	if err != nil {
		return fmt.Errorf("open second lease ledger: %w", err)
	}
	defer second.Close()
	leaseA, err := first.AcquireLease(context.Background(), "instance-a")
	if err != nil {
		return err
	}
	stale := leaseA.Token()
	ctx, cancel := contextWithBriefTimeout()
	_, busyErr := second.AcquireLease(ctx, "instance-b")
	cancel()
	if err := require(v2publish.IsCode(busyErr, v2publish.CodeLeaseBusy), "second ledger instance was not excluded by flock"); err != nil {
		_ = leaseA.Release()
		return err
	}
	if err := leaseA.Release(); err != nil {
		return err
	}
	leaseB, err := second.AcquireLease(context.Background(), "instance-b")
	if err != nil {
		return err
	}
	defer leaseB.Release()
	advanced := leaseB.Token().Epoch == stale.Epoch && leaseB.Token().Generation > stale.Generation && leaseB.Token().Holder != stale.Holder
	if err := require(advanced, "durable fence generation did not advance"); err != nil {
		return err
	}
	staleErr := first.AssertFence(stale)
	if err := require(v2publish.IsCode(staleErr, v2publish.CodeStaleFence), "superseded publication fence remained usable"); err != nil {
		return err
	}
	result.LeaseFencing.CrossInstanceBusyCode = publishCode(busyErr)
	result.LeaseFencing.GenerationAdvanced = advanced
	result.LeaseFencing.StaleFenceCode = publishCode(staleErr)
	return nil
}

func runIntentBeforeGit(root, apex string, result *evidence) error {
	h, err := newHarness(root, "intent-before-git", apex, v2publish.Hooks{})
	if err != nil {
		return err
	}
	defer h.close()
	outcome, err := applyRevision(h.store, "intent-operation", "intent-song", "Intent Song", "", leadPayload("songs/Intent-Song.md", "Intent Song", "Body"))
	if err != nil {
		return err
	}
	before, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	worktreeAbsent := false
	h.publisher.SetHooks(v2publish.Hooks{
		Now: func() time.Time { return fixedNow },
		Failure: func(point v2publish.FailurePoint, intent v2publish.Intent) error {
			if point != v2publish.FailureAfterIntent {
				return nil
			}
			_, statErr := os.Stat(filepath.Join(h.workRoot, "intents", intent.ID))
			worktreeAbsent = os.IsNotExist(statErr)
			return errors.New("stop after durable intent")
		},
	})
	published, publishErr := h.publisher.Publish(context.Background(), publishRequest("intent-song", outcome.RevisionID, "intent-worker"))
	if err := require(v2publish.IsCode(publishErr, v2publish.CodeInjectedFailure), "after-intent stop was not observed"); err != nil {
		return err
	}
	intent, err := h.publisher.Ledger().Intent(published.IntentID)
	if err != nil {
		return err
	}
	head, err := remoteHead(h.remote)
	if err != nil {
		return err
	}
	after, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	checks := []struct {
		ok      bool
		message string
	}{
		{intent.State == v2publish.IntentQueued, "intent was not durably queued"},
		{intent.ExpectedCurrentRevisionID == outcome.RevisionID, "intent omitted expected current revision"},
		{intent.ExpectedGitBase == head, "intent omitted expected Git base"},
		{intent.ExpectedPublishedRevisionID == "", "first intent did not record empty prior publication"},
		{intent.CommitHash == "", "intent unexpectedly had a commit"},
		{worktreeAbsent, "Git worktree existed before the after-intent boundary"},
		{after == before, "remote changed before materialization"},
	}
	for _, check := range checks {
		if err := require(check.ok, check.message); err != nil {
			return err
		}
	}
	result.IntentBeforeGit.FailurePoint = string(v2publish.FailureAfterIntent)
	result.IntentBeforeGit.DurableState = string(intent.State)
	result.IntentBeforeGit.ExpectedCurrentRecorded = true
	result.IntentBeforeGit.ExpectedBaseRecorded = true
	result.IntentBeforeGit.PriorPublicationRecorded = true
	result.IntentBeforeGit.CommitAbsent = true
	result.IntentBeforeGit.WorktreeAbsent = true
	result.IntentBeforeGit.RemoteCommitDelta = after - before
	return nil
}

func runValidation(root, realApex string, result *evidence) error {
	failing, err := failingApex(filepath.Join(root, "validation-apex-program"))
	if err != nil {
		return err
	}
	cases := []struct {
		name, document, title, apex string
		payload                     v2publish.PublicationPayload
	}{
		{
			name: "schema", document: "schema-song", title: "Schema Song", apex: realApex,
			payload: v2publish.PublicationPayload{SchemaVersion: v2publish.PayloadSchemaVersion, Kind: v2publish.LeadSheet, Path: "songs/Schema-Song.md", Source: "---\nschema_version: 2\nid: schema-song\n---\n\n# Schema Song\n\nBody\n"},
		},
		{
			name: "identity", document: "identity-set", title: "Identity Set", apex: realApex,
			payload: v2publish.PublicationPayload{SchemaVersion: v2publish.PayloadSchemaVersion, Kind: v2publish.SetList, Path: "sets/Identity-Set.md", Source: "---\nschema_version: 1\nid: another-set\ntitle: Identity Set\n---\n\n# Identity Set\n\n## Set One\n"},
		},
		{
			name: "link", document: "link-song", title: "Link Song", apex: realApex,
			payload: v2publish.PublicationPayload{SchemaVersion: v2publish.PayloadSchemaVersion, Kind: v2publish.LeadSheet, Path: "songs/Link-Song.md", Source: "# Link Song\n\n[Missing](Missing.md)\n"},
		},
		{
			name: "apex", document: "apex-song", title: "Apex Song", apex: failing,
			payload: leadPayload("songs/Apex-Song.md", "Apex Song", "Body"),
		},
	}
	for index, item := range cases {
		h, err := newHarness(root, "validation-"+item.name, item.apex, v2publish.Hooks{})
		if err != nil {
			return err
		}
		outcome, applyErr := applyRevision(h.store, fmt.Sprintf("validation-operation-%d", index+1), item.document, item.title, "", item.payload)
		if applyErr != nil {
			_ = h.close()
			return applyErr
		}
		before, countErr := remoteCount(h.remote)
		if countErr != nil {
			_ = h.close()
			return countErr
		}
		publication, publishErr := h.publisher.Publish(context.Background(), publishRequest(item.document, outcome.RevisionID, "validation-worker"))
		after, countErr := remoteCount(h.remote)
		if countErr != nil {
			_ = h.close()
			return countErr
		}
		intent, intentErr := h.publisher.Ledger().Intent(publication.IntentID)
		if intentErr != nil {
			_ = h.close()
			return intentErr
		}
		if err := require(v2publish.IsCode(publishErr, v2publish.CodeValidation) && publication.State == v2publish.IntentValidationFailed, item.name+" validation did not fail closed"); err != nil {
			_ = h.close()
			return err
		}
		if err := require(after == before && intent.CommitHash == "", item.name+" validation created a commit"); err != nil {
			_ = h.close()
			return err
		}
		result.Validation.Cases = append(result.Validation.Cases, validationCase{
			Case: item.name, ErrorCode: publishCode(publishErr), State: string(publication.State),
			RemoteCommitDelta: after - before, CommitAbsent: intent.CommitHash == "",
		})
		if err := h.close(); err != nil {
			return err
		}
	}

	observerRoot := filepath.Join(root, "validation-real-apex-program")
	if err := os.MkdirAll(observerRoot, 0o700); err != nil {
		return err
	}
	observer, marker, err := observingApex(observerRoot, realApex)
	if err != nil {
		return err
	}
	h, err := newHarness(root, "validation-valid", observer, v2publish.Hooks{})
	if err != nil {
		return err
	}
	defer h.close()
	outcome, err := applyRevision(h.store, "validation-valid-operation", "valid-song", "Valid Song", "", leadPayload("songs/Valid-Song.md", "Valid Song", "Body"))
	if err != nil {
		return err
	}
	before, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	publication, err := h.publisher.Publish(context.Background(), publishRequest("valid-song", outcome.RevisionID, "valid-worker"))
	if err != nil {
		return fmt.Errorf("valid real-Apex publication: %w", err)
	}
	after, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	_, markerErr := os.Stat(marker)
	if err := require(publication.State == v2publish.IntentFinalized && after == before+1 && markerErr == nil, "valid publication did not pass through real Apex and finalize"); err != nil {
		return err
	}
	cursorBefore, err := h.store.DeviceCursor(ownerID, deviceID)
	if err != nil {
		return err
	}
	replayed, err := h.publisher.Publish(context.Background(), publishRequest("valid-song", outcome.RevisionID, "valid-worker"))
	if err != nil || !replayed.Idempotent {
		return fmt.Errorf("replay finalized publication: %+v %w", replayed, err)
	}
	page, err := h.store.Pull(ownerID, deviceID, outcome.Sequence, 10)
	if err != nil {
		return err
	}
	cursorAfterPull, err := h.store.DeviceCursor(ownerID, deviceID)
	if err != nil {
		return err
	}
	publicationEvents := 0
	eventKind := ""
	for _, event := range page.Events {
		if event.Kind == "published" && event.RevisionID == outcome.RevisionID {
			publicationEvents++
			eventKind = event.Kind
		}
	}
	if err := require(publicationEvents == 1 && cursorBefore == cursorAfterPull, "publication pull/ack separation failed"); err != nil {
		return err
	}
	if err := h.store.Ack(ownerID, deviceID, page.Cursor); err != nil {
		return err
	}
	cursorAfterAck, err := h.store.DeviceCursor(ownerID, deviceID)
	if err != nil {
		return err
	}
	result.Validation.ValidPublicationState = string(publication.State)
	result.Validation.ValidRemoteDelta = after - before
	result.Validation.RealApexInvoked = markerErr == nil
	result.ClientAcknowledgement.PublicationEventPulled = publicationEvents == 1
	result.ClientAcknowledgement.EventKind = eventKind
	result.ClientAcknowledgement.PullDidNotAcknowledge = cursorAfterPull == cursorBefore
	result.ClientAcknowledgement.ExplicitAckAdvanced = cursorAfterAck == page.Cursor && page.Cursor > cursorBefore
	result.ClientAcknowledgement.ReplayDidNotDuplicate = len(page.Events) == 1
	return nil
}

func runOneDeterministic(root, name, apex string) (commit, tree, state string, delta int, err error) {
	h, err := newHarness(root, name, apex, v2publish.Hooks{})
	if err != nil {
		return "", "", "", 0, err
	}
	defer h.close()
	outcome, err := applyRevision(h.store, "deterministic-operation", "deterministic-song", "Deterministic Song", "", leadPayload("songs/Deterministic-Song.md", "Deterministic Song", "Body"))
	if err != nil {
		return "", "", "", 0, err
	}
	before, err := remoteCount(h.remote)
	if err != nil {
		return "", "", "", 0, err
	}
	publication, err := h.publisher.Publish(context.Background(), publishRequest("deterministic-song", outcome.RevisionID, "deterministic-worker"))
	if err != nil {
		return "", "", "", 0, err
	}
	after, err := remoteCount(h.remote)
	if err != nil {
		return "", "", "", 0, err
	}
	tree, err = commitTree(h.remote, publication.Commit)
	return publication.Commit, tree, string(publication.State), after - before, err
}

func runDeterministicPublication(root, apex string, result *evidence) error {
	commitA, treeA, stateA, deltaA, err := runOneDeterministic(root, "deterministic-a", apex)
	if err != nil {
		return err
	}
	commitB, treeB, stateB, deltaB, err := runOneDeterministic(root, "deterministic-b", apex)
	if err != nil {
		return err
	}
	if err := require(commitA != "" && commitA == commitB, "independent deterministic publications created different commits"); err != nil {
		return err
	}
	if err := require(treeA != "" && treeA == treeB, "independent deterministic publications created different trees"); err != nil {
		return err
	}
	if err := require(stateA == string(v2publish.IntentFinalized) && stateB == stateA && deltaA == 1 && deltaB == 1, "deterministic publications did not both finalize once"); err != nil {
		return err
	}
	result.DeterministicPublication.IndependentCommitIdentityEqual = true
	result.DeterministicPublication.IndependentTreeIdentityEqual = true
	result.DeterministicPublication.RemoteCommitDeltaEach = 1
	result.DeterministicPublication.FinalStateEach = stateA
	return nil
}

func runCrashRecovery(root, apex string, result *evidence) error {
	points := []v2publish.FailurePoint{
		v2publish.FailureAfterCommit,
		v2publish.FailureAfterPush,
		v2publish.FailureAfterFinalize,
	}
	for index, point := range points {
		h, err := newHarness(root, "crash-"+string(point), apex, v2publish.Hooks{})
		if err != nil {
			return err
		}
		outcome, applyErr := applyRevision(h.store, fmt.Sprintf("crash-operation-%d", index+1), fmt.Sprintf("crash-song-%d", index+1), "Crash Song", "", leadPayload(fmt.Sprintf("songs/Crash-Song-%d.md", index+1), "Crash Song", "Body"))
		if applyErr != nil {
			_ = h.close()
			return applyErr
		}
		fired := false
		h.publisher.SetHooks(v2publish.Hooks{
			Now: func() time.Time { return fixedNow },
			Failure: func(observed v2publish.FailurePoint, _ v2publish.Intent) error {
				if observed == point && !fired {
					fired = true
					return errors.New("simulated process loss")
				}
				return nil
			},
		})
		request := publishRequest(fmt.Sprintf("crash-song-%d", index+1), outcome.RevisionID, "crash-worker")
		before, err := remoteCount(h.remote)
		if err != nil {
			_ = h.close()
			return err
		}
		first, firstErr := h.publisher.Publish(context.Background(), request)
		atFailure, err := remoteCount(h.remote)
		if err != nil {
			_ = h.close()
			return err
		}
		if err := require(v2publish.IsCode(firstErr, v2publish.CodeInjectedFailure) && fired && first.Commit != "", "crash boundary was not reached at "+string(point)); err != nil {
			_ = h.close()
			return err
		}
		h.publisher.SetHooks(v2publish.Hooks{Now: func() time.Time { return fixedNow }})
		recovered, err := h.publisher.Recover(context.Background(), request)
		if err != nil {
			_ = h.close()
			return fmt.Errorf("recover %s: %w", point, err)
		}
		after, err := remoteCount(h.remote)
		if err != nil {
			_ = h.close()
			return err
		}
		repeated, err := h.publisher.Recover(context.Background(), request)
		if err != nil {
			_ = h.close()
			return err
		}
		intent, err := h.publisher.Ledger().Intent(first.IntentID)
		if err != nil {
			_ = h.close()
			return err
		}
		if err := require(recovered.State == v2publish.IntentFinalized && intent.State == v2publish.IntentFinalized && recovered.Commit == first.Commit && repeated.Idempotent && repeated.Commit == first.Commit && after == before+1, "crash recovery did not converge at "+string(point)); err != nil {
			_ = h.close()
			return err
		}
		result.CrashRecovery = append(result.CrashRecovery, crashCase{
			FailurePoint: string(point), StateAtFailure: string(first.State),
			RemoteCommitDeltaAtFailure: atFailure - before, FinalState: string(intent.State),
			RemoteCommitDeltaFinal: after - before, SameCommitIdentity: recovered.Commit == first.Commit,
			RepeatedRetryIdempotent: repeated.Idempotent,
		})
		if err := h.close(); err != nil {
			return err
		}
	}
	return nil
}

func runExpectedBaseCAS(root, apex string, result *evidence) error {
	h, err := newHarness(root, "expected-base-cas", apex, v2publish.Hooks{})
	if err != nil {
		return err
	}
	defer h.close()
	outcome, err := applyRevision(h.store, "cas-operation", "cas-song", "CAS Song", "", leadPayload("songs/CAS-Song.md", "CAS Song", "Body"))
	if err != nil {
		return err
	}
	before, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	external := ""
	h.publisher.SetHooks(v2publish.Hooks{
		Now: func() time.Time { return fixedNow },
		Failure: func(point v2publish.FailurePoint, _ v2publish.Intent) error {
			if point != v2publish.FailureBeforePush || external != "" {
				return nil
			}
			var commitErr error
			external, commitErr = externalCommit(h.root, h.remote, "cas-drift", func(clone string) error {
				return writeFile(clone, "README.md", "external change wins\n")
			})
			return commitErr
		},
	})
	request := publishRequest("cas-song", outcome.RevisionID, "cas-worker")
	first, firstErr := h.publisher.Publish(context.Background(), request)
	afterCAS, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	headAfterCAS, err := remoteHead(h.remote)
	if err != nil {
		return err
	}
	if err := require(v2publish.IsCode(firstErr, v2publish.CodeCASFailed) && first.State == v2publish.IntentCommitted && external != "" && headAfterCAS == external && afterCAS == before+1, "expected-base CAS did not preserve external drift"); err != nil {
		return err
	}
	h.publisher.SetHooks(v2publish.Hooks{Now: func() time.Time { return fixedNow }})
	observed, observedErr := h.publisher.Recover(context.Background(), request)
	finalHead, err := remoteHead(h.remote)
	if err != nil {
		return err
	}
	if err := require(v2publish.IsCode(observedErr, v2publish.CodeRemoteDrift) && observed.State == v2publish.IntentRemoteDrift && finalHead == external, "post-CAS recovery did not report durable remote drift"); err != nil {
		return err
	}
	result.ExpectedBaseCAS.ExternalChangeAccepted = true
	result.ExpectedBaseCAS.InitialErrorCode = publishCode(firstErr)
	result.ExpectedBaseCAS.StateAfterObservation = string(observed.State)
	result.ExpectedBaseCAS.PublisherDidNotOverwrite = finalHead == external
	result.ExpectedBaseCAS.RemoteCommitDelta = afterCAS - before
	return nil
}
