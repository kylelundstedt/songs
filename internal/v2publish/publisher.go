package v2publish

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"sync"
	"time"

	"songs.exe.dev/internal/v2sync"
)

type Options struct {
	LedgerPath string
	LockPath   string
	Remote     string
	Branch     string
	WorkRoot   string
	Sync       SyncSource
	Validator  Validator

	ValidatorOptions        ValidatorOptions
	BootstrapManifestSHA256 string
	AuthorName              string
	AuthorEmail             string
	Hooks                   Hooks
}

type Publisher struct {
	ledger            *Ledger
	git               *gitMaterializer
	syncSource        SyncSource
	syncReconciler    SyncReconciler
	syncRecorder      PublicationRecorder
	syncClaimer       PublicationClaimer
	validator         Validator
	bootstrapManifest string
	hooksMu           sync.RWMutex
	hooks             Hooks
}

func Open(options Options) (*Publisher, error) {
	if options.Sync == nil {
		return nil, codeError(CodeInvalidConfig, "publication SyncSource is required", nil)
	}
	if options.BootstrapManifestSHA256 != "" && !sha256RE.MatchString(options.BootstrapManifestSHA256) {
		return nil, codeError(CodeInvalidConfig, "bootstrap manifest trust anchor must be a lowercase SHA-256", nil)
	}
	reconciler, ok := options.Sync.(SyncReconciler)
	if !ok {
		return nil, codeError(CodeInvalidConfig, "publication SyncSource must support durable external reconciliation", nil)
	}
	recorder, ok := options.Sync.(PublicationRecorder)
	if !ok {
		return nil, codeError(CodeInvalidConfig, "publication SyncSource must support publication status events", nil)
	}
	claimer, ok := options.Sync.(PublicationClaimer)
	if !ok {
		return nil, codeError(CodeInvalidConfig, "publication SyncSource must support publication reservations", nil)
	}
	ledger, err := OpenLedger(options.LedgerPath, options.LockPath)
	if err != nil {
		return nil, err
	}
	materializer, err := newGitMaterializer(materializerOptions{
		Remote: options.Remote, Branch: options.Branch, WorkRoot: options.WorkRoot,
		AuthorName: options.AuthorName, AuthorEmail: options.AuthorEmail,
	})
	if err != nil {
		_ = ledger.Close()
		return nil, err
	}
	validator := options.Validator
	if validator == nil {
		validator, err = NewProductionValidator(options.ValidatorOptions)
		if err != nil {
			_ = ledger.Close()
			return nil, err
		}
	}
	return &Publisher{ledger: ledger, git: materializer, syncSource: options.Sync, syncReconciler: reconciler, syncRecorder: recorder, syncClaimer: claimer, validator: validator, bootstrapManifest: options.BootstrapManifestSHA256, hooks: options.Hooks}, nil
}

func (p *Publisher) Close() error    { return p.ledger.Close() }
func (p *Publisher) Ledger() *Ledger { return p.ledger }

// RemoteHead returns the fetched configured branch head without mutating the ledger.
func (p *Publisher) RemoteHead(ctx context.Context) (string, error) {
	return p.git.RemoteHead(ctx)
}

