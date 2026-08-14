// Package v2publish turns durable V2 sync revisions into fenced, validated Git
// publications. It deliberately owns a separate SQLite ledger so publication
// recovery can evolve without coupling Git state to the sync schema.
package v2publish

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"songs.exe.dev/internal/v2sync"
)

const (
	SchemaVersion        = "v2publish-1"
	PayloadSchemaVersion = "v2publish-1"
	SidecarSchemaVersion = "v2publish-sidecar-1"
	DefaultBranch        = "refs/heads/main"
)

type ErrorCode string

const (
	CodeInvalidConfig       ErrorCode = "INVALID_CONFIG"
	CodeInvalidPayload      ErrorCode = "INVALID_PUBLICATION_PAYLOAD"
	CodeLeaseBusy           ErrorCode = "PUBLICATION_LEASE_BUSY"
	CodeStaleFence          ErrorCode = "STALE_PUBLICATION_FENCE"
	CodeNotFound            ErrorCode = "PUBLICATION_NOT_FOUND"
	CodeIneligible          ErrorCode = "PUBLICATION_INELIGIBLE"
	CodeValidation          ErrorCode = "PUBLICATION_VALIDATION_FAILED"
	CodeRemoteDrift         ErrorCode = "PUBLICATION_REMOTE_DRIFT"
	CodeCASFailed           ErrorCode = "PUBLICATION_PUSH_CAS_FAILED"
	CodeReconciliation      ErrorCode = "RECONCILIATION_REQUIRED"
	CodeInjectedFailure     ErrorCode = "INJECTED_PUBLICATION_FAILURE"
	CodeIntegrity           ErrorCode = "PUBLICATION_INTEGRITY_FAILED"
	CodeReplayMismatch      ErrorCode = "PUBLICATION_REPLAY_MISMATCH"
	CodeUnsupportedGitState ErrorCode = "UNSUPPORTED_GIT_STATE"
)

type CodeError struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *CodeError) Error() string {
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}
func (e *CodeError) Unwrap() error { return e.Cause }
func IsCode(err error, code ErrorCode) bool {
	var coded *CodeError
	return errors.As(err, &coded) && coded.Code == code
}
func codeError(code ErrorCode, message string, cause error) error {
	return &CodeError{Code: code, Message: message, Cause: cause}
}

type DocumentKind string

const (
	LeadSheet DocumentKind = "lead-sheet"
	SetList   DocumentKind = "set-list"
)

// PublicationPayload is the complete, typed Git projection carried by a
// v2sync revision. Source contains exact Markdown bytes represented as UTF-8.
// A deletion must retain Kind and Path but carry an empty Source.
type PublicationPayload struct {
	SchemaVersion string       `json:"schema_version"`
	Kind          DocumentKind `json:"kind"`
	Path          string       `json:"path"`
	Source        string       `json:"source"`
	Deleted       bool         `json:"deleted"`
}

// SyncSource is the publication-facing TASK-017 contract. These methods are
// intentionally expressed in terms of v2sync's public Revision type. TASK-017
// stores that do not yet expose these two lookups can be wrapped with
// SnapshotSyncAdapter below.
type SyncSource interface {
	CurrentRevision(ownerID, deviceID, documentID string) (v2sync.Revision, error)
	OpenConflictCount(ownerID, deviceID, documentID string) (int64, error)
}

// SyncReconciler is implemented by the production v2sync Store. External Git
// candidates are admitted through the same durable operation/conflict/event
// path as device mutations rather than living only in the publication ledger.
type SyncReconciler interface {
	Apply(v2sync.ApplyEnvelope) (v2sync.Outcome, error)
}

// PublicationRecorder emits the final publication status into the ordinary
// sync event stream so each device acknowledges it with its normal cursor.
type PublicationRecorder interface {
	RecordPublicationService(ownerID, deviceID, documentID, revisionID, commit string) (v2sync.Outcome, error)
}

// PublicationClaimer prevents the current revision or conflict set from
// changing in the sync ledger while Git validation/commit/push is in flight.
type PublicationClaimer interface {
	ReservePublication(ownerID, deviceID, documentID, revisionID, claimID string) error
	ReleasePublicationClaim(ownerID, documentID, claimID string) error
}

