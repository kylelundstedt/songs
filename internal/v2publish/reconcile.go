package v2publish

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"songs.exe.dev/internal/v2sync"
)

type externalValidator interface {
	ValidateExternal(ctx context.Context, worktree string, intent Intent) error
}

type sidecarLocator struct {
	SchemaVersion string       `json:"schema_version"`
	OwnerID       string       `json:"owner_id"`
	DocumentID    string       `json:"document_id"`
	Kind          DocumentKind `json:"kind"`
	Path          string       `json:"path"`
	// RevisionID and SourceSHA256 are deliberately decoded but never trusted.
	RevisionID   json.RawMessage `json:"revision_id"`
	SourceSHA256 json.RawMessage `json:"source_sha256"`
	Deleted      json.RawMessage `json:"deleted"`
}

func externalLocator(raw []byte, published PublishedDocument) (string, error) {
	var locator sidecarLocator
	if err := json.Unmarshal(raw, &locator); err != nil {
		return "", fmt.Errorf("decode external identity sidecar: %w", err)
	}
	if locator.SchemaVersion != "" && locator.SchemaVersion != SidecarSchemaVersion {
		return "", errors.New("external identity sidecar schema changed")
	}
	if locator.OwnerID != "" && locator.OwnerID != published.OwnerID {
		return "", errors.New("external identity sidecar owner changed")
	}
	if locator.DocumentID != "" && locator.DocumentID != published.DocumentID {
		return "", errors.New("external identity sidecar document identity changed")
	}
	if locator.Kind != "" && locator.Kind != published.Kind {
		return "", errors.New("external identity sidecar document kind changed")
	}
	if locator.Path == "" {
		return "", nil
	}
	if err := ValidatePublicationPath(published.Kind, locator.Path); err != nil {
		return "", fmt.Errorf("external identity sidecar path: %w", err)
	}
	return locator.Path, nil
}

func (p *Publisher) validateExternal(ctx context.Context, worktree string, intent Intent) error {
	if validator, ok := p.validator.(externalValidator); ok {
		return validator.ValidateExternal(ctx, worktree, intent)
	}
	if err := validateDocumentSource(intent); err != nil {
		return codeError(CodeValidation, "external schema or identity validation failed", err)
	}
	if err := validateCorpus(worktree); err != nil {
		return codeError(CodeValidation, "external link or corpus validation failed", err)
	}
	return nil
}

func (p *Publisher) recoverRemoteAcceptedIntents(ctx context.Context, token FenceToken, owner, head string, now time.Time) (string, error) {
	base, _, err := p.ledger.GitBase()
	if err != nil {
		return "", err
	}
	intents, err := p.ledger.CommittedIntents(owner)
	if err != nil {
		return "", err
	}
	for {
		advanced := false
		for _, intent := range intents {
			if intent.ExpectedGitBase != base || intent.CommitHash == "" {
				continue
			}
			contained, err := p.git.IsRemoteAncestor(ctx, intent.CommitHash, head)
			if err != nil {
				return "", err
			}
			if !contained {
				continue
			}
			if err := p.ledger.Finalize(token, intent.ID, intent.CommitHash, now); err != nil {
				return "", err
			}
			finalized, err := p.ledger.Intent(intent.ID)
			if err != nil {
				return "", err
			}
			if err := p.recordPublicationStatus(finalized); err != nil {
				return "", err
			}
			if err := p.clearPublicationClaim(finalized); err != nil {
				return "", err
			}
			base = intent.CommitHash
			advanced = true
			break
		}
		if !advanced {
			return base, nil
		}
	}
}

func publishedKind(documents []PublishedDocument, documentID string) DocumentKind {
	for _, document := range documents {
		if document.DocumentID == documentID {
			return document.Kind
		}
	}
	return ""
}

func publishedTitle(documents []PublishedDocument, documentID string) string {
	for _, document := range documents {
		if document.DocumentID == documentID {
			return document.Title
		}
	}
	return ""
}