func (p *Publisher) BootstrapArchive(ctx context.Context, owner, device, holder string, documents []BootstrapDocument) error {
	if !validOwner(owner) || !validStableID(device) || !validHolder(holder) || len(documents) == 0 {
		return codeError(CodeInvalidPayload, "invalid archive bootstrap request", nil)
	}
	lease, err := p.ledger.AcquireLease(ctx, holder)
	if err != nil {
		return err
	}
	defer lease.Release()
	now := hookNow(p.currentHooks())
	head, err := p.git.RemoteHead(ctx)
	if err != nil {
		return err
	}
	base, initialized, err := p.ledger.GitBase()
	if err != nil {
		return err
	}
	if head == "" || initialized && base != head {
		return codeError(CodeRemoteDrift, "archive bootstrap requires one stable non-empty remote head", nil)
	}
	worktree, err := p.git.Checkout(ctx, "archive-bootstrap", head)
	if err != nil {
		return err
	}
	if p.bootstrapManifest == "" {
		return codeError(CodeInvalidConfig, "archive bootstrap requires a reviewed manifest trust anchor", nil)
	}
	manifestHash, err := BootstrapManifestSHA256(documents)
	if err != nil {
		return err
	}
	if manifestHash != p.bootstrapManifest {
		return codeError(CodeIntegrity, "archive bootstrap manifest does not match the reviewed trust anchor", nil)
	}
	canonicalPaths, err := walkCanonical(worktree)
	if err != nil {
		return err
	}
	suppliedPaths := make([]string, 0, len(documents))
	for _, document := range documents {
		suppliedPaths = append(suppliedPaths, document.Path)
	}
	sort.Strings(suppliedPaths)
	if !slices.Equal(canonicalPaths, suppliedPaths) {
		return codeError(CodeIntegrity, "archive bootstrap manifest does not cover the complete canonical Git tree", nil)
	}
	seen := map[string]bool{}
	for index := range documents {
		document := &documents[index]
		if seen[document.DocumentID] {
			return codeError(CodeInvalidPayload, "duplicate archive bootstrap document", nil)
		}
		seen[document.DocumentID] = true
		current, err := p.syncSource.CurrentRevision(owner, device, document.DocumentID)
		if err != nil {
			return err
		}
		payload, err := ParsePublicationPayload(current.Payload)
		if err != nil {
			return err
		}
		if current.ID != document.RevisionID || current.Title != document.Title || payload.Kind != document.Kind || payload.Path != document.Path || payload.Deleted || !bytes.Equal([]byte(payload.Source), document.Source) {
			return codeError(CodeReplayMismatch, "sync revision differs from archive bootstrap document", nil)
		}
		if conflicts, err := p.syncSource.OpenConflictCount(owner, device, document.DocumentID); err != nil {
			return err
		} else if conflicts != 0 {
			return codeError(CodeIneligible, "archive bootstrap document has open conflicts", nil)
		}
		body, exists, err := p.git.TreeBlob(ctx, worktree, head, document.Path)
		if err != nil {
			return err
		}
		if !exists || !bytes.Equal(body, document.Source) {
			return codeError(CodeIntegrity, "Git bytes differ from archive bootstrap document", nil)
		}
	}
	stableHead, err := p.git.RemoteHead(ctx)
	if err != nil {
		return err
	}
	if stableHead != head {
		return codeError(CodeRemoteDrift, "archive bootstrap remote moved during verification", nil)
	}
	if !initialized {
		if err := p.ledger.InitializeGitBase(lease.Token(), head, now); err != nil {
			return err
		}
	}
	return p.ledger.BootstrapDocuments(lease.Token(), owner, head, manifestHash, documents, now)
}

func (p *Publisher) SetHooks(hooks Hooks) {
	p.hooksMu.Lock()
	p.hooks = hooks
	p.hooksMu.Unlock()
}

func (p *Publisher) currentHooks() Hooks {
	p.hooksMu.RLock()
	defer p.hooksMu.RUnlock()
	return p.hooks
}

func hookNow(hooks Hooks) time.Time {
	if hooks.Now != nil {
		return hooks.Now().UTC()
	}
	return time.Now().UTC()
}

func (p *Publisher) ensureGitBase(ctx context.Context, token FenceToken, now time.Time) (remoteHead, ledgerBase string, err error) {
	remoteHead, err = p.git.RemoteHead(ctx)
	if err != nil {
		return "", "", err
	}
	ledgerBase, initialized, err := p.ledger.GitBase()
	if err != nil {
		return "", "", err
	}
	if !initialized {
		if err := p.ledger.InitializeGitBase(token, remoteHead, now); err != nil {
			return "", "", err
		}
		ledgerBase = remoteHead
	}
	return remoteHead, ledgerBase, nil
}