// SnapshotStore is the subset of the currently shipped TASK-017 API needed by
// SnapshotSyncAdapter.
type SnapshotStore interface {
	SemanticSnapshot(ownerID, deviceID string) ([]byte, error)
	Revision(ownerID, deviceID, revisionID string) (v2sync.Revision, error)
	Apply(v2sync.ApplyEnvelope) (v2sync.Outcome, error)
	RecordPublicationService(ownerID, deviceID, documentID, revisionID, commit string) (v2sync.Outcome, error)
	ReservePublication(ownerID, deviceID, documentID, revisionID, claimID string) error
	ReleasePublicationClaim(ownerID, documentID, claimID string) error
}

// SnapshotSyncAdapter lets the publication worker run against the current
// TASK-017 Store while the direct CurrentRevision/OpenConflictCount support
// APIs are being added. It uses only public v2sync APIs.
type SnapshotSyncAdapter struct{ Store SnapshotStore }

func (a SnapshotSyncAdapter) CurrentRevision(ownerID, deviceID, documentID string) (v2sync.Revision, error) {
	if a.Store == nil {
		return v2sync.Revision{}, codeError(CodeInvalidConfig, "nil sync snapshot store", nil)
	}
	var snapshot struct {
		Documents []struct {
			DocumentID        string `json:"document_id"`
			CurrentRevisionID string `json:"current_revision_id"`
		} `json:"documents"`
	}
	raw, err := a.Store.SemanticSnapshot(ownerID, deviceID)
	if err != nil {
		return v2sync.Revision{}, err
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return v2sync.Revision{}, fmt.Errorf("decode v2sync semantic snapshot: %w", err)
	}
	for _, document := range snapshot.Documents {
		if document.DocumentID == documentID {
			if document.CurrentRevisionID == "" {
				return v2sync.Revision{}, v2sync.ErrNotFound
			}
			return a.Store.Revision(ownerID, deviceID, document.CurrentRevisionID)
		}
	}
	return v2sync.Revision{}, v2sync.ErrNotFound
}

func (a SnapshotSyncAdapter) Apply(envelope v2sync.ApplyEnvelope) (v2sync.Outcome, error) {
	if a.Store == nil {
		return v2sync.Outcome{}, codeError(CodeInvalidConfig, "nil sync snapshot store", nil)
	}
	return a.Store.Apply(envelope)
}

func (a SnapshotSyncAdapter) RecordPublicationService(ownerID, deviceID, documentID, revisionID, commit string) (v2sync.Outcome, error) {
	if a.Store == nil {
		return v2sync.Outcome{}, codeError(CodeInvalidConfig, "nil sync snapshot store", nil)
	}
	return a.Store.RecordPublicationService(ownerID, deviceID, documentID, revisionID, commit)
}

func (a SnapshotSyncAdapter) ReservePublication(ownerID, deviceID, documentID, revisionID, claimID string) error {
	if a.Store == nil {
		return codeError(CodeInvalidConfig, "nil sync snapshot store", nil)
	}
	return a.Store.ReservePublication(ownerID, deviceID, documentID, revisionID, claimID)
}

func (a SnapshotSyncAdapter) ReleasePublicationClaim(ownerID, documentID, claimID string) error {
	if a.Store == nil {
		return codeError(CodeInvalidConfig, "nil sync snapshot store", nil)
	}
	return a.Store.ReleasePublicationClaim(ownerID, documentID, claimID)
}

func (a SnapshotSyncAdapter) OpenConflictCount(ownerID, deviceID, documentID string) (int64, error) {
	if a.Store == nil {
		return 0, codeError(CodeInvalidConfig, "nil sync snapshot store", nil)
	}
	var snapshot struct {
		Conflicts []struct {
			DocumentID string `json:"document_id"`
			Status     string `json:"status"`
		} `json:"conflicts"`
	}
	raw, err := a.Store.SemanticSnapshot(ownerID, deviceID)
	if err != nil {
		return 0, err
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return 0, fmt.Errorf("decode v2sync semantic snapshot: %w", err)
	}
	var count int64
	for _, conflict := range snapshot.Conflicts {
		if conflict.DocumentID == documentID && conflict.Status == "open" {
			count++
		}
	}
	return count, nil
}

type IntentState string

const (
	IntentQueued           IntentState = "queued"
	IntentCommitFailed     IntentState = "commit_failed"
	IntentCommitted        IntentState = "committed"
	IntentValidationFailed IntentState = "validation_failed"
	IntentIneligible       IntentState = "ineligible"
	IntentRemoteDrift      IntentState = "remote_drift"
	IntentFinalized        IntentState = "finalized"
)

