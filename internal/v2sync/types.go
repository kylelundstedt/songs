package v2sync

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

const ProtocolVersion = "1"
const SchemaVersion = "v2sync-1"

const (
	maxBaselineRevisions    = 10000
	maxBaselineDocuments    = 10000
	maxBaselinePublications = 10000
)

var (
	ErrUnauthorized        = &CodeError{"UNAUTHORIZED", "owner/device authorization failed", nil}
	ErrRevoked             = &CodeError{"DEVICE_REVOKED", "device is revoked", nil}
	ErrReplayMismatch      = &CodeError{"OPERATION_REPLAY_MISMATCH", "operation ID was reused with different canonical bytes", nil}
	ErrUnknownBase         = &CodeError{"UNKNOWN_BASE", "base revision is unknown", nil}
	ErrWrongDocument       = &CodeError{"WRONG_DOCUMENT", "base revision belongs to another document", nil}
	ErrConflictCAS         = &CodeError{"CONFLICT_CAS_FAILED", "conflict compare-and-swap failed", nil}
	ErrFutureCursor        = &CodeError{"FUTURE_CURSOR", "cursor is beyond the owner's event sequence", nil}
	ErrResnapshotRequired  = &CodeError{"RESNAPSHOT_REQUIRED", "cursor is below the compaction floor", nil}
	ErrInvalidEnvelope     = &CodeError{"INVALID_ENVELOPE", "envelope is invalid", nil}
	ErrPayloadHash         = &CodeError{"PAYLOAD_HASH_MISMATCH", "payload hash mismatch", nil}
	ErrRegistration        = &CodeError{"REGISTRATION_MISMATCH", "device registration differs", nil}
	ErrPublicationReserved = &CodeError{"PUBLICATION_RESERVED", "document is reserved for publication", nil}
	ErrBaselineInitialized = &CodeError{"BASELINE_ALREADY_INITIALIZED", "owner baseline is already initialized", nil}
	ErrNotFound            = &CodeError{"NOT_FOUND", "resource not found", nil}
)

type CodeError struct {
	Code, Message string
	Cause         error
}

func (e *CodeError) Error() string {
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}
func (e *CodeError) Unwrap() error  { return e.Cause }
func IsCode(e error, c string) bool { var x *CodeError; return errors.As(e, &x) && x.Code == c }

var idRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var hashRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var revRE = regexp.MustCompile(`^rev-[a-f0-9]{24}$`)
var confRE = regexp.MustCompile(`^conf-[a-f0-9]{24}$`)

func ValidStableID(s string) bool { return idRE.MatchString(s) && !strings.Contains(s, "--") }
func validOwner(s string) bool {
	return s != "" && len(s) <= 255 && utf8.ValidString(s) && !strings.ContainsRune(s, 0) && strings.TrimSpace(s) == s
}
func validText(s string, n int) bool {
	return s != "" && len(s) <= n && utf8.ValidString(s) && !strings.ContainsRune(s, 0) && strings.TrimSpace(s) == s
}
func validHash(s string) bool     { return hashRE.MatchString(s) }
func validRevision(s string) bool { return revRE.MatchString(s) }
func validConflict(s string) bool { return confRE.MatchString(s) }