func (p *Publisher) clearPublicationClaim(intent Intent) error {
	return p.syncClaimer.ReleasePublicationClaim(intent.OwnerID, intent.DocumentID, intent.ID)
}

func (p *Publisher) recordPublicationStatus(intent Intent) error {
	_, err := p.syncRecorder.RecordPublicationService(intent.OwnerID, intent.DeviceID, intent.DocumentID, intent.RevisionID, intent.CommitHash)
	return err
}

func (p *Publisher) currentRevision(request PublishRequest) (v2sync.Revision, PublicationPayload, error) {
	revision, err := p.syncSource.CurrentRevision(request.OwnerID, request.DeviceID, request.DocumentID)
	if err != nil {
		return v2sync.Revision{}, PublicationPayload{}, err
	}
	if revision.ID != request.RevisionID || revision.DocumentID != request.DocumentID {
		return v2sync.Revision{}, PublicationPayload{}, codeError(CodeIneligible, "requested revision is not the document's current revision", nil)
	}
	payload, err := ParsePublicationPayload(revision.Payload)
	if err != nil {
		return v2sync.Revision{}, PublicationPayload{}, err
	}
	return revision, payload, nil
}

func (p *Publisher) eligible(request PublishRequest, expectedCurrent string) error {
	revision, _, err := p.currentRevision(request)
	if err != nil {
		return err
	}
	if revision.ID != expectedCurrent {
		return codeError(CodeIneligible, "current revision changed after publication intent creation", nil)
	}
	count, err := p.syncSource.OpenConflictCount(request.OwnerID, request.DeviceID, request.DocumentID)
	if err != nil {
		return err
	}
	if count != 0 {
		return codeError(CodeIneligible, fmt.Sprintf("document has %d open sync conflict(s)", count), nil)
	}
	reconciliations, err := p.ledger.OpenReconciliationCount(request.OwnerID, request.DocumentID)
	if err != nil {
		return err
	}
	if reconciliations != 0 {
		return codeError(CodeReconciliation, fmt.Sprintf("document has %d open Git reconciliation conflict(s)", reconciliations), nil)
	}
	unowned, err := p.ledger.OpenUnownedAdditionCount(request.OwnerID)
	if err != nil {
		return err
	}
	if unowned != 0 {
		return codeError(CodeReconciliation, fmt.Sprintf("archive has %d unowned canonical addition conflict(s)", unowned), nil)
	}
	return nil
}

func (p *Publisher) createIntent(ctx context.Context, token FenceToken, request PublishRequest, ledgerBase string, now time.Time) (Intent, bool, error) {
	if existing, err := p.ledger.IntentForRevision(request.OwnerID, request.DocumentID, request.RevisionID); err == nil {
		if existing.DeviceID != request.DeviceID {
			return Intent{}, true, codeError(CodeReplayMismatch, "publication revision was queued by a different device", nil)
		}
		return existing, true, nil
	} else if !IsCode(err, CodeNotFound) {
		return Intent{}, false, err
	}
	revision, payload, err := p.currentRevision(request)
	if err != nil {
		return Intent{}, false, err
	}
	if err := p.eligible(request, revision.ID); err != nil {
		return Intent{}, false, err
	}
	expectedPublished := ""
	if published, err := p.ledger.PublishedDocument(request.OwnerID, request.DocumentID); err == nil {
		expectedPublished = published.RevisionID
	} else if !IsCode(err, CodeNotFound) {
		return Intent{}, false, err
	}
	return p.ledger.CreateIntent(token, revision.Title, request.OwnerID, request.DeviceID, request.DocumentID, revision.ID, payload, revision.ID, expectedPublished, ledgerBase, now)
}

func (p *Publisher) injected(ctx context.Context, hooks Hooks, point FailurePoint, intent Intent) error {
	return invokeFailure(ctx, hooks.Failure, point, intent)
}