type FenceToken struct {
	Epoch      int64  `json:"epoch"`
	Generation int64  `json:"generation"`
	Holder     string `json:"holder"`
}

type LeaseState struct {
	FenceToken
	AcquiredUnix int64 `json:"acquired_unix"`
}

type Intent struct {
	ID                          string             `json:"intent_id"`
	OwnerID                     string             `json:"owner_id"`
	DeviceID                    string             `json:"device_id"`
	DocumentID                  string             `json:"document_id"`
	RevisionID                  string             `json:"revision_id"`
	Title                       string             `json:"title"`
	Payload                     PublicationPayload `json:"payload"`
	SourceSHA256                string             `json:"source_sha256"`
	ExpectedCurrentRevisionID   string             `json:"expected_current_revision_id"`
	ExpectedPublishedRevisionID string             `json:"expected_published_revision_id"`
	ExpectedGitBase             string             `json:"expected_git_base"`
	State                       IntentState        `json:"state"`
	CommitHash                  string             `json:"commit_hash,omitempty"`
	CommitUnix                  int64              `json:"commit_unix"`
	LastError                   string             `json:"last_error,omitempty"`
	CreatedUnix                 int64              `json:"created_unix"`
	UpdatedUnix                 int64              `json:"updated_unix"`
}

type PublishedDocument struct {
	OwnerID        string       `json:"owner_id"`
	DocumentID     string       `json:"document_id"`
	RevisionID     string       `json:"revision_id"`
	Title          string       `json:"title"`
	Kind           DocumentKind `json:"kind"`
	Path           string       `json:"path"`
	Source         []byte       `json:"source"`
	SourceSHA256   string       `json:"source_sha256"`
	Deleted        bool         `json:"deleted"`
	CommitHash     string       `json:"commit_hash"`
	PublishedUnix  int64        `json:"published_unix"`
	ExternalSource bool         `json:"external_source"`
}

type BootstrapDocument struct {
	DocumentID string       `json:"document_id"`
	RevisionID string       `json:"revision_id"`
	Title      string       `json:"title"`
	Kind       DocumentKind `json:"kind"`
	Path       string       `json:"path"`
	Source     []byte       `json:"source"`
}