type DeviceRegistration struct {
	OwnerID        string `json:"owner_id"`
	DeviceID       string `json:"device_id"`
	RegistrationID string `json:"registration_id"`
	Name           string `json:"name"`
	Status         string `json:"status"`
}
type ApplyEnvelope struct {
	ProtocolVersion string          `json:"protocol_version"`
	OwnerID         string          `json:"-"`
	DeviceID        string          `json:"device_id"`
	OperationID     string          `json:"operation_id"`
	OperationKind   string          `json:"operation_kind"`
	DocumentID      string          `json:"document_id"`
	BaseRevisionID  string          `json:"base_revision_id"`
	Title           string          `json:"title"`
	Payload         json.RawMessage `json:"payload"`
	PayloadSHA256   string          `json:"payload_sha256"`
	ClientCursor    int64           `json:"client_cursor"`
}
type ResolveEnvelope struct {
	ProtocolVersion string          `json:"protocol_version"`
	OwnerID         string          `json:"-"`
	DeviceID        string          `json:"device_id"`
	OperationID     string          `json:"operation_id"`
	OperationKind   string          `json:"operation_kind"`
	ConflictID      string          `json:"-"`
	DocumentID      string          `json:"document_id"`
	BaseRevisionID  string          `json:"base_revision_id"`
	Title           string          `json:"title"`
	Payload         json.RawMessage `json:"payload"`
	PayloadSHA256   string          `json:"payload_sha256"`
	ClientCursor    int64           `json:"client_cursor"`
}
type Outcome struct {
	OperationID string `json:"operation_id"`
	Status      string `json:"status"`
	RevisionID  string `json:"revision_id"`
	ConflictID  string `json:"conflict_id,omitempty"`
	Sequence    int64  `json:"sequence"`
}
type Event struct {
	Sequence    int64  `json:"sequence"`
	Kind        string `json:"kind"`
	OperationID string `json:"operation_id"`
	DocumentID  string `json:"document_id"`
	RevisionID  string `json:"revision_id"`
	ConflictID  string `json:"conflict_id,omitempty"`
}
type SyncSnapshot struct {
	ProtocolVersion string               `json:"protocol_version"`
	Cursor          int64                `json:"cursor"`
	Floor           int64                `json:"compaction_floor"`
	Documents       []DocumentMapping    `json:"documents"`
	Revisions       []Revision           `json:"revisions"`
	Conflicts       []Conflict           `json:"conflicts"`
	Publications    []PublicationMapping `json:"publications"`
}
type DocumentMapping struct {
	DocumentID        string `json:"document_id"`
	Title             string `json:"title"`
	CurrentRevisionID string `json:"current_revision_id"`
}
type PublicationMapping struct {
	DocumentID string `json:"document_id"`
	RevisionID string `json:"revision_id"`
	CommitHash string `json:"commit"`
	Sequence   int64  `json:"-"`
}
type BaselineRevision struct {
	RevisionID     string          `json:"revision_id"`
	DocumentID     string          `json:"document_id"`
	BaseRevisionID string          `json:"base_revision_id"`
	Title          string          `json:"title"`
	Payload        json.RawMessage `json:"payload"`
	PayloadSHA256  string          `json:"payload_sha256"`
}
type BaselineBootstrapEnvelope struct {
	ProtocolVersion string               `json:"protocol_version"`
	OwnerID         string               `json:"-"`
	DeviceID        string               `json:"device_id"`
	OperationID     string               `json:"operation_id"`
	Revisions       []BaselineRevision   `json:"revisions"`
	Documents       []DocumentMapping    `json:"documents"`
	Publications    []PublicationMapping `json:"publications"`
}
type BaselineBootstrapOutcome struct {
	ProtocolVersion  string `json:"protocol_version"`
	OperationID      string `json:"operation_id"`
	Status           string `json:"status"`
	Cursor           int64  `json:"cursor"`
	RevisionCount    int    `json:"revision_count"`
	DocumentCount    int    `json:"document_count"`
	PublicationCount int    `json:"publication_count"`
}
type PullResult struct {
	Events    []Event    `json:"events"`
	Revisions []Revision `json:"revisions"`
	Conflicts []Conflict `json:"conflicts"`
	Cursor    int64      `json:"cursor"`
	Floor     int64      `json:"compaction_floor"`
}
type Conflict struct {
	ID                   string `json:"conflict_id"`
	DocumentID           string `json:"document_id"`
	CurrentRevisionID    string `json:"current_revision_id"`
	CandidateRevisionID  string `json:"candidate_revision_id"`
	ResolutionRevisionID string `json:"resolution_revision_id,omitempty"`
	Status               string `json:"status"`
}
type Revision struct {
	ID             string          `json:"revision_id"`
	DocumentID     string          `json:"document_id"`
	DeviceID       string          `json:"device_id"`
	OperationID    string          `json:"operation_id"`
	BaseRevisionID string          `json:"base_revision_id"`
	Title          string          `json:"title"`
	Payload        json.RawMessage `json:"payload"`
	ContentHash    string          `json:"content_hash"`
}
type Diagnostics struct {
	SchemaVersion      string `json:"schema_version"`
	DeviceCount        int64  `json:"device_count"`
	ActiveDeviceCount  int64  `json:"active_device_count"`
	DocumentCount      int64  `json:"document_count"`
	RevisionCount      int64  `json:"revision_count"`
	OperationCount     int64  `json:"operation_count"`
	EventCount         int64  `json:"event_count"`
	PublicationCount   int64  `json:"publication_count"`
	OpenConflictCount  int64  `json:"open_conflict_count"`
	AcknowledgedCursor int64  `json:"acknowledged_cursor"`
	CompactionFloor    int64  `json:"compaction_floor"`
	CurrentSequence    int64  `json:"current_sequence"`
}
type Hooks struct {
	BeforeCommit func() error
	AfterCommit  func() error
}
type Store struct {
	db      *sql.DB
	hooksMu sync.RWMutex
	hooks   Hooks
}