// Reconcile compares actual body/path bytes at the remote head with the
// publication ledger's last durable bytes. Sidecar revision/hash/deleted claims
// do not participate in equality or candidate identity.
func (p *Publisher) Reconcile(ctx context.Context, request ReconcileRequest) ([]Reconciliation, error) {
	if !validOwner(request.OwnerID) || !validStableID(request.DeviceID) || !validHolder(request.Holder) || len(request.Actor) > 255 || strings.ContainsRune(request.Actor, 0) {
		return nil, codeError(CodeInvalidPayload, "invalid reconciliation request", nil)
	}
	lease, err := p.ledger.AcquireLease(ctx, request.Holder)
	if err != nil {
		return nil, err
	}
	defer lease.Release()
	token := lease.Token()
	hooks := p.currentHooks()
	now := hookNow(hooks)
	head, base, err := p.ensureGitBase(ctx, token, now)
	if err != nil {
		return nil, err
	}
	base, err = p.recoverRemoteAcceptedIntents(ctx, token, request.OwnerID, head, now)
	if err != nil {
		return nil, err
	}
	if head == base {
		return nil, nil
	}
	if base != "" {
		ancestor, err := p.git.IsRemoteAncestor(ctx, base, head)
		if err != nil {
			return nil, err
		}
		if !ancestor {
			return nil, codeError(CodeRemoteDrift, "remote history no longer descends from the durable publication base", nil)
		}
	}
	worktree, err := p.git.Checkout(ctx, "reconcile", head)
	if err != nil {
		return nil, err
	}
	actor := strings.TrimSpace(request.Actor)
	if actor == "" {
		actor, err = p.git.CommitActor(ctx, worktree, head)
		if err != nil {
			return nil, err
		}
	}
	published, err := p.ledger.PublishedDocuments(request.OwnerID)
	if err != nil {
		return nil, err
	}
	addedPaths, err := p.git.AddedPaths(ctx, worktree, base, head)
	if err != nil {
		return nil, err
	}
	addedSet := make(map[string]bool, len(addedPaths))
	for _, added := range addedPaths {
		addedSet[added] = true
	}
	ownedPaths := make(map[string]string, len(published))
	for _, document := range published {
		ownedPaths[document.Path] = document.DocumentID
	}
	usedAdded := map[string]bool{}
	var records []Reconciliation
	for _, prior := range published {
		locatorPath := ""
		locatorProblem := ""
		if raw, exists, err := p.git.TreeBlob(ctx, worktree, head, sidecarPath(prior.DocumentID)); err != nil {
			return nil, err
		} else if exists {
			locatorPath, err = externalLocator(raw, prior)
			if err != nil {
				locatorProblem = err.Error()
				locatorPath = ""
			}
		}

		candidatePath := prior.Path
		candidateSource, oldExists, err := p.git.TreeBlob(ctx, worktree, head, prior.Path)
		if err != nil {
			return nil, err
		}
		candidateExists := oldExists
		if !oldExists && locatorPath != "" && locatorPath != prior.Path {
			if err := ValidatePublicationPath(prior.Kind, locatorPath); err != nil {
				return nil, fmt.Errorf("external Git rename is unsafe: %w", err)
			}
			if owner, occupied := ownedPaths[locatorPath]; occupied && owner != prior.DocumentID {
				return nil, codeError(CodeReconciliation, "external sidecar path points at another durable document", nil)
			}
			candidatePath = locatorPath
			candidateSource, candidateExists, err = p.git.TreeBlob(ctx, worktree, head, candidatePath)
			if err != nil {
				return nil, err
			}
		}
		deleted := !candidateExists
		if candidateExists && addedSet[candidatePath] {
			usedAdded[candidatePath] = true
		}
		if deleted {
			candidateSource = []byte{}
		}
		if prior.Deleted == deleted && prior.Path == candidatePath && bytes.Equal(prior.Source, candidateSource) {
			if locatorProblem != "" {
				return nil, codeError(CodeReconciliation, "external identity sidecar is corrupt even though body bytes are unchanged", errors.New(locatorProblem))
			}
			continue
		}
		kind := ReconcileEdit
		if deleted {
			kind = ReconcileDelete
		} else if prior.Path != candidatePath && bytes.Equal(prior.Source, candidateSource) {
			kind = ReconcileRename
		} else if prior.Path != candidatePath {
			kind = ReconcileRenameEdit
		}
		currentID := ""
		current, err := p.syncSource.CurrentRevision(request.OwnerID, request.DeviceID, prior.DocumentID)
		if err == nil {
			currentID = current.ID
		} else if !v2sync.IsCode(err, "NOT_FOUND") {
			return nil, err
		}
		candidateRevision := externalRevisionID(request.OwnerID, prior.DocumentID, head, candidatePath, deleted, candidateSource)
		record := Reconciliation{
			ID: reconciliationID(request.OwnerID, prior.DocumentID, head), ConflictID: reconciliationConflictID(request.OwnerID, prior.DocumentID, head),
			OwnerID: request.OwnerID, DocumentID: prior.DocumentID, Kind: kind, SourceCommit: head, Actor: actor,
			PriorPublishedRevisionID: prior.RevisionID, CurrentRevisionID: currentID, CandidateRevisionID: candidateRevision,
			PriorPath: prior.Path, CandidatePath: candidatePath, CandidateSource: append([]byte{}, candidateSource...),
			CandidateSourceSHA256: sourceHash(candidateSource), CandidateDeleted: deleted, Status: "open", DetectedUnix: now.Unix(),
		}
		candidateIntent := Intent{
			OwnerID: request.OwnerID, DeviceID: request.DeviceID, DocumentID: prior.DocumentID,
			RevisionID: candidateRevision, Title: prior.Title,
			Payload:      PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: prior.Kind, Path: candidatePath, Source: string(candidateSource), Deleted: deleted},
			SourceSHA256: record.CandidateSourceSHA256,
		}
		if locatorProblem != "" {
			record.ValidationError = locatorProblem
		}
		if validationErr := p.validateExternal(ctx, worktree, candidateIntent); validationErr != nil {
			if record.ValidationError != "" {
				record.ValidationError += "; "
			}
			record.ValidationError += validationErr.Error()
		}
		record.CandidateSource = append([]byte{}, candidateSource...)
		record.CandidateSourceSHA256 = sourceHash(candidateSource)
		record.CandidateDeleted = deleted
		record.DetectedUnix = now.Unix()
		record.SourceCommit = head
		record.Actor = actor
		record.PriorPath = prior.Path
		record.CandidatePath = candidatePath
		record.PriorPublishedRevisionID = prior.RevisionID
		record.CurrentRevisionID = currentID
		record.Kind = kind
		record.OwnerID = request.OwnerID
		record.DocumentID = prior.DocumentID
		record.ID = reconciliationID(request.OwnerID, prior.DocumentID, head)
		if record.ConflictID == "" {
			record.ConflictID = reconciliationConflictID(request.OwnerID, prior.DocumentID, head)
		}
		records = append(records, record)
	}
	var additions []UnownedAddition
	for _, added := range addedPaths {
		if usedAdded[added] {
			continue
		}
		kind := LeadSheet
		if strings.HasPrefix(added, "sets/") {
			kind = SetList
		}
		if err := ValidatePublicationPath(kind, added); err != nil {
			return records, codeError(CodeReconciliation, "external canonical addition has an unsafe path: "+added, err)
		}
		source, exists, err := p.git.TreeBlob(ctx, worktree, head, added)
		if err != nil {
			return records, err
		}
		if !exists || len(source) == 0 {
			return records, codeError(CodeReconciliation, "external canonical addition is not a non-empty regular blob: "+added, nil)
		}
		additions = append(additions, UnownedAddition{
			ID: unownedAdditionID(request.OwnerID, head, added, source), OwnerID: request.OwnerID,
			SourceCommit: head, Kind: kind, Path: added, Source: append([]byte{}, source...),
			SourceSHA256: sourceHash(source), Status: "open", DetectedUnix: now.Unix(),
		})
	}
	if len(additions) != 0 {
		if err := p.ledger.RecordBlockedReconciliation(token, request.OwnerID, base, head, records, additions, now); err != nil {
			return records, err
		}
		return records, codeError(CodeReconciliation, fmt.Sprintf("external Git transition contains %d unowned canonical addition(s)", len(additions)), nil)
	}
	for index := range records {
		record := &records[index]
		if record.ValidationError != "" || record.CurrentRevisionID == "" {
			continue
		}
		payload := PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: publishedKind(published, record.DocumentID), Path: record.CandidatePath, Source: string(record.CandidateSource), Deleted: record.CandidateDeleted}
		rawPayload, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		payloadHash, canonicalPayload, err := v2sync.HashPayload(rawPayload)
		if err != nil {
			return nil, err
		}
		title := publishedTitle(published, record.DocumentID)
		outcome, err := p.syncReconciler.Apply(v2sync.ApplyEnvelope{
			ProtocolVersion: v2sync.ProtocolVersion, OwnerID: request.OwnerID, DeviceID: request.DeviceID,
			OperationID: externalOperationID(request.OwnerID, record.DocumentID, head), OperationKind: "external-git",
			DocumentID: record.DocumentID, BaseRevisionID: record.PriorPublishedRevisionID, Title: title,
			Payload: canonicalPayload, PayloadSHA256: payloadHash, ClientCursor: 0,
		})
		if err != nil {
			return nil, err
		}
		record.CandidateRevisionID = outcome.RevisionID
		if outcome.ConflictID != "" {
			record.ConflictID = outcome.ConflictID
		}
		if outcome.Status == "conflict" {
			record.Status = "open"
		} else {
			record.Status = "resolved"
			record.ResolutionRevisionID = outcome.RevisionID
		}
	}
	if err := p.ledger.RecordReconciliations(token, request.OwnerID, base, head, records, now); err != nil {
		return nil, err
	}
	return records, nil
}