// BootstrapManifestSHA256 produces the reviewed trust anchor for one complete
// archive baseline. Records are sorted by immutable document identity.
func BootstrapManifestSHA256(documents []BootstrapDocument) (string, error) {
	type record struct {
		DocumentID string       `json:"document_id"`
		RevisionID string       `json:"revision_id"`
		Title      string       `json:"title"`
		Kind       DocumentKind `json:"kind"`
		Path       string       `json:"path"`
		SourceHash string       `json:"source_sha256"`
	}
	records := make([]record, 0, len(documents))
	for _, document := range documents {
		records = append(records, record{document.DocumentID, document.RevisionID, document.Title, document.Kind, document.Path, sourceHash(document.Source)})
	}
	sort.Slice(records, func(i, j int) bool { return records[i].DocumentID < records[j].DocumentID })
	for index := 1; index < len(records); index++ {
		if records[index-1].DocumentID == records[index].DocumentID {
			return "", codeError(CodeInvalidPayload, "duplicate bootstrap manifest document", nil)
		}
	}
	raw, err := json.Marshal(records)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

type PublishRequest struct {
	OwnerID, DeviceID, DocumentID, RevisionID, Holder string
}

type PublishResult struct {
	IntentID   string      `json:"intent_id"`
	State      IntentState `json:"state"`
	Commit     string      `json:"commit,omitempty"`
	Idempotent bool        `json:"idempotent"`
}

type FailurePoint string

const (
	FailureAfterIntent        FailurePoint = "after-intent"
	FailureBeforeMaterialize  FailurePoint = "before-materialize"
	FailureAfterMaterialize   FailurePoint = "after-materialize"
	FailureAfterValidation    FailurePoint = "after-validation"
	FailureBeforeCommit       FailurePoint = "before-commit"
	FailureAfterCommit        FailurePoint = "after-commit"
	FailureBeforePush         FailurePoint = "before-push"
	FailureAfterPush          FailurePoint = "after-push"
	FailureBeforeFinalize     FailurePoint = "before-finalize"
	FailureAfterFinalize      FailurePoint = "after-finalize"
	FailureBeforeBackupBundle FailurePoint = "before-backup-bundle"
)

type FailureInjector func(point FailurePoint, intent Intent) error

type ReconciliationKind string

const (
	ReconcileEdit       ReconciliationKind = "edit"
	ReconcileDelete     ReconciliationKind = "delete"
	ReconcileRename     ReconciliationKind = "rename"
	ReconcileRenameEdit ReconciliationKind = "rename-edit"
)

type Reconciliation struct {
	ID                       string             `json:"reconciliation_id"`
	ConflictID               string             `json:"conflict_id"`
	OwnerID                  string             `json:"owner_id"`
	DocumentID               string             `json:"document_id"`
	Kind                     ReconciliationKind `json:"kind"`
	SourceCommit             string             `json:"source_commit"`
	Actor                    string             `json:"actor"`
	PriorPublishedRevisionID string             `json:"prior_published_revision_id"`
	CurrentRevisionID        string             `json:"current_revision_id"`
	CandidateRevisionID      string             `json:"candidate_revision_id"`
	PriorPath                string             `json:"prior_path"`
	CandidatePath            string             `json:"candidate_path"`
	CandidateSource          []byte             `json:"candidate_source"`
	CandidateSourceSHA256    string             `json:"candidate_source_sha256"`
	CandidateDeleted         bool               `json:"candidate_deleted"`
	Status                   string             `json:"status"`
	ValidationError          string             `json:"validation_error,omitempty"`
	DetectedUnix             int64              `json:"detected_unix"`
	ResolutionRevisionID     string             `json:"resolution_revision_id,omitempty"`
}

type UnownedAddition struct {
	ID           string       `json:"addition_id"`
	OwnerID      string       `json:"owner_id"`
	SourceCommit string       `json:"source_commit"`
	Kind         DocumentKind `json:"kind"`
	Path         string       `json:"path"`
	Source       []byte       `json:"source"`
	SourceSHA256 string       `json:"source_sha256"`
	Status       string       `json:"status"`
	DetectedUnix int64        `json:"detected_unix"`
}

type ReconcileRequest struct {
	OwnerID, DeviceID, Holder, Actor string
}

type ResolveReconciliationRequest struct {
	OwnerID, DeviceID, ConflictID, ResolutionRevisionID, Holder string
}

type BackupResult struct {
	LedgerPath string `json:"ledger_path"`
	BundlePath string `json:"bundle_path"`
	LedgerBase string `json:"ledger_base"`
	RemoteHead string `json:"remote_head"`
	Skewed     bool   `json:"skewed"`
}

type Hooks struct {
	Failure FailureInjector
	Now     func() time.Time
}

var (
	stableIDRE         = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	revisionRE         = regexp.MustCompile(`^rev-[a-f0-9]{24}$`)
	externalRevisionRE = regexp.MustCompile(`^ext-[a-f0-9]{24}$`)
	holderRE           = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`)
	gitHashRE          = regexp.MustCompile(`^[a-f0-9]{40,64}$`)
	sha256RE           = regexp.MustCompile(`^[a-f0-9]{64}$`)
	branchRefRE        = regexp.MustCompile(`^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$`)
)

func validStableID(value string) bool {
	return stableIDRE.MatchString(value) && !strings.Contains(value, "--")
}
func validOwner(value string) bool {
	return value != "" && len(value) <= 255 && strings.TrimSpace(value) == value && !strings.ContainsRune(value, 0)
}
func validRevision(value string) bool { return revisionRE.MatchString(value) }
func validArchiveRevision(value string) bool {
	return validRevision(value) || externalRevisionRE.MatchString(value)
}
func validReconciliationConflict(value string) bool {
	return regexp.MustCompile(`^(?:conf|recon)-[a-f0-9]{24}$`).MatchString(value)
}

func validGitHash(value string) bool { return gitHashRE.MatchString(value) }
func validHolder(value string) bool {
	return holderRE.MatchString(value) && !strings.Contains(value, "..")
}

func validatePublishRequest(request PublishRequest) error {
	if !validOwner(request.OwnerID) || !validStableID(request.DeviceID) || !validStableID(request.DocumentID) || !validRevision(request.RevisionID) || !validHolder(request.Holder) {
		return codeError(CodeInvalidPayload, "invalid publication request identity", nil)
	}
	return nil
}

func invokeFailure(ctx context.Context, hook FailureInjector, point FailurePoint, intent Intent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if hook == nil {
		return nil
	}
	if err := hook(point, intent); err != nil {
		return codeError(CodeInjectedFailure, "injected failure at "+string(point), err)
	}
	return nil
}
