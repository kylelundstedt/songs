package v2sync

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
	sqlite "modernc.org/sqlite"
)

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("empty V2 sync database path")
	}
	var dsn string
	if path == ":memory:" {
		dsn = "file:v2sync-memory?mode=memory&cache=shared&_txlock=immediate&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	} else {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("resolve V2 sync database path: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
			return nil, fmt.Errorf("create V2 sync database directory: %w", err)
		}
		dsn = "file:" + absolute + "?_txlock=immediate&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	}
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection per Store avoids connection-local PRAGMA ambiguity. Multiple
	// Store instances/processes still coordinate through WAL + BEGIN IMMEDIATE.
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	store := &Store{db: database}
	if err := store.migrate(); err != nil {
		_ = database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) SetHooks(hooks Hooks) {
	s.hooksMu.Lock()
	s.hooks = hooks
	s.hooksMu.Unlock()
}

func (s *Store) currentHooks() Hooks {
	s.hooksMu.RLock()
	defer s.hooksMu.RUnlock()
	return s.hooks
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS v2sync_schema(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2sync_owners(
  owner_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS v2sync_devices(
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  PRIMARY KEY(owner_id,device_id),
  UNIQUE(owner_id,registration_id),
  FOREIGN KEY(owner_id) REFERENCES v2sync_owners(owner_id)
);
CREATE TABLE IF NOT EXISTS v2sync_documents(
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  current_revision_id TEXT,
  PRIMARY KEY(owner_id,document_id),
  FOREIGN KEY(owner_id) REFERENCES v2sync_owners(owner_id)
);
CREATE TABLE IF NOT EXISTS v2sync_revisions(
  owner_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(owner_id,revision_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES v2sync_documents(owner_id,document_id),
  FOREIGN KEY(owner_id,device_id) REFERENCES v2sync_devices(owner_id,device_id)
);
CREATE TABLE IF NOT EXISTS v2sync_conflicts(
  owner_id TEXT NOT NULL,
  conflict_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  candidate_revision_id TEXT NOT NULL,
  resolution_revision_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  PRIMARY KEY(owner_id,conflict_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES v2sync_documents(owner_id,document_id),
  FOREIGN KEY(owner_id,current_revision_id) REFERENCES v2sync_revisions(owner_id,revision_id),
  FOREIGN KEY(owner_id,candidate_revision_id) REFERENCES v2sync_revisions(owner_id,revision_id)
);
CREATE TABLE IF NOT EXISTS v2sync_operations(
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  outcome_json BLOB NOT NULL,
  accepted_sequence INTEGER NOT NULL,
  client_cursor INTEGER NOT NULL,
  PRIMARY KEY(owner_id,device_id,operation_id),
  FOREIGN KEY(owner_id,device_id) REFERENCES v2sync_devices(owner_id,device_id)
);
CREATE TABLE IF NOT EXISTS v2sync_events(
  owner_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  conflict_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(owner_id,sequence),
  FOREIGN KEY(owner_id,document_id) REFERENCES v2sync_documents(owner_id,document_id),
  FOREIGN KEY(owner_id,revision_id) REFERENCES v2sync_revisions(owner_id,revision_id)
);
CREATE TABLE IF NOT EXISTS v2sync_acks(
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  PRIMARY KEY(owner_id,device_id),
  FOREIGN KEY(owner_id,device_id) REFERENCES v2sync_devices(owner_id,device_id)
);
CREATE TABLE IF NOT EXISTS v2sync_publication_reservations(
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY(owner_id,document_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES v2sync_documents(owner_id,document_id),
  FOREIGN KEY(owner_id,revision_id) REFERENCES v2sync_revisions(owner_id,revision_id)
);
CREATE TABLE IF NOT EXISTS v2sync_publications(
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  PRIMARY KEY(owner_id,document_id),
  FOREIGN KEY(owner_id,document_id) REFERENCES v2sync_documents(owner_id,document_id),
  FOREIGN KEY(owner_id,revision_id) REFERENCES v2sync_revisions(owner_id,revision_id)
);
CREATE TABLE IF NOT EXISTS v2sync_metadata(
  owner_id TEXT PRIMARY KEY,
  current_sequence INTEGER NOT NULL DEFAULT 0,
  compaction_floor INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(owner_id) REFERENCES v2sync_owners(owner_id)
);
CREATE INDEX IF NOT EXISTS v2sync_events_owner_sequence
  ON v2sync_events(owner_id,sequence);
INSERT OR IGNORE INTO v2sync_schema(singleton,version) VALUES(1,'v2sync-1');
`)
	if err != nil {
		return fmt.Errorf("migrate V2 sync ledger: %w", err)
	}
	var version string
	if err := s.db.QueryRow(`SELECT version FROM v2sync_schema WHERE singleton=1`).Scan(&version); err != nil {
		return fmt.Errorf("read V2 sync schema: %w", err)
	}
	if version != SchemaVersion {
		return fmt.Errorf("unsupported V2 sync schema %q", version)
	}
	return nil
}

func ensureOwner(tx *sql.Tx, owner string) error {
	if _, err := tx.Exec(`INSERT OR IGNORE INTO v2sync_owners(owner_id) VALUES(?)`, owner); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT OR IGNORE INTO v2sync_metadata(owner_id) VALUES(?)`, owner)
	return err
}

func (s *Store) RegisterDevice(owner, device, registration, name, tokenHash string) (DeviceRegistration, error) {
	if !validOwner(owner) || !ValidStableID(device) || !ValidStableID(registration) || !validText(name, 128) || !validHash(tokenHash) {
		return DeviceRegistration{}, ErrInvalidEnvelope
	}
	tx, err := s.db.Begin()
	if err != nil {
		return DeviceRegistration{}, err
	}
	defer tx.Rollback()
	if err := ensureOwner(tx, owner); err != nil {
		return DeviceRegistration{}, err
	}
	var existing DeviceRegistration
	var storedHash string
	err = tx.QueryRow(`SELECT owner_id,device_id,registration_id,name,status,token_hash FROM v2sync_devices WHERE owner_id=? AND device_id=?`, owner, device).Scan(&existing.OwnerID, &existing.DeviceID, &existing.RegistrationID, &existing.Name, &existing.Status, &storedHash)
	if err == nil {
		if existing.Status == "revoked" {
			return DeviceRegistration{}, ErrRevoked
		}
		if existing.RegistrationID != registration || existing.Name != name || subtle.ConstantTimeCompare([]byte(storedHash), []byte(tokenHash)) != 1 {
			return DeviceRegistration{}, ErrRegistration
		}
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return DeviceRegistration{}, err
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_devices(owner_id,device_id,registration_id,name,token_hash,status) VALUES(?,?,?,?,?,'active')`, owner, device, registration, name, tokenHash); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return DeviceRegistration{}, ErrRegistration
		}
		return DeviceRegistration{}, err
	}
	if err := tx.Commit(); err != nil {
		return DeviceRegistration{}, err
	}
	return DeviceRegistration{OwnerID: owner, DeviceID: device, RegistrationID: registration, Name: name, Status: "active"}, nil
}

func (s *Store) AuthenticateDevice(owner, device, presentedToken string) error {
	if !validOwner(owner) || !ValidStableID(device) || strings.TrimSpace(presentedToken) != presentedToken || presentedToken == "" {
		return ErrUnauthorized
	}
	presentedTokenHash := sha256Hex([]byte(presentedToken))
	var storedHash, status string
	err := s.db.QueryRow(`SELECT token_hash,status FROM v2sync_devices WHERE owner_id=? AND device_id=?`, owner, device).Scan(&storedHash, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if status != "active" {
		return ErrRevoked
	}
	if subtle.ConstantTimeCompare([]byte(storedHash), []byte(presentedTokenHash)) != 1 {
		return ErrUnauthorized
	}
	return nil
}

func authorize(tx *sql.Tx, owner, device string) error {
	if !validOwner(owner) || !ValidStableID(device) {
		return ErrUnauthorized
	}
	var status string
	if err := tx.QueryRow(`SELECT status FROM v2sync_devices WHERE owner_id=? AND device_id=?`, owner, device).Scan(&status); err != nil {
		return ErrUnauthorized
	}
	if status != "active" {
		return ErrRevoked
	}
	return nil
}

func ownerSequence(tx *sql.Tx, owner string) (int64, error) {
	var sequence int64
	if err := tx.QueryRow(`UPDATE v2sync_metadata SET current_sequence=current_sequence+1 WHERE owner_id=? RETURNING current_sequence`, owner).Scan(&sequence); err != nil {
		return 0, err
	}
	return sequence, nil
}

func currentSequence(tx *sql.Tx, owner string) (int64, error) {
	var sequence int64
	err := tx.QueryRow(`SELECT current_sequence FROM v2sync_metadata WHERE owner_id=?`, owner).Scan(&sequence)
	return sequence, err
}

func revisionID(kind string, envelope ApplyEnvelope, payloadHash string) string {
	return "rev-" + framedHash(kind, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, envelope.DocumentID, envelope.BaseRevisionID, envelope.Title, payloadHash)[:24]
}
func resolutionRevisionID(envelope ResolveEnvelope, payloadHash string) string {
	return "rev-" + framedHash("resolve", envelope.OwnerID, envelope.DeviceID, envelope.OperationID, envelope.ConflictID, envelope.DocumentID, envelope.BaseRevisionID, envelope.Title, payloadHash)[:24]
}
func conflictID(owner, document, current, candidate string) string {
	return "conf-" + framedHash(owner, document, current, candidate)[:24]
}

func replay(tx *sql.Tx, owner, device, operation, fingerprint string) (Outcome, bool, error) {
	var storedFingerprint string
	var raw []byte
	err := tx.QueryRow(`SELECT fingerprint,outcome_json FROM v2sync_operations WHERE owner_id=? AND device_id=? AND operation_id=?`, owner, device, operation).Scan(&storedFingerprint, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Outcome{}, false, nil
	}
	if err != nil {
		return Outcome{}, false, err
	}
	if storedFingerprint != fingerprint {
		return Outcome{}, true, ErrReplayMismatch
	}
	var outcome Outcome
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return Outcome{}, true, fmt.Errorf("decode durable operation outcome: %w", err)
	}
	return outcome, true, nil
}

func checkClientCursor(tx *sql.Tx, owner string, cursor int64) error {
	sequence, err := currentSequence(tx, owner)
	if err != nil {
		return err
	}
	if cursor > sequence {
		return ErrFutureCursor
	}
	return nil
}

func (s *Store) Apply(envelope ApplyEnvelope) (Outcome, error) {
	payloadHash, payload, err := validateApply(envelope)
	if err != nil {
		return Outcome{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Outcome{}, err
	}
	defer tx.Rollback()
	if err := authorize(tx, envelope.OwnerID, envelope.DeviceID); err != nil {
		return Outcome{}, err
	}
	fingerprint := framedHash("apply", envelope.ProtocolVersion, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, envelope.OperationKind, envelope.DocumentID, envelope.BaseRevisionID, envelope.Title, payloadHash, fmt.Sprint(envelope.ClientCursor))
	if outcome, found, err := replay(tx, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, fingerprint); found || err != nil {
		return outcome, err
	}
	if err := publicationReservation(tx, envelope.OwnerID, envelope.DocumentID); err != nil {
		return Outcome{}, err
	}
	if err := checkClientCursor(tx, envelope.OwnerID, envelope.ClientCursor); err != nil {
		return Outcome{}, err
	}
	var current sql.NullString
	err = tx.QueryRow(`SELECT current_revision_id FROM v2sync_documents WHERE owner_id=? AND document_id=?`, envelope.OwnerID, envelope.DocumentID).Scan(&current)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Outcome{}, err
	}
	if !exists {
		if envelope.BaseRevisionID != "" {
			return Outcome{}, ErrUnknownBase
		}
		if _, err := tx.Exec(`INSERT INTO v2sync_documents(owner_id,document_id,title) VALUES(?,?,?)`, envelope.OwnerID, envelope.DocumentID, envelope.Title); err != nil {
			return Outcome{}, err
		}
	} else {
		if envelope.BaseRevisionID == "" {
			return Outcome{}, ErrUnknownBase
		}
		var baseDocument string
		err := tx.QueryRow(`SELECT document_id FROM v2sync_revisions WHERE owner_id=? AND revision_id=?`, envelope.OwnerID, envelope.BaseRevisionID).Scan(&baseDocument)
		if errors.Is(err, sql.ErrNoRows) {
			return Outcome{}, ErrUnknownBase
		}
		if err != nil {
			return Outcome{}, err
		}
		if baseDocument != envelope.DocumentID {
			return Outcome{}, ErrWrongDocument
		}
	}
	revision := revisionID("apply", envelope, payloadHash)
	if _, err := tx.Exec(`INSERT INTO v2sync_revisions(owner_id,revision_id,document_id,device_id,operation_id,operation_kind,base_revision_id,title,payload,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)`, envelope.OwnerID, revision, envelope.DocumentID, envelope.DeviceID, envelope.OperationID, envelope.OperationKind, envelope.BaseRevisionID, envelope.Title, payload, payloadHash); err != nil {
		return Outcome{}, err
	}
	outcome := Outcome{OperationID: envelope.OperationID, Status: "applied", RevisionID: revision}
	if exists && current.String != envelope.BaseRevisionID {
		outcome.Status = "conflict"
		outcome.ConflictID = conflictID(envelope.OwnerID, envelope.DocumentID, current.String, revision)
		if _, err := tx.Exec(`INSERT INTO v2sync_conflicts(owner_id,conflict_id,document_id,current_revision_id,candidate_revision_id,status) VALUES(?,?,?,?,?,'open')`, envelope.OwnerID, outcome.ConflictID, envelope.DocumentID, current.String, revision); err != nil {
			return Outcome{}, err
		}
	} else {
		result, err := tx.Exec(`UPDATE v2sync_documents SET title=?,current_revision_id=? WHERE owner_id=? AND document_id=? AND current_revision_id IS ?`, envelope.Title, revision, envelope.OwnerID, envelope.DocumentID, nullableRevision(current, exists))
		if err != nil {
			return Outcome{}, err
		}
		changed, err := result.RowsAffected()
		if err != nil || changed != 1 {
			return Outcome{}, ErrConflictCAS
		}
	}
	sequence, err := ownerSequence(tx, envelope.OwnerID)
	if err != nil {
		return Outcome{}, err
	}
	outcome.Sequence = sequence
	if _, err := tx.Exec(`INSERT INTO v2sync_events(owner_id,sequence,kind,operation_id,document_id,revision_id,conflict_id) VALUES(?,?,?,?,?,?,?)`, envelope.OwnerID, sequence, outcome.Status, envelope.OperationID, envelope.DocumentID, revision, outcome.ConflictID); err != nil {
		return Outcome{}, err
	}
	outcomeJSON, err := json.Marshal(outcome)
	if err != nil {
		return Outcome{}, err
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_operations(owner_id,device_id,operation_id,operation_kind,fingerprint,outcome_json,accepted_sequence,client_cursor) VALUES(?,?,?,?,?,?,?,?)`, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, envelope.OperationKind, fingerprint, outcomeJSON, sequence, envelope.ClientCursor); err != nil {
		return Outcome{}, err
	}
	return s.commit(tx, outcome)
}

func nullableRevision(current sql.NullString, exists bool) any {
	if !exists {
		return nil
	}
	return current.String
}

func (s *Store) Resolve(envelope ResolveEnvelope) (Outcome, error) {
	payloadHash, payload, err := validateResolve(envelope)
	if err != nil {
		return Outcome{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Outcome{}, err
	}
	defer tx.Rollback()
	if err := authorize(tx, envelope.OwnerID, envelope.DeviceID); err != nil {
		return Outcome{}, err
	}
	fingerprint := framedHash("resolve", envelope.ProtocolVersion, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, envelope.OperationKind, envelope.ConflictID, envelope.DocumentID, envelope.BaseRevisionID, envelope.Title, payloadHash, fmt.Sprint(envelope.ClientCursor))
	if outcome, found, err := replay(tx, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, fingerprint); found || err != nil {
		return outcome, err
	}
	if err := publicationReservation(tx, envelope.OwnerID, envelope.DocumentID); err != nil {
		return Outcome{}, err
	}
	if err := checkClientCursor(tx, envelope.OwnerID, envelope.ClientCursor); err != nil {
		return Outcome{}, err
	}
	var document, conflictCurrent, status string
	if err := tx.QueryRow(`SELECT document_id,current_revision_id,status FROM v2sync_conflicts WHERE owner_id=? AND conflict_id=?`, envelope.OwnerID, envelope.ConflictID).Scan(&document, &conflictCurrent, &status); err != nil {
		return Outcome{}, ErrConflictCAS
	}
	if status != "open" || document != envelope.DocumentID {
		return Outcome{}, ErrConflictCAS
	}
	var documentCurrent string
	if err := tx.QueryRow(`SELECT current_revision_id FROM v2sync_documents WHERE owner_id=? AND document_id=?`, envelope.OwnerID, document).Scan(&documentCurrent); err != nil || documentCurrent != envelope.BaseRevisionID {
		return Outcome{}, ErrConflictCAS
	}
	revision := resolutionRevisionID(envelope, payloadHash)
	if _, err := tx.Exec(`INSERT INTO v2sync_revisions(owner_id,revision_id,document_id,device_id,operation_id,operation_kind,base_revision_id,title,payload,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)`, envelope.OwnerID, revision, document, envelope.DeviceID, envelope.OperationID, envelope.OperationKind, envelope.BaseRevisionID, envelope.Title, payload, payloadHash); err != nil {
		return Outcome{}, err
	}
	result, err := tx.Exec(`UPDATE v2sync_documents SET title=?,current_revision_id=? WHERE owner_id=? AND document_id=? AND current_revision_id=?`, envelope.Title, revision, envelope.OwnerID, document, envelope.BaseRevisionID)
	if err != nil {
		return Outcome{}, err
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		return Outcome{}, ErrConflictCAS
	}
	result, err = tx.Exec(`UPDATE v2sync_conflicts SET status='resolved',resolution_revision_id=? WHERE owner_id=? AND conflict_id=? AND status='open' AND current_revision_id=?`, revision, envelope.OwnerID, envelope.ConflictID, conflictCurrent)
	if err != nil {
		return Outcome{}, err
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		return Outcome{}, ErrConflictCAS
	}
	sequence, err := ownerSequence(tx, envelope.OwnerID)
	if err != nil {
		return Outcome{}, err
	}
	outcome := Outcome{OperationID: envelope.OperationID, Status: "resolved", RevisionID: revision, ConflictID: envelope.ConflictID, Sequence: sequence}
	if _, err := tx.Exec(`INSERT INTO v2sync_events(owner_id,sequence,kind,operation_id,document_id,revision_id,conflict_id) VALUES(?,?,?,?,?,?,?)`, envelope.OwnerID, sequence, "resolved", envelope.OperationID, document, revision, envelope.ConflictID); err != nil {
		return Outcome{}, err
	}
	outcomeJSON, err := json.Marshal(outcome)
	if err != nil {
		return Outcome{}, err
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_operations(owner_id,device_id,operation_id,operation_kind,fingerprint,outcome_json,accepted_sequence,client_cursor) VALUES(?,?,?,?,?,?,?,?)`, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, envelope.OperationKind, fingerprint, outcomeJSON, sequence, envelope.ClientCursor); err != nil {
		return Outcome{}, err
	}
	return s.commit(tx, outcome)
}

func (s *Store) commit(tx *sql.Tx, outcome Outcome) (Outcome, error) {
	hooks := s.currentHooks()
	if hooks.BeforeCommit != nil {
		if err := hooks.BeforeCommit(); err != nil {
			return Outcome{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Outcome{}, err
	}
	if hooks.AfterCommit != nil {
		if err := hooks.AfterCommit(); err != nil {
			return outcome, err
		}
	}
	return outcome, nil
}

func (s *Store) Pull(owner, device string, after int64, limit int) (PullResult, error) {
	if !validOwner(owner) || !ValidStableID(device) || after < 0 || limit < 1 || limit > 1000 {
		return PullResult{}, ErrInvalidEnvelope
	}
	tx, err := s.db.Begin()
	if err != nil {
		return PullResult{}, err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return PullResult{}, err
	}
	var floor, sequence int64
	if err := tx.QueryRow(`SELECT compaction_floor,current_sequence FROM v2sync_metadata WHERE owner_id=?`, owner).Scan(&floor, &sequence); err != nil {
		return PullResult{}, err
	}
	if after < floor {
		return PullResult{Cursor: after, Floor: floor}, ErrResnapshotRequired
	}
	if after > sequence {
		return PullResult{Cursor: after, Floor: floor}, ErrFutureCursor
	}
	rows, err := tx.Query(`SELECT sequence,kind,operation_id,document_id,revision_id,conflict_id FROM v2sync_events WHERE owner_id=? AND sequence>? ORDER BY sequence LIMIT ?`, owner, after, limit)
	if err != nil {
		return PullResult{}, err
	}
	defer rows.Close()
	result := PullResult{Events: []Event{}, Revisions: []Revision{}, Conflicts: []Conflict{}, Cursor: after, Floor: floor}
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.Sequence, &event.Kind, &event.OperationID, &event.DocumentID, &event.RevisionID, &event.ConflictID); err != nil {
			return PullResult{}, err
		}
		result.Events = append(result.Events, event)
		result.Cursor = event.Sequence
	}
	if err := rows.Err(); err != nil {
		return PullResult{}, err
	}
	if err := rows.Close(); err != nil {
		return PullResult{}, err
	}
	seenRevisions := map[string]bool{}
	seenConflicts := map[string]bool{}
	for _, event := range result.Events {
		if !seenRevisions[event.RevisionID] {
			seenRevisions[event.RevisionID] = true
			var revision Revision
			var payload []byte
			if err := tx.QueryRow(`SELECT revision_id,document_id,device_id,operation_id,base_revision_id,title,payload,content_hash FROM v2sync_revisions WHERE owner_id=? AND revision_id=?`, owner, event.RevisionID).Scan(&revision.ID, &revision.DocumentID, &revision.DeviceID, &revision.OperationID, &revision.BaseRevisionID, &revision.Title, &payload, &revision.ContentHash); err != nil {
				return PullResult{}, err
			}
			revision.Payload = bytesClone(payload)
			result.Revisions = append(result.Revisions, revision)
		}
		if event.ConflictID != "" && !seenConflicts[event.ConflictID] {
			seenConflicts[event.ConflictID] = true
			var conflict Conflict
			if err := tx.QueryRow(`SELECT conflict_id,document_id,current_revision_id,candidate_revision_id,resolution_revision_id,status FROM v2sync_conflicts WHERE owner_id=? AND conflict_id=?`, owner, event.ConflictID).Scan(&conflict.ID, &conflict.DocumentID, &conflict.CurrentRevisionID, &conflict.CandidateRevisionID, &conflict.ResolutionRevisionID, &conflict.Status); err != nil {
				return PullResult{}, err
			}
			result.Conflicts = append(result.Conflicts, conflict)
		}
	}
	return result, nil
}

func (s *Store) Snapshot(owner, device string) (SyncSnapshot, error) {
	if !validOwner(owner) || !ValidStableID(device) {
		return SyncSnapshot{}, ErrInvalidEnvelope
	}
	tx, err := s.db.Begin()
	if err != nil {
		return SyncSnapshot{}, err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return SyncSnapshot{}, err
	}
	result := SyncSnapshot{
		ProtocolVersion: ProtocolVersion,
		Documents:       []DocumentMapping{},
		Revisions:       []Revision{},
		Conflicts:       []Conflict{},
		Publications:    []PublicationMapping{},
	}
	if err := tx.QueryRow(`SELECT current_sequence,compaction_floor FROM v2sync_metadata WHERE owner_id=?`, owner).Scan(&result.Cursor, &result.Floor); err != nil {
		return SyncSnapshot{}, err
	}
	rows, err := tx.Query(`SELECT document_id,title,COALESCE(current_revision_id,'') FROM v2sync_documents WHERE owner_id=? ORDER BY document_id`, owner)
	if err != nil {
		return SyncSnapshot{}, err
	}
	for rows.Next() {
		var document DocumentMapping
		if err := rows.Scan(&document.DocumentID, &document.Title, &document.CurrentRevisionID); err != nil {
			rows.Close()
			return SyncSnapshot{}, err
		}
		result.Documents = append(result.Documents, document)
	}
	if err := rows.Close(); err != nil {
		return SyncSnapshot{}, err
	}
	rows, err = tx.Query(`SELECT revision_id,document_id,device_id,operation_id,base_revision_id,title,payload,content_hash FROM v2sync_revisions WHERE owner_id=? ORDER BY revision_id`, owner)
	if err != nil {
		return SyncSnapshot{}, err
	}
	for rows.Next() {
		var revision Revision
		var payload []byte
		if err := rows.Scan(&revision.ID, &revision.DocumentID, &revision.DeviceID, &revision.OperationID, &revision.BaseRevisionID, &revision.Title, &payload, &revision.ContentHash); err != nil {
			rows.Close()
			return SyncSnapshot{}, err
		}
		revision.Payload = bytesClone(payload)
		result.Revisions = append(result.Revisions, revision)
	}
	if err := rows.Close(); err != nil {
		return SyncSnapshot{}, err
	}
	rows, err = tx.Query(`SELECT conflict_id,document_id,current_revision_id,candidate_revision_id,resolution_revision_id,status FROM v2sync_conflicts WHERE owner_id=? ORDER BY conflict_id`, owner)
	if err != nil {
		return SyncSnapshot{}, err
	}
	for rows.Next() {
		var conflict Conflict
		if err := rows.Scan(&conflict.ID, &conflict.DocumentID, &conflict.CurrentRevisionID, &conflict.CandidateRevisionID, &conflict.ResolutionRevisionID, &conflict.Status); err != nil {
			rows.Close()
			return SyncSnapshot{}, err
		}
		result.Conflicts = append(result.Conflicts, conflict)
	}
	if err := rows.Close(); err != nil {
		return SyncSnapshot{}, err
	}
	rows, err = tx.Query(`SELECT document_id,revision_id,commit_hash,sequence FROM v2sync_publications WHERE owner_id=? ORDER BY document_id`, owner)
	if err != nil {
		return SyncSnapshot{}, err
	}
	for rows.Next() {
		var publication PublicationMapping
		if err := rows.Scan(&publication.DocumentID, &publication.RevisionID, &publication.CommitHash, &publication.Sequence); err != nil {
			rows.Close()
			return SyncSnapshot{}, err
		}
		result.Publications = append(result.Publications, publication)
	}
	if err := rows.Close(); err != nil {
		return SyncSnapshot{}, err
	}
	return result, nil
}

func (s *Store) Ack(owner, device string, cursor int64) error {
	if !validOwner(owner) || !ValidStableID(device) || cursor < 0 {
		return ErrInvalidEnvelope
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return err
	}
	sequence, err := currentSequence(tx, owner)
	if err != nil {
		return err
	}
	if cursor > sequence {
		return ErrFutureCursor
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_acks(owner_id,device_id,cursor) VALUES(?,?,?) ON CONFLICT(owner_id,device_id) DO UPDATE SET cursor=MAX(v2sync_acks.cursor,excluded.cursor)`, owner, device, cursor); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeviceCursor(owner, device string) (int64, error) {
	if !validOwner(owner) || !ValidStableID(device) {
		return 0, ErrInvalidEnvelope
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return 0, err
	}
	var cursor int64
	err = tx.QueryRow(`SELECT COALESCE((SELECT cursor FROM v2sync_acks WHERE owner_id=? AND device_id=?),0)`, owner, device).Scan(&cursor)
	return cursor, err
}

func (s *Store) RevokeDevice(owner, device string) error {
	if !validOwner(owner) || !ValidStableID(device) {
		return ErrUnauthorized
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	err = tx.QueryRow(`SELECT status FROM v2sync_devices WHERE owner_id=? AND device_id=?`, owner, device).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if status == "revoked" {
		return nil
	}
	if _, err := tx.Exec(`UPDATE v2sync_devices SET status='revoked' WHERE owner_id=? AND device_id=? AND status='active'`, owner, device); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Revision(owner, device, revision string) (Revision, error) {
	if err := s.AuthenticateMetadataAccess(owner, device); err != nil {
		return Revision{}, err
	}
	if !validRevision(revision) {
		return Revision{}, ErrInvalidEnvelope
	}
	var result Revision
	var payload []byte
	err := s.db.QueryRow(`SELECT revision_id,document_id,device_id,operation_id,base_revision_id,title,payload,content_hash FROM v2sync_revisions WHERE owner_id=? AND revision_id=?`, owner, revision).Scan(&result.ID, &result.DocumentID, &result.DeviceID, &result.OperationID, &result.BaseRevisionID, &result.Title, &payload, &result.ContentHash)
	if errors.Is(err, sql.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	result.Payload = bytesClone(payload)
	return result, err
}

func bytesClone(raw []byte) []byte { return append([]byte(nil), raw...) }

func (s *Store) DocumentKind(owner, device, document string) (string, bool, error) {
	if err := s.AuthenticateMetadataAccess(owner, device); err != nil {
		return "", false, err
	}
	if !ValidStableID(document) {
		return "", false, ErrInvalidEnvelope
	}
	var payload []byte
	err := s.db.QueryRow(`SELECT revision.payload
		FROM v2sync_documents AS document
		JOIN v2sync_revisions AS revision ON revision.owner_id=document.owner_id AND revision.revision_id=document.current_revision_id
		WHERE document.owner_id=? AND document.document_id=?`, owner, document).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	var header struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(payload, &header); err != nil || (header.Kind != "set-list" && header.Kind != "lead-sheet") {
		return "", false, ErrInvalidEnvelope
	}
	return header.Kind, true, nil
}

func (s *Store) ConflictDocumentKind(owner, device, conflict string) (string, error) {
	if err := s.AuthenticateMetadataAccess(owner, device); err != nil {
		return "", err
	}
	if !validConflict(conflict) {
		return "", ErrInvalidEnvelope
	}
	var currentPayload, candidatePayload []byte
	err := s.db.QueryRow(`SELECT current_revision.payload,candidate_revision.payload
		FROM v2sync_conflicts AS conflict
		JOIN v2sync_revisions AS current_revision ON current_revision.owner_id=conflict.owner_id AND current_revision.revision_id=conflict.current_revision_id
		JOIN v2sync_revisions AS candidate_revision ON candidate_revision.owner_id=conflict.owner_id AND candidate_revision.revision_id=conflict.candidate_revision_id
		WHERE conflict.owner_id=? AND conflict.conflict_id=?`, owner, conflict).Scan(&currentPayload, &candidatePayload)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	readKind := func(payload []byte) (string, error) {
		var header struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(payload, &header); err != nil || (header.Kind != "set-list" && header.Kind != "lead-sheet") {
			return "", ErrInvalidEnvelope
		}
		return header.Kind, nil
	}
	currentKind, err := readKind(currentPayload)
	if err != nil {
		return "", err
	}
	candidateKind, err := readKind(candidatePayload)
	if err != nil || candidateKind != currentKind {
		return "", ErrInvalidEnvelope
	}
	return currentKind, nil
}

func (s *Store) Conflict(owner, device, conflict string) (Conflict, error) {
	if err := s.AuthenticateMetadataAccess(owner, device); err != nil {
		return Conflict{}, err
	}
	if !validConflict(conflict) {
		return Conflict{}, ErrInvalidEnvelope
	}
	var result Conflict
	err := s.db.QueryRow(`SELECT conflict_id,document_id,current_revision_id,candidate_revision_id,resolution_revision_id,status FROM v2sync_conflicts WHERE owner_id=? AND conflict_id=?`, owner, conflict).Scan(&result.ID, &result.DocumentID, &result.CurrentRevisionID, &result.CandidateRevisionID, &result.ResolutionRevisionID, &result.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return Conflict{}, ErrNotFound
	}
	return result, err
}

// AuthenticateMetadataAccess authorizes a device by durable registration state.
// Credential verification is performed separately by AuthenticateDevice at the
// HTTP boundary before this method is reached.
func (s *Store) AuthenticateMetadataAccess(owner, device string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	return authorize(tx, owner, device)
}

func (s *Store) Diagnostics(owner, device string) (Diagnostics, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Diagnostics{}, err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return Diagnostics{}, err
	}
	result := Diagnostics{SchemaVersion: SchemaVersion}
	queries := []struct {
		query  string
		target *int64
	}{
		{`SELECT count(*) FROM v2sync_devices WHERE owner_id=?`, &result.DeviceCount},
		{`SELECT count(*) FROM v2sync_devices WHERE owner_id=? AND status='active'`, &result.ActiveDeviceCount},
		{`SELECT count(*) FROM v2sync_documents WHERE owner_id=?`, &result.DocumentCount},
		{`SELECT count(*) FROM v2sync_revisions WHERE owner_id=?`, &result.RevisionCount},
		{`SELECT count(*) FROM v2sync_operations WHERE owner_id=?`, &result.OperationCount},
		{`SELECT count(*) FROM v2sync_events WHERE owner_id=?`, &result.EventCount},
		{`SELECT count(*) FROM v2sync_publications WHERE owner_id=?`, &result.PublicationCount},
		{`SELECT count(*) FROM v2sync_conflicts WHERE owner_id=? AND status='open'`, &result.OpenConflictCount},
		{`SELECT compaction_floor FROM v2sync_metadata WHERE owner_id=?`, &result.CompactionFloor},
		{`SELECT current_sequence FROM v2sync_metadata WHERE owner_id=?`, &result.CurrentSequence},
		{`SELECT COALESCE((SELECT cursor FROM v2sync_acks WHERE owner_id=? AND device_id=?),0)`, &result.AcknowledgedCursor},
	}
	for _, record := range queries {
		args := []any{owner}
		if strings.Contains(record.query, "device_id") {
			args = append(args, device)
		}
		if err := tx.QueryRow(record.query, args...).Scan(record.target); err != nil {
			return Diagnostics{}, err
		}
	}
	return result, nil
}

func (s *Store) SetCompactionFloor(owner string, floor int64) error {
	if !validOwner(owner) || floor < 0 {
		return ErrInvalidEnvelope
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var current int64
	if err := tx.QueryRow(`SELECT current_sequence FROM v2sync_metadata WHERE owner_id=?`, owner).Scan(&current); err != nil {
		return err
	}
	if floor > current {
		return ErrFutureCursor
	}
	if _, err := tx.Exec(`UPDATE v2sync_metadata SET compaction_floor=MAX(compaction_floor,?) WHERE owner_id=?`, floor, owner); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SemanticSnapshot(owner, device string) ([]byte, error) {
	if !validOwner(owner) || !ValidStableID(device) {
		return nil, ErrInvalidEnvelope
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return nil, err
	}
	type deviceRecord struct {
		DeviceID       string `json:"device_id"`
		RegistrationID string `json:"registration_id"`
		Name           string `json:"name"`
		Status         string `json:"status"`
	}
	type documentRecord struct {
		DocumentID        string `json:"document_id"`
		Title             string `json:"title"`
		CurrentRevisionID string `json:"current_revision_id"`
	}
	type operationRecord struct {
		DeviceID      string `json:"device_id"`
		OperationID   string `json:"operation_id"`
		OperationKind string `json:"operation_kind"`
		Fingerprint   string `json:"fingerprint"`
		Sequence      int64  `json:"sequence"`
		ClientCursor  int64  `json:"client_cursor"`
	}
	type ackRecord struct {
		DeviceID string `json:"device_id"`
		Cursor   int64  `json:"cursor"`
	}
	type snapshot struct {
		Schema       string               `json:"schema_version"`
		Owner        string               `json:"owner_id"`
		Devices      []deviceRecord       `json:"devices"`
		Documents    []documentRecord     `json:"documents"`
		Revisions    []Revision           `json:"revisions"`
		Conflicts    []Conflict           `json:"conflicts"`
		Events       []Event              `json:"events"`
		Operations   []operationRecord    `json:"operations"`
		Publications []PublicationMapping `json:"publications"`
		Acks         []ackRecord          `json:"acknowledgements"`
		Diagnostics  Diagnostics          `json:"diagnostics"`
	}
	result := snapshot{Schema: SchemaVersion, Owner: owner, Diagnostics: Diagnostics{SchemaVersion: SchemaVersion}}
	queries := []struct {
		query  string
		target *int64
		args   []any
	}{
		{`SELECT count(*) FROM v2sync_devices WHERE owner_id=?`, &result.Diagnostics.DeviceCount, []any{owner}},
		{`SELECT count(*) FROM v2sync_devices WHERE owner_id=? AND status='active'`, &result.Diagnostics.ActiveDeviceCount, []any{owner}},
		{`SELECT count(*) FROM v2sync_documents WHERE owner_id=?`, &result.Diagnostics.DocumentCount, []any{owner}},
		{`SELECT count(*) FROM v2sync_revisions WHERE owner_id=?`, &result.Diagnostics.RevisionCount, []any{owner}},
		{`SELECT count(*) FROM v2sync_operations WHERE owner_id=?`, &result.Diagnostics.OperationCount, []any{owner}},
		{`SELECT count(*) FROM v2sync_events WHERE owner_id=?`, &result.Diagnostics.EventCount, []any{owner}},
		{`SELECT count(*) FROM v2sync_publications WHERE owner_id=?`, &result.Diagnostics.PublicationCount, []any{owner}},
		{`SELECT count(*) FROM v2sync_conflicts WHERE owner_id=? AND status='open'`, &result.Diagnostics.OpenConflictCount, []any{owner}},
		{`SELECT compaction_floor FROM v2sync_metadata WHERE owner_id=?`, &result.Diagnostics.CompactionFloor, []any{owner}},
		{`SELECT current_sequence FROM v2sync_metadata WHERE owner_id=?`, &result.Diagnostics.CurrentSequence, []any{owner}},
		{`SELECT COALESCE((SELECT cursor FROM v2sync_acks WHERE owner_id=? AND device_id=?),0)`, &result.Diagnostics.AcknowledgedCursor, []any{owner, device}},
	}
	for _, record := range queries {
		if err := tx.QueryRow(record.query, record.args...).Scan(record.target); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(`SELECT device_id,registration_id,name,status FROM v2sync_devices WHERE owner_id=? ORDER BY device_id`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var record deviceRecord
		if err := rows.Scan(&record.DeviceID, &record.RegistrationID, &record.Name, &record.Status); err != nil {
			rows.Close()
			return nil, err
		}
		result.Devices = append(result.Devices, record)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT document_id,title,COALESCE(current_revision_id,'') FROM v2sync_documents WHERE owner_id=? ORDER BY document_id`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var record documentRecord
		if err := rows.Scan(&record.DocumentID, &record.Title, &record.CurrentRevisionID); err != nil {
			rows.Close()
			return nil, err
		}
		result.Documents = append(result.Documents, record)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT revision_id,document_id,device_id,operation_id,base_revision_id,title,payload,content_hash FROM v2sync_revisions WHERE owner_id=? ORDER BY revision_id`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var revision Revision
		var payload []byte
		if err := rows.Scan(&revision.ID, &revision.DocumentID, &revision.DeviceID, &revision.OperationID, &revision.BaseRevisionID, &revision.Title, &payload, &revision.ContentHash); err != nil {
			rows.Close()
			return nil, err
		}
		revision.Payload = bytesClone(payload)
		result.Revisions = append(result.Revisions, revision)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT conflict_id,document_id,current_revision_id,candidate_revision_id,resolution_revision_id,status FROM v2sync_conflicts WHERE owner_id=? ORDER BY conflict_id`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var conflict Conflict
		if err := rows.Scan(&conflict.ID, &conflict.DocumentID, &conflict.CurrentRevisionID, &conflict.CandidateRevisionID, &conflict.ResolutionRevisionID, &conflict.Status); err != nil {
			rows.Close()
			return nil, err
		}
		result.Conflicts = append(result.Conflicts, conflict)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT sequence,kind,operation_id,document_id,revision_id,conflict_id FROM v2sync_events WHERE owner_id=? ORDER BY sequence`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.Sequence, &event.Kind, &event.OperationID, &event.DocumentID, &event.RevisionID, &event.ConflictID); err != nil {
			rows.Close()
			return nil, err
		}
		result.Events = append(result.Events, event)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT device_id,operation_id,operation_kind,fingerprint,accepted_sequence,client_cursor FROM v2sync_operations WHERE owner_id=? ORDER BY device_id,operation_id`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var operation operationRecord
		if err := rows.Scan(&operation.DeviceID, &operation.OperationID, &operation.OperationKind, &operation.Fingerprint, &operation.Sequence, &operation.ClientCursor); err != nil {
			rows.Close()
			return nil, err
		}
		result.Operations = append(result.Operations, operation)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT document_id,revision_id,commit_hash,sequence FROM v2sync_publications WHERE owner_id=? ORDER BY document_id`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var publication PublicationMapping
		if err := rows.Scan(&publication.DocumentID, &publication.RevisionID, &publication.CommitHash, &publication.Sequence); err != nil {
			rows.Close()
			return nil, err
		}
		result.Publications = append(result.Publications, publication)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT device_id,cursor FROM v2sync_acks WHERE owner_id=? ORDER BY device_id`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var ack ackRecord
		if err := rows.Scan(&ack.DeviceID, &ack.Cursor); err != nil {
			rows.Close()
			return nil, err
		}
		result.Acks = append(result.Acks, ack)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return json.Marshal(result)
}

func (s *Store) Integrity() error {
	var integrity string
	if err := s.db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return fmt.Errorf("SQLite integrity check: %s", integrity)
	}
	rows, err := s.db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("SQLite foreign-key check failed")
	}
	return rows.Err()
}

func (s *Store) Backup(destination string) error {
	if destination == "" {
		return errors.New("empty backup destination")
	}
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return err
	}
	_ = os.Remove(absolute)
	connection, err := s.db.Conn(context.Background())
	if err != nil {
		return err
	}
	defer connection.Close()
	return connection.Raw(func(driverConnection any) error {
		backuper, ok := driverConnection.(interface {
			NewBackup(string) (*sqlite.Backup, error)
		})
		if !ok {
			return errors.New("SQLite online backup unavailable")
		}
		backup, err := backuper.NewBackup("file:" + absolute + "?mode=rwc")
		if err != nil {
			return err
		}
		for more := true; more; {
			more, err = backup.Step(-1)
			if err != nil {
				_ = backup.Finish()
				return err
			}
		}
		return backup.Finish()
	})
}