func (p *Publisher) Publish(ctx context.Context, request PublishRequest) (PublishResult, error) {
	if err := validatePublishRequest(request); err != nil {
		return PublishResult{}, err
	}
	lease, err := p.ledger.AcquireLease(ctx, request.Holder)
	if err != nil {
		return PublishResult{}, err
	}
	defer lease.Release()
	token := lease.Token()
	hooks := p.currentHooks()
	now := hookNow(hooks)
	remoteHead, ledgerBase, err := p.ensureGitBase(ctx, token, now)
	if err != nil {
		return PublishResult{}, err
	}
	intent, replay, err := p.createIntent(ctx, token, request, ledgerBase, now)
	if err != nil {
		return PublishResult{}, err
	}
	result := PublishResult{IntentID: intent.ID, State: intent.State, Commit: intent.CommitHash, Idempotent: replay}
	if !replay {
		if err := p.injected(ctx, hooks, FailureAfterIntent, intent); err != nil {
			return result, err
		}
	}

	// A finalized intent is immutable. Verify the remote still contains it so a
	// rewritten/deleted remote history cannot masquerade as success.
	if intent.State == IntentFinalized {
		contained, checkErr := p.git.IsRemoteAncestor(ctx, intent.CommitHash, remoteHead)
		if checkErr != nil {
			return result, checkErr
		}
		if !contained {
			return PublishResult{IntentID: intent.ID, State: IntentRemoteDrift, Commit: intent.CommitHash}, codeError(CodeRemoteDrift, "finalized publication commit is absent from remote history", nil)
		}
		if err := p.recordPublicationStatus(intent); err != nil {
			return result, err
		}
		if err := p.clearPublicationClaim(intent); err != nil {
			return result, err
		}
		result.Idempotent = true
		return result, nil
	}
	if intent.State == IntentValidationFailed || intent.State == IntentIneligible {
		if err := p.clearPublicationClaim(intent); err != nil {
			return result, err
		}
		if terminal := terminalPublicationError(intent); terminal != nil {
			return result, terminal
		}
		return result, codeError(CodeIneligible, "publication intent is terminal", nil)
	}

	// The remote may have accepted the commit before the process could finalize.
	if intent.CommitHash != "" {
		contained, checkErr := p.git.IsRemoteAncestor(ctx, intent.CommitHash, remoteHead)
		if checkErr != nil {
			return result, checkErr
		}
		if contained {
			if err := p.injected(ctx, hooks, FailureBeforeFinalize, intent); err != nil {
				return result, err
			}
			currentBase, _, baseErr := p.ledger.GitBase()
			if baseErr != nil {
				return result, baseErr
			}
			if currentBase == intent.ExpectedGitBase {
				err = p.ledger.Finalize(token, intent.ID, intent.CommitHash, hookNow(hooks))
			} else {
				err = p.ledger.AcknowledgeAncestor(token, intent.ID, intent.CommitHash, hookNow(hooks))
			}
			if err != nil {
				return result, err
			}
			intent, _ = p.ledger.Intent(intent.ID)
			if err := p.recordPublicationStatus(intent); err != nil {
				return result, err
			}
			if err := p.clearPublicationClaim(intent); err != nil {
				return result, err
			}
			result.State, result.Commit, result.Idempotent = IntentFinalized, intent.CommitHash, true
			if err := p.injected(ctx, hooks, FailureAfterFinalize, intent); err != nil {
				return result, err
			}
			return result, nil
		}
	}

	if err := p.syncClaimer.ReservePublication(intent.OwnerID, intent.DeviceID, intent.DocumentID, intent.ExpectedCurrentRevisionID, intent.ID); err != nil {
		return result, err
	}
	defer func() {
		_ = p.syncClaimer.ReleasePublicationClaim(intent.OwnerID, intent.DocumentID, intent.ID)
	}()

	if remoteHead != intent.ExpectedGitBase {
		ledgerBase, initialized, baseErr := p.ledger.GitBase()
		if baseErr != nil {
			return result, baseErr
		}
		if initialized && ledgerBase == remoteHead {
			if err := p.ledger.RebaseIntent(token, intent.ID, remoteHead, hookNow(hooks)); err != nil {
				return result, err
			}
			intent, err = p.ledger.Intent(intent.ID)
			if err != nil {
				return result, err
			}
			result.State, result.Commit = intent.State, intent.CommitHash
		} else {
			drift := codeError(CodeRemoteDrift, "remote head differs from the intent's durable expected Git base", nil)
			_ = p.ledger.RecordFailure(token, intent.ID, IntentRemoteDrift, intent.CommitHash, drift, hookNow(hooks))
			return PublishResult{IntentID: intent.ID, State: IntentRemoteDrift, Commit: intent.CommitHash}, drift
		}
	}
	if err := p.eligible(request, intent.ExpectedCurrentRevisionID); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentIneligible, intent.CommitHash, err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentIneligible, Commit: intent.CommitHash}, err
	}
	if err := p.ledger.AssertIntentPath(token, intent.ID); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentIneligible, intent.CommitHash, err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentIneligible, Commit: intent.CommitHash}, err
	}
	if err := p.injected(ctx, hooks, FailureBeforeMaterialize, intent); err != nil {
		return result, err
	}
	var prior *PublishedDocument
	if published, err := p.ledger.PublishedDocument(intent.OwnerID, intent.DocumentID); err == nil {
		prior = &published
	} else if !IsCode(err, CodeNotFound) {
		return result, err
	}
	worktree, err := p.git.Materialize(ctx, intent, prior)
	if err != nil {
		return result, err
	}
	if err := p.injected(ctx, hooks, FailureAfterMaterialize, intent); err != nil {
		return result, err
	}
	if err := p.validator.Validate(ctx, worktree, intent); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentValidationFailed, "", err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentValidationFailed}, err
	}
	if err := p.injected(ctx, hooks, FailureAfterValidation, intent); err != nil {
		return result, err
	}
	if err := p.injected(ctx, hooks, FailureBeforeCommit, intent); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentCommitFailed, "", err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentCommitFailed}, err
	}
	commit, err := p.git.DeterministicCommit(ctx, worktree, intent)
	if err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentCommitFailed, "", err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentCommitFailed}, err
	}
	if intent.CommitHash != "" && intent.CommitHash != commit {
		mismatch := codeError(CodeIntegrity, "rebuilt deterministic commit differs from durable commit", nil)
		_ = p.ledger.RecordFailure(token, intent.ID, IntentCommitFailed, intent.CommitHash, mismatch, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentCommitFailed, Commit: intent.CommitHash}, mismatch
	}
	if err := p.ledger.MarkCommitted(token, intent.ID, commit, hookNow(hooks)); err != nil {
		return result, err
	}
	intent, _ = p.ledger.Intent(intent.ID)
	result = PublishResult{IntentID: intent.ID, State: IntentCommitted, Commit: commit}
	if err := p.injected(ctx, hooks, FailureAfterCommit, intent); err != nil {
		return result, err
	}
	if err := p.eligible(request, intent.ExpectedCurrentRevisionID); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentIneligible, commit, err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentIneligible, Commit: commit}, err
	}
	if err := p.ledger.AssertIntentPath(token, intent.ID); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentIneligible, commit, err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentIneligible, Commit: commit}, err
	}
	if err := p.ledger.AssertFence(token); err != nil {
		return result, err
	}
	if err := p.injected(ctx, hooks, FailureBeforePush, intent); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentCommitted, commit, err, hookNow(hooks))
		return result, err
	}
	// Re-read eligibility after all pre-push hooks/work so a revision changed by
	// another sync writer during materialization is not knowingly pushed.
	if err := p.eligible(request, intent.ExpectedCurrentRevisionID); err != nil {
		_ = p.ledger.RecordFailure(token, intent.ID, IntentIneligible, commit, err, hookNow(hooks))
		return PublishResult{IntentID: intent.ID, State: IntentIneligible, Commit: commit}, err
	}
	if err := p.git.PushCAS(ctx, worktree, commit, intent.ExpectedGitBase); err != nil {
		// A transport error can be ambiguous. Observe the remote before deciding
		// whether the CAS was rejected or accepted.
		observed, observeErr := p.git.RemoteHead(ctx)
		if observeErr == nil {
			contained, ancestorErr := p.git.IsRemoteAncestor(ctx, commit, observed)
			if ancestorErr == nil && contained {
				remoteHead = observed
				goto finalize
			}
		}
		_ = p.ledger.RecordFailure(token, intent.ID, IntentCommitted, commit, err, hookNow(hooks))
		return result, err
	}
	remoteHead = commit
	if err := p.injected(ctx, hooks, FailureAfterPush, intent); err != nil {
		return result, err
	}