func (p *Publisher) ResolveReconciliation(ctx context.Context, request ResolveReconciliationRequest) error {
	if !validOwner(request.OwnerID) || !validStableID(request.DeviceID) || !validHolder(request.Holder) || !validRevision(request.ResolutionRevisionID) || request.ConflictID == "" {
		return codeError(CodeInvalidPayload, "invalid reconciliation resolution request", nil)
	}
	lease, err := p.ledger.AcquireLease(ctx, request.Holder)
	if err != nil {
		return err
	}
	defer lease.Release()
	record, err := p.ledger.Reconciliation(request.ConflictID)
	if err != nil {
		return err
	}
	if record.OwnerID != request.OwnerID {
		return codeError(CodeNotFound, "reconciliation conflict not found for owner", nil)
	}
	current, err := p.syncSource.CurrentRevision(request.OwnerID, request.DeviceID, record.DocumentID)
	if err != nil {
		return err
	}
	if current.ID != request.ResolutionRevisionID {
		return codeError(CodeIneligible, "resolution revision is not current", nil)
	}
	open, err := p.syncSource.OpenConflictCount(request.OwnerID, request.DeviceID, record.DocumentID)
	if err != nil {
		return err
	}
	if open != 0 {
		return codeError(CodeIneligible, "sync conflicts remain open for reconciliation resolution", nil)
	}
	return p.ledger.ResolveReconciliation(lease.Token(), request.OwnerID, request.ConflictID, request.ResolutionRevisionID, hookNow(p.currentHooks()))
}

// ReconciliationCandidate writes a preserved candidate to destination for
// operator review without using any sidecar hash/revision claims.
func ReconciliationCandidate(record Reconciliation, destination string) error {
	if destination == "" {
		return codeError(CodeInvalidConfig, "empty reconciliation candidate destination", nil)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	return os.WriteFile(destination, record.CandidateSource, 0o600)
}