func HashPayload(raw []byte) (string, []byte, error) {
	c, e := canonicalJSON(raw)
	if e != nil {
		return "", nil, e
	}
	return sha256Hex(c), c, nil
}

func sha256Hex(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
func canonicalJSON(raw []byte) ([]byte, error) {
	if len(raw) == 0 || len(raw) > 8<<20 || !utf8.Valid(raw) || bytes.Contains(raw, []byte{0}) {
		return nil, &CodeError{"INVALID_PAYLOAD", "invalid payload", nil}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, e := parseJSON(d)
	if e != nil {
		return nil, &CodeError{"INVALID_PAYLOAD", "invalid payload", e}
	}
	var x any
	if e = d.Decode(&x); e != io.EOF {
		return nil, &CodeError{"INVALID_PAYLOAD", "trailing JSON", e}
	}
	return json.Marshal(v)
}
func parseJSON(d *json.Decoder) (any, error) {
	t, e := d.Token()
	if e != nil {
		return nil, e
	}
	if z, ok := t.(json.Delim); ok {
		if z == '{' {
			m := map[string]any{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return nil, e
				}
				ks, ok := k.(string)
				if !ok || !utf8.ValidString(ks) || strings.ContainsRune(ks, 0) {
					return nil, fmt.Errorf("bad key")
				}
				if _, ok = m[ks]; ok {
					return nil, fmt.Errorf("duplicate key")
				}
				v, e := parseJSON(d)
				if e != nil {
					return nil, e
				}
				m[ks] = v
			}
			_, e = d.Token()
			return m, e
		}
		if z == '[' {
			var a []any
			for d.More() {
				v, e := parseJSON(d)
				if e != nil {
					return nil, e
				}
				a = append(a, v)
			}
			_, e = d.Token()
			return a, e
		}
		return nil, fmt.Errorf("bad delimiter")
	}
	if number, ok := t.(json.Number); ok {
		text := number.String()
		parsed, parseErr := strconv.ParseFloat(text, 64)
		fractionalDigits := 0
		if dot := strings.IndexByte(text, '.'); dot >= 0 {
			fractionalDigits = len(text) - dot - 1
		}
		integer := math.Trunc(parsed) == parsed
		outsideDomain := integer && math.Abs(parsed) > 9007199254740991 || !integer && (math.Abs(parsed) >= 1_000_000 || fractionalDigits < 1 || fractionalDigits > 6)
		if parseErr != nil || strings.ContainsAny(text, "eE") || text == "-0" || outsideDomain || strconv.FormatFloat(parsed, 'f', -1, 64) != text {
			return nil, fmt.Errorf("noncanonical JSON number %q", text)
		}
	}
	if s, ok := t.(string); ok && strings.ContainsRune(s, 0) {
		return nil, fmt.Errorf("NUL string")
	}
	return t, nil
}
func validateApply(e ApplyEnvelope) (string, []byte, error) {
	if e.ProtocolVersion != ProtocolVersion || !validOwner(e.OwnerID) || !ValidStableID(e.DeviceID) || !ValidStableID(e.OperationID) || !ValidStableID(e.DocumentID) || !ValidStableID(e.OperationKind) || e.ClientCursor < 0 || !validText(e.Title, 512) || (e.BaseRevisionID != "" && !validRevision(e.BaseRevisionID)) {
		return "", nil, ErrInvalidEnvelope
	}
	h, c, x := HashPayload(e.Payload)
	if x != nil {
		return "", nil, x
	}
	if !validHash(e.PayloadSHA256) || e.PayloadSHA256 != h {
		return "", nil, ErrPayloadHash
	}
	return h, c, nil
}
func validateResolve(e ResolveEnvelope) (string, []byte, error) {
	if e.ProtocolVersion != ProtocolVersion || !validOwner(e.OwnerID) || !ValidStableID(e.DeviceID) || !ValidStableID(e.OperationID) || e.OperationKind != "resolve-conflict" || !validConflict(e.ConflictID) || !ValidStableID(e.DocumentID) || !validRevision(e.BaseRevisionID) || e.ClientCursor < 0 || !validText(e.Title, 512) {
		return "", nil, ErrInvalidEnvelope
	}
	h, c, x := HashPayload(e.Payload)
	if x != nil {
		return "", nil, x
	}
	if !validHash(e.PayloadSHA256) || e.PayloadSHA256 != h {
		return "", nil, ErrPayloadHash
	}
	return h, c, nil
}
func framedHash(p ...string) string {
	h := sha256.New()
	for _, x := range p {
		fmt.Fprintf(h, "%d:", len(x))
		h.Write([]byte(x))
	}
	return hex.EncodeToString(h.Sum(nil))
}