finalize:
	if remoteHead != commit {
		contained, checkErr := p.git.IsRemoteAncestor(ctx, commit, remoteHead)
		if checkErr != nil || !contained {
			if checkErr != nil {
				return result, checkErr
			}
			return result, codeError(CodeRemoteDrift, "pushed commit is absent from observed remote history", nil)
		}
	}
	if err := p.injected(ctx, hooks, FailureBeforeFinalize, intent); err != nil {
		return result, err
	}
	if err := p.ledger.Finalize(token, intent.ID, commit, hookNow(hooks)); err != nil {
		return result, err
	}
	intent, _ = p.ledger.Intent(intent.ID)
	if err := p.recordPublicationStatus(intent); err != nil {
		return result, err
	}
	if err := p.clearPublicationClaim(intent); err != nil {
		return result, err
	}
	result.State, result.Idempotent = IntentFinalized, replay
	if err := p.injected(ctx, hooks, FailureAfterFinalize, intent); err != nil {
		return result, err
	}
	return result, nil
}

// Recover is an explicit spelling for retrying the same immutable revision.
func (p *Publisher) Recover(ctx context.Context, request PublishRequest) (PublishResult, error) {
	return p.Publish(ctx, request)
}

func (p *Publisher) Integrity(ctx context.Context, holders ...string) error {
	holder := "integrity-worker"
	if len(holders) > 1 || len(holders) == 1 && !validHolder(holders[0]) {
		return codeError(CodeInvalidPayload, "invalid integrity lease holder", nil)
	}
	if len(holders) == 1 {
		holder = holders[0]
	}
	lease, err := p.ledger.AcquireLease(ctx, holder)
	if err != nil {
		return err
	}
	defer lease.Release()
	if err := p.ledger.Integrity(); err != nil {
		return err
	}
	if err := p.git.Integrity(ctx); err != nil {
		return codeError(CodeIntegrity, "Git integrity check failed", err)
	}
	base, initialized, err := p.ledger.GitBase()
	if err != nil || !initialized {
		if err != nil {
			return err
		}
		return codeError(CodeIntegrity, "publication Git base is not initialized", nil)
	}
	if base != "" {
		head, err := p.git.RemoteHead(ctx)
		if err != nil {
			return err
		}
		contained, err := p.git.IsRemoteAncestor(ctx, base, head)
		if err != nil {
			return err
		}
		if !contained {
			return codeError(CodeIntegrity, "durable publication base is absent from remote history", nil)
		}
	}
	return nil
}

func terminalPublicationError(intent Intent) error {
	if intent.LastError == "" {
		return nil
	}
	if intent.State == IntentValidationFailed {
		return codeError(CodeValidation, intent.LastError, nil)
	}
	if intent.State == IntentRemoteDrift {
		return codeError(CodeRemoteDrift, intent.LastError, nil)
	}
	if intent.State == IntentIneligible {
		return codeError(CodeIneligible, intent.LastError, nil)
	}
	return errors.New(intent.LastError)
}
