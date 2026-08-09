// Package syncspike is a deliberately non-production TASK-005 feasibility spike.
// It has no HTTP surface and only operates on caller-provided SQLite/Git paths.
package syncspike

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

const SchemaVersion = "sync-spike-2"

const (
	applyKind   = "apply"
	resolveKind = "resolve"
)

var (
	stableIDRE   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	revisionIDRE = regexp.MustCompile(`^rev-[a-f0-9]{24}$`)
	conflictIDRE = regexp.MustCompile(`^conf-[a-f0-9]{24}$`)
)

type Store struct {
	db *sql.DB
	mu sync.Mutex // serializes document mutations with materialization/reconciliation
}

type Operation struct {
	ID, DeviceID, DocumentID, BaseRevisionID, Title string
	Body                                            []byte
}

type Outcome struct {
	OperationID string `json:"operation_id"`
	Status      string `json:"status"`
	RevisionID  string `json:"revision_id"`
	ConflictID  string `json:"conflict_id,omitempty"`
	Sequence    int64  `json:"sequence"`
}

type Event struct {
	Sequence                                  int64 `json:"sequence"`
	Kind, OperationID, DocumentID, RevisionID string
}
type PullResult struct {
	Events []Event `json:"events"`
	Cursor int64   `json:"cursor"`
}
type Conflict struct {
	ID, DocumentID, CurrentRevisionID, CandidateRevisionID, ResolutionRevisionID, Status string
}
type RevisionInfo struct {
	ID, DocumentID, Title, ContentHash string
	Body                               []byte
}
type Publication struct {
	State, Commit, Base, ExpectedPublished string
}
type FinalizeResult struct {
	PointerAdvanced bool
	GitAdvanced     bool
	Acknowledged    bool
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS documents(
 document_id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
 current_revision_id TEXT, published_revision_id TEXT,
 FOREIGN KEY(current_revision_id) REFERENCES revisions(revision_id),
 FOREIGN KEY(published_revision_id) REFERENCES revisions(revision_id));
CREATE TABLE IF NOT EXISTS revisions(
 revision_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, device_id TEXT NOT NULL,
 operation_id TEXT NOT NULL, operation_kind TEXT NOT NULL, base_revision_id TEXT NOT NULL,
 title TEXT NOT NULL, body BLOB NOT NULL, content_hash TEXT NOT NULL,
 source TEXT NOT NULL, source_commit TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(document_id) REFERENCES documents(document_id));
CREATE TABLE IF NOT EXISTS operations(
 device_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_kind TEXT NOT NULL,
 payload_hash TEXT NOT NULL, outcome_json TEXT NOT NULL, accepted_sequence INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(device_id,operation_id));
CREATE TABLE IF NOT EXISTS events(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, operation_id TEXT NOT NULL,
 document_id TEXT NOT NULL, revision_id TEXT NOT NULL, detail_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_cursors(device_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conflicts(
 conflict_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, current_revision_id TEXT NOT NULL,
 candidate_revision_id TEXT NOT NULL, status TEXT NOT NULL, resolution_revision_id TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(document_id) REFERENCES documents(document_id),
 FOREIGN KEY(current_revision_id) REFERENCES revisions(revision_id),
 FOREIGN KEY(candidate_revision_id) REFERENCES revisions(revision_id));
CREATE TABLE IF NOT EXISTS audit_events(
 audit_id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, operation_id TEXT NOT NULL DEFAULT '',
 device_id TEXT NOT NULL DEFAULT '', document_id TEXT NOT NULL DEFAULT '', revision_id TEXT NOT NULL DEFAULT '',
 source_commit TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', detail_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS publications(
 revision_id TEXT PRIMARY KEY, state TEXT NOT NULL, commit_hash TEXT NOT NULL DEFAULT '', base_commit TEXT NOT NULL DEFAULT '',
 expected_published_revision_id TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(revision_id) REFERENCES revisions(revision_id));
CREATE TABLE IF NOT EXISTS publication_attempts(
 attempt_id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id TEXT NOT NULL, state TEXT NOT NULL,
 class TEXT NOT NULL, commit_hash TEXT NOT NULL DEFAULT '', base_commit TEXT NOT NULL DEFAULT '',
 expected_published_revision_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(revision_id) REFERENCES revisions(revision_id));
CREATE TABLE IF NOT EXISTS git_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_app_commit TEXT NOT NULL DEFAULT '', publication_base_commit TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS external_imports(
 source_commit TEXT NOT NULL, document_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 result_kind TEXT NOT NULL, conflict_id TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL,
 PRIMARY KEY(source_commit,document_id), FOREIGN KEY(revision_id) REFERENCES revisions(revision_id));
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('sync-spike-2');
INSERT OR IGNORE INTO git_state(singleton,last_app_commit,publication_base_commit) VALUES (1,'','');`)
	return err
}

func validStableID(v string) bool { return stableIDRE.MatchString(v) && !strings.Contains(v, "--") }
func validateOperation(op Operation) error {
	if !validStableID(op.ID) || !validStableID(op.DeviceID) || !validStableID(op.DocumentID) {
		return errors.New("operation, device, and document IDs must be strict stable IDs")
	}
	if op.Title == "" || !utf8.ValidString(op.Title) || strings.IndexByte(op.Title, 0) >= 0 {
		return errors.New("title must be non-empty UTF-8 without NUL")
	}
	if !utf8.Valid(op.Body) || bytes.IndexByte(op.Body, 0) >= 0 {
		return errors.New("operation body must be UTF-8 and contain no NUL")
	}
	if op.BaseRevisionID != "" && !revisionIDRE.MatchString(op.BaseRevisionID) {
		return errors.New("base revision ID is invalid")
	}
	return nil
}
func hash(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		_, _ = h.Write([]byte(p))
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}
func bodyHash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func revisionID(kind string, op Operation, target string) string {
	return "rev-" + hash(kind, op.DeviceID, op.ID, op.DocumentID, target, bodyHash(op.Body))[:24]
}
func conflictID(doc, current, candidate string) string {
	return "conf-" + hash(doc, current, candidate)[:24]
}
func payloadHash(kind string, op Operation, target string) string {
	return hash(kind, op.DeviceID, op.ID, op.DocumentID, op.BaseRevisionID, op.Title, target, bodyHash(op.Body))
}
func canonicalOutcome(o Outcome) (string, error) { b, e := json.Marshal(o); return string(b), e }
func docPath(id string) (string, error) {
	if !validStableID(id) {
		return "", errors.New("invalid document ID for path")
	}
	return "songs/" + id + ".md", nil
}

func replay(tx *sql.Tx, kind string, op Operation, target string) (Outcome, bool, error) {
	ph := payloadHash(kind, op, target)
	var oldKind, oldHash, raw string
	err := tx.QueryRow(`SELECT operation_kind,payload_hash,outcome_json FROM operations WHERE device_id=? AND operation_id=?`, op.DeviceID, op.ID).Scan(&oldKind, &oldHash, &raw)
	if err == sql.ErrNoRows {
		return Outcome{}, false, nil
	}
	if err != nil {
		return Outcome{}, false, err
	}
	if oldKind != kind || oldHash != ph {
		return Outcome{}, true, fmt.Errorf("operation replay kind or payload differs")
	}
	var out Outcome
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return Outcome{}, true, err
	}
	return out, true, nil
}
func insertOperation(tx *sql.Tx, kind string, op Operation, target string, out Outcome) error {
	raw, err := canonicalOutcome(out)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO operations(device_id,operation_id,operation_kind,payload_hash,outcome_json,accepted_sequence) VALUES(?,?,?,?,?,?)`, op.DeviceID, op.ID, kind, payloadHash(kind, op, target), raw, out.Sequence)
	return err
}
func insertAudit(tx *sql.Tx, action, kind string, op Operation, revision, detail string) error {
	_, err := tx.Exec(`INSERT INTO audit_events(action,operation_id,device_id,document_id,revision_id,detail_json) VALUES(?,?,?,?,?,?)`, action, op.ID, op.DeviceID, op.DocumentID, revision, detail)
	return err
}
func knownBase(tx *sql.Tx, doc, base string) error {
	var owner string
	if err := tx.QueryRow(`SELECT document_id FROM revisions WHERE revision_id=?`, base).Scan(&owner); err != nil {
		if err == sql.ErrNoRows {
			return errors.New("base revision is unknown")
		}
		return err
	}
	if owner != doc {
		return errors.New("base revision belongs to another document")
	}
	return nil
}

// Apply commits one independently idempotent operation. PushBatch deliberately
// remains a non-atomic list wrapper; it is not a transactional batch envelope.
func (s *Store) Apply(op Operation) (Outcome, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateOperation(op); err != nil {
		return Outcome{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Outcome{}, err
	}
	defer tx.Rollback()
	if out, found, err := replay(tx, applyKind, op, ""); found || err != nil {
		return out, err
	}
	path, err := docPath(op.DocumentID)
	if err != nil {
		return Outcome{}, err
	}
	var current sql.NullString
	err = tx.QueryRow(`SELECT current_revision_id FROM documents WHERE document_id=?`, op.DocumentID).Scan(&current)
	exists := err == nil
	if err != nil && err != sql.ErrNoRows {
		return Outcome{}, err
	}
	if !exists {
		if op.BaseRevisionID != "" {
			return Outcome{}, errors.New("new document must use empty base revision")
		}
		if _, err = tx.Exec(`INSERT INTO documents(document_id,title,path) VALUES(?,?,?)`, op.DocumentID, op.Title, path); err != nil {
			return Outcome{}, err
		}
	} else {
		if op.BaseRevisionID == "" {
			return Outcome{}, errors.New("existing document requires a known base revision")
		}
		if err := knownBase(tx, op.DocumentID, op.BaseRevisionID); err != nil {
			return Outcome{}, err
		}
	}
	candidate := revisionID(applyKind, op, "")
	if _, err = tx.Exec(`INSERT INTO revisions(revision_id,document_id,device_id,operation_id,operation_kind,base_revision_id,title,body,content_hash,source) VALUES(?,?,?,?,?,?,?,?,?,?)`, candidate, op.DocumentID, op.DeviceID, op.ID, applyKind, op.BaseRevisionID, op.Title, op.Body, bodyHash(op.Body), "device"); err != nil {
		return Outcome{}, err
	}
	out := Outcome{OperationID: op.ID, Status: "applied", RevisionID: candidate}
	detail := "{}"
	if exists && current.String != op.BaseRevisionID {
		out.Status = "conflict"
		out.ConflictID = conflictID(op.DocumentID, current.String, candidate)
		if _, err = tx.Exec(`INSERT INTO conflicts(conflict_id,document_id,current_revision_id,candidate_revision_id,status) VALUES(?,?,?,?, 'open')`, out.ConflictID, op.DocumentID, current.String, candidate); err != nil {
			return Outcome{}, err
		}
		detail = fmt.Sprintf(`{"conflict_id":%q}`, out.ConflictID)
	} else {
		result, err := tx.Exec(`UPDATE documents SET title=?,current_revision_id=? WHERE document_id=? AND current_revision_id IS ?`, op.Title, candidate, op.DocumentID, nullable(current.String, exists))
		if err != nil {
			return Outcome{}, err
		}
		changed, err := result.RowsAffected()
		if err != nil || changed != 1 {
			return Outcome{}, errors.New("document changed while applying operation")
		}
	}
	r, err := tx.Exec(`INSERT INTO events(kind,operation_id,document_id,revision_id,detail_json) VALUES(?,?,?,?,?)`, out.Status, op.ID, op.DocumentID, candidate, detail)
	if err != nil {
		return Outcome{}, err
	}
	out.Sequence, err = r.LastInsertId()
	if err != nil {
		return Outcome{}, err
	}
	if err := insertOperation(tx, applyKind, op, "", out); err != nil {
		return Outcome{}, err
	}
	if err := insertAudit(tx, out.Status, applyKind, op, candidate, detail); err != nil {
		return Outcome{}, err
	}
	if err := tx.Commit(); err != nil {
		return Outcome{}, err
	}
	return out, nil
}
func nullable(current string, exists bool) any {
	if !exists {
		return nil
	}
	return current
}
func (s *Store) PushBatch(ops []Operation) ([]Outcome, error) {
	out := make([]Outcome, 0, len(ops))
	for _, op := range ops {
		r, err := s.Apply(op)
		if err != nil {
			return out, err
		}
		out = append(out, r)
	}
	return out, nil
}

// Pull is read-only. A client persists a received cursor only through AckCursor.
func (s *Store) Pull(after int64, limit int) (PullResult, error) {
	if after < 0 || limit < 1 || limit > 1000 {
		return PullResult{}, errors.New("invalid pull cursor or limit")
	}
	rows, err := s.db.Query(`SELECT sequence,kind,operation_id,document_id,revision_id FROM events WHERE sequence>? ORDER BY sequence LIMIT ?`, after, limit)
	if err != nil {
		return PullResult{}, err
	}
	defer rows.Close()
	r := PullResult{Cursor: after}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.Sequence, &e.Kind, &e.OperationID, &e.DocumentID, &e.RevisionID); err != nil {
			return PullResult{}, err
		}
		r.Events = append(r.Events, e)
		r.Cursor = e.Sequence
	}
	return r, rows.Err()
}
func (s *Store) AckCursor(device string, cursor int64) error {
	if !validStableID(device) || cursor < 0 {
		return errors.New("invalid device or cursor")
	}
	var max int64
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(sequence),0) FROM events`).Scan(&max); err != nil {
		return err
	}
	if cursor > max {
		return errors.New("cursor is beyond current server sequence")
	}
	_, err := s.db.Exec(`INSERT INTO device_cursors(device_id,cursor) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET cursor=MAX(device_cursors.cursor,excluded.cursor)`, device, cursor)
	return err
}

func (s *Store) Resolve(conflict string, op Operation) (Outcome, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateOperation(op); err != nil {
		return Outcome{}, err
	}
	if !conflictIDRE.MatchString(conflict) {
		return Outcome{}, errors.New("invalid conflict ID")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Outcome{}, err
	}
	defer tx.Rollback()
	if out, found, err := replay(tx, resolveKind, op, conflict); found || err != nil {
		return out, err
	}
	var doc, conflictCurrent, status string
	if err := tx.QueryRow(`SELECT document_id,current_revision_id,status FROM conflicts WHERE conflict_id=?`, conflict).Scan(&doc, &conflictCurrent, &status); err != nil {
		return Outcome{}, err
	}
	if status != "open" {
		return Outcome{}, errors.New("conflict is not open")
	}
	if op.DocumentID != doc || op.BaseRevisionID != conflictCurrent {
		return Outcome{}, errors.New("resolution target or base does not match conflict")
	}
	if err := knownBase(tx, doc, op.BaseRevisionID); err != nil {
		return Outcome{}, err
	}
	var documentCurrent string
	if err := tx.QueryRow(`SELECT current_revision_id FROM documents WHERE document_id=?`, doc).Scan(&documentCurrent); err != nil {
		return Outcome{}, err
	}
	if documentCurrent != conflictCurrent {
		return Outcome{}, errors.New("document advanced since conflict; leave conflict open")
	}
	rev := revisionID(resolveKind, op, conflict)
	if _, err = tx.Exec(`INSERT INTO revisions(revision_id,document_id,device_id,operation_id,operation_kind,base_revision_id,title,body,content_hash,source) VALUES(?,?,?,?,?,?,?,?,?,?)`, rev, doc, op.DeviceID, op.ID, resolveKind, op.BaseRevisionID, op.Title, op.Body, bodyHash(op.Body), "resolution"); err != nil {
		return Outcome{}, err
	}
	update, err := tx.Exec(`UPDATE documents SET title=?,current_revision_id=? WHERE document_id=? AND current_revision_id=?`, op.Title, rev, doc, conflictCurrent)
	if err != nil {
		return Outcome{}, err
	}
	changed, err := update.RowsAffected()
	if err != nil || changed != 1 {
		return Outcome{}, errors.New("document changed while resolving conflict")
	}
	closed, err := tx.Exec(`UPDATE conflicts SET status='resolved',resolution_revision_id=? WHERE conflict_id=? AND status='open' AND current_revision_id=?`, rev, conflict, conflictCurrent)
	if err != nil {
		return Outcome{}, err
	}
	changed, err = closed.RowsAffected()
	if err != nil || changed != 1 {
		return Outcome{}, errors.New("conflict changed while resolving")
	}
	detail := fmt.Sprintf(`{"conflict_id":%q}`, conflict)
	r, err := tx.Exec(`INSERT INTO events(kind,operation_id,document_id,revision_id,detail_json) VALUES('resolved',?,?,?,?)`, op.ID, doc, rev, detail)
	if err != nil {
		return Outcome{}, err
	}
	seq, err := r.LastInsertId()
	if err != nil {
		return Outcome{}, err
	}
	out := Outcome{OperationID: op.ID, Status: "applied", RevisionID: rev, Sequence: seq}
	if err := insertOperation(tx, resolveKind, op, conflict, out); err != nil {
		return Outcome{}, err
	}
	if err := insertAudit(tx, "conflict_resolved", resolveKind, op, rev, detail); err != nil {
		return Outcome{}, err
	}
	if err := tx.Commit(); err != nil {
		return Outcome{}, err
	}
	return out, nil
}

func (s *Store) Revision(id string) (RevisionInfo, error) {
	if !revisionIDRE.MatchString(id) {
		return RevisionInfo{}, errors.New("invalid revision ID")
	}
	var r RevisionInfo
	err := s.db.QueryRow(`SELECT revision_id,document_id,title,body,content_hash FROM revisions WHERE revision_id=?`, id).Scan(&r.ID, &r.DocumentID, &r.Title, &r.Body, &r.ContentHash)
	return r, err
}
func (s *Store) CurrentRevision(document string) (string, error) {
	var x string
	err := s.db.QueryRow(`SELECT current_revision_id FROM documents WHERE document_id=?`, document).Scan(&x)
	return x, err
}
func (s *Store) PublishedRevision(document string) (string, error) {
	var x sql.NullString
	err := s.db.QueryRow(`SELECT published_revision_id FROM documents WHERE document_id=?`, document).Scan(&x)
	return x.String, err
}
func (s *Store) RevisionForDocumentPublished(document string) (RevisionInfo, error) {
	if !validStableID(document) {
		return RevisionInfo{}, errors.New("invalid document ID")
	}
	var published string
	if err := s.db.QueryRow(`SELECT COALESCE(published_revision_id,'') FROM documents WHERE document_id=?`, document).Scan(&published); err != nil {
		return RevisionInfo{}, err
	}
	if published == "" {
		return RevisionInfo{}, errors.New("document has no published revision")
	}
	return s.Revision(published)
}
func (s *Store) ConflictByID(id string) (Conflict, error) {
	var c Conflict
	err := s.db.QueryRow(`SELECT conflict_id,document_id,current_revision_id,candidate_revision_id,status,resolution_revision_id FROM conflicts WHERE conflict_id=?`, id).Scan(&c.ID, &c.DocumentID, &c.CurrentRevisionID, &c.CandidateRevisionID, &c.Status, &c.ResolutionRevisionID)
	return c, err
}
func (s *Store) DeviceCursor(device string) (int64, error) {
	var cursor int64
	err := s.db.QueryRow(`SELECT cursor FROM device_cursors WHERE device_id=?`, device).Scan(&cursor)
	return cursor, err
}
func (s *Store) Publication(rev string) (Publication, error) {
	var p Publication
	err := s.db.QueryRow(`SELECT state,commit_hash,base_commit,expected_published_revision_id FROM publications WHERE revision_id=?`, rev).Scan(&p.State, &p.Commit, &p.Base, &p.ExpectedPublished)
	return p, err
}
func (s *Store) ExpectedPublishedRevision(rev string) (string, error) {
	r, err := s.Revision(rev)
	if err != nil {
		return "", err
	}
	return s.PublishedRevision(r.DocumentID)
}
func (s *Store) GitState() (lastApp, base string, err error) {
	err = s.db.QueryRow(`SELECT last_app_commit,publication_base_commit FROM git_state WHERE singleton=1`).Scan(&lastApp, &base)
	return
}
func (s *Store) PublicationEligibility(rev string) (RevisionInfo, error) {
	r, err := s.Revision(rev)
	if err != nil {
		return RevisionInfo{}, err
	}
	var current string
	if err := s.db.QueryRow(`SELECT current_revision_id FROM documents WHERE document_id=?`, r.DocumentID).Scan(&current); err != nil {
		return RevisionInfo{}, err
	}
	if current != rev {
		return RevisionInfo{}, errors.New("only the current revision is publishable")
	}
	var open int
	if err := s.db.QueryRow(`SELECT count(*) FROM conflicts WHERE document_id=? AND status='open'`, r.DocumentID).Scan(&open); err != nil {
		return RevisionInfo{}, err
	}
	if open != 0 {
		return RevisionInfo{}, errors.New("document with an open conflict is not publishable")
	}
	return r, nil
}
func (s *Store) record(tx *sql.Tx, rev, state, class, commit, base, expected, detail string, updatePublication bool) error {
	if updatePublication {
		if _, err := tx.Exec(`INSERT INTO publications(revision_id,state,commit_hash,base_commit,expected_published_revision_id) VALUES(?,?,?,?,?) ON CONFLICT(revision_id) DO UPDATE SET state=excluded.state,commit_hash=excluded.commit_hash,base_commit=excluded.base_commit,expected_published_revision_id=excluded.expected_published_revision_id`, rev, state, commit, base, expected); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO publication_attempts(revision_id,state,class,commit_hash,base_commit,expected_published_revision_id,detail) VALUES(?,?,?,?,?,?,?)`, rev, state, class, commit, base, expected, detail); err != nil {
		return err
	}
	detailJSON, err := json.Marshal(map[string]string{"class": class, "commit": commit, "base": base, "expected_published_revision": expected, "detail": detail})
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO audit_events(action,revision_id,detail_json) VALUES(?,?,?)`, "publication_"+state, rev, string(detailJSON))
	return err
}
func (s *Store) RecordPublication(rev, state, class, commit, base, expected, detail string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.record(tx, rev, state, class, commit, base, expected, detail, true); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) AddPublicationAttempt(rev, state, class, commit, base, detail string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var expected string
	if err := tx.QueryRow(`SELECT expected_published_revision_id FROM publications WHERE revision_id=?`, rev).Scan(&expected); err != nil {
		return err
	}
	if err := s.record(tx, rev, state, class, commit, base, expected, detail, false); err != nil {
		return err
	}
	return tx.Commit()
}

// FinalizePublication atomically acknowledges a remote-accepted commit without
// rewinding a document or Git baseline that a newer publication has advanced.
func (s *Store) FinalizePublication(rev, commit, remoteHead, attemptState, detail string) (FinalizeResult, error) {
	result := FinalizeResult{}
	tx, err := s.db.Begin()
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var p Publication
	if err := tx.QueryRow(`SELECT state,commit_hash,base_commit,expected_published_revision_id FROM publications WHERE revision_id=?`, rev).Scan(&p.State, &p.Commit, &p.Base, &p.ExpectedPublished); err != nil {
		return result, err
	}
	if p.Commit != commit {
		return result, errors.New("finalization commit differs from durable intent")
	}
	var document string
	if err := tx.QueryRow(`SELECT document_id FROM revisions WHERE revision_id=?`, rev).Scan(&document); err != nil {
		return result, err
	}
	var pointer sql.NullString
	if err := tx.QueryRow(`SELECT published_revision_id FROM documents WHERE document_id=?`, document).Scan(&pointer); err != nil {
		return result, err
	}
	// Only the exact remote intent head may advance its predecessor pointer.
	if remoteHead == commit && pointer.String == p.ExpectedPublished {
		update, err := tx.Exec(`UPDATE documents SET published_revision_id=? WHERE document_id=? AND published_revision_id IS ?`, rev, document, nullable(p.ExpectedPublished, p.ExpectedPublished != ""))
		if err != nil {
			return result, err
		}
		changed, err := update.RowsAffected()
		if err != nil {
			return result, err
		}
		result.PointerAdvanced = changed == 1
	}
	// The baseline advances only from this intent's expected base and only when
	// the remote still names the intent commit. A newer baseline is preserved.
	if remoteHead == commit {
		update, err := tx.Exec(`UPDATE git_state SET last_app_commit=?,publication_base_commit=? WHERE singleton=1 AND publication_base_commit=?`, commit, commit, p.Base)
		if err != nil {
			return result, err
		}
		changed, err := update.RowsAffected()
		if err != nil {
			return result, err
		}
		result.GitAdvanced = changed == 1
	}
	if err := s.record(tx, rev, attemptState, "none", commit, p.Base, p.ExpectedPublished, detail, false); err != nil {
		return result, err
	}
	if _, err := tx.Exec(`UPDATE publications SET state='pushed' WHERE revision_id=?`, rev); err != nil {
		return result, err
	}
	result.Acknowledged = true
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}
func (s *Store) MarkReconciledBase(commit string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE git_state SET publication_base_commit=? WHERE singleton=1`, commit); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) Integrity() (bool, bool, error) {
	rows, err := s.db.Query(`PRAGMA integrity_check`)
	if err != nil {
		return false, false, err
	}
	defer rows.Close()
	integrity := true
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return false, false, err
		}
		if line != "ok" {
			integrity = false
		}
	}
	if err := rows.Err(); err != nil {
		return false, false, err
	}
	fkRows, err := s.db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return false, false, err
	}
	defer fkRows.Close()
	foreign := true
	for fkRows.Next() {
		foreign = false
		var table string
		var rowid sql.NullInt64
		var parent string
		var fkid int
		if err := fkRows.Scan(&table, &rowid, &parent, &fkid); err != nil {
			return false, false, err
		}
	}
	if err := fkRows.Err(); err != nil {
		return false, false, err
	}
	return integrity, foreign, nil
}
func (s *Store) Counts() (map[string]int, error) {
	names := []string{"documents", "revisions", "operations", "events", "device_cursors", "conflicts", "audit_events", "publications", "publication_attempts", "external_imports"}
	result := map[string]int{}
	for _, n := range names {
		var v int
		if err := s.db.QueryRow("SELECT count(*) FROM " + n).Scan(&v); err != nil {
			return nil, err
		}
		result[n] = v
	}
	return result, nil
}
func (s *Store) Audit() ([]map[string]string, error) {
	rows, err := s.db.Query(`SELECT audit_id,action,operation_id,device_id,document_id,revision_id,source_commit,actor,detail_json FROM audit_events ORDER BY audit_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]string
	for rows.Next() {
		var id int64
		var action, op, device, doc, rev, source, actor, detail string
		if err := rows.Scan(&id, &action, &op, &device, &doc, &rev, &source, &actor, &detail); err != nil {
			return nil, err
		}
		out = append(out, map[string]string{"audit_id": fmt.Sprint(id), "action": action, "operation_id": op, "device_id": device, "document_id": doc, "revision_id": rev, "source_commit": source, "actor": actor, "detail": detail})
	}
	return out, rows.Err()
}
func (s *Store) PublicationAttempts(rev string) ([]map[string]string, error) {
	rows, err := s.db.Query(`SELECT state,class,commit_hash,base_commit,expected_published_revision_id,detail FROM publication_attempts WHERE revision_id=? ORDER BY attempt_id`, rev)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]string
	for rows.Next() {
		var state, class, commit, base, expected, detail string
		if err := rows.Scan(&state, &class, &commit, &base, &expected, &detail); err != nil {
			return nil, err
		}
		out = append(out, map[string]string{"state": state, "class": class, "commit": commit, "base": base, "expected_published_revision": expected, "detail": detail})
	}
	return out, rows.Err()
}

type ExternalImportResult struct {
	Kind, DocumentID, RevisionID, ConflictID, SourceCommit string
	Sequence                                               int64
}

// ImportExternal is a durable, exactly-once import keyed by source Git commit
// and document identity. The remote's bytes are compared with the previously
// published database revision, not with a sidecar self-declaration.
func (s *Store) importExternalLocked(sourceCommit, actor, document, title string, body []byte) (ExternalImportResult, error) {
	if !validStableID(document) || sourceCommit == "" || !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 {
		return ExternalImportResult{}, errors.New("invalid external import identity or body")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return ExternalImportResult{}, err
	}
	defer tx.Rollback()
	var existing ExternalImportResult
	err = tx.QueryRow(`SELECT result_kind,document_id,revision_id,conflict_id,source_commit,sequence FROM external_imports WHERE source_commit=? AND document_id=?`, sourceCommit, document).Scan(&existing.Kind, &existing.DocumentID, &existing.RevisionID, &existing.ConflictID, &existing.SourceCommit, &existing.Sequence)
	if err == nil {
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return ExternalImportResult{}, err
	}
	var current, published string
	if err = tx.QueryRow(`SELECT current_revision_id,COALESCE(published_revision_id,'') FROM documents WHERE document_id=?`, document).Scan(&current, &published); err != nil {
		return ExternalImportResult{}, err
	}
	if published == "" {
		return ExternalImportResult{}, errors.New("external import requires a known published revision")
	}
	var publishedHash string
	if err = tx.QueryRow(`SELECT content_hash FROM revisions WHERE revision_id=? AND document_id=?`, published, document).Scan(&publishedHash); err != nil {
		return ExternalImportResult{}, err
	}
	if publishedHash == bodyHash(body) {
		return ExternalImportResult{Kind: "unchanged", DocumentID: document, SourceCommit: sourceCommit}, nil
	}
	revision := "rev-" + hash("external_git", sourceCommit, document, bodyHash(body))[:24]
	op := "external-" + hash(sourceCommit, document)[:24]
	if _, err = tx.Exec(`INSERT INTO revisions(revision_id,document_id,device_id,operation_id,operation_kind,base_revision_id,title,body,content_hash,source,source_commit,actor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, revision, document, "external", op, "external_import", published, title, body, bodyHash(body), "external_git", sourceCommit, actor); err != nil {
		return ExternalImportResult{}, err
	}
	result := ExternalImportResult{DocumentID: document, RevisionID: revision, SourceCommit: sourceCommit}
	detail := "{}"
	if current != published {
		result.Kind = "conflict"
		result.ConflictID = conflictID(document, current, revision)
		if _, err = tx.Exec(`INSERT INTO conflicts(conflict_id,document_id,current_revision_id,candidate_revision_id,status) VALUES(?,?,?,?, 'open')`, result.ConflictID, document, current, revision); err != nil {
			return ExternalImportResult{}, err
		}
		// Git now contains external bytes, so published moves to external while current remains local.
		if _, err = tx.Exec(`UPDATE documents SET published_revision_id=? WHERE document_id=?`, revision, document); err != nil {
			return ExternalImportResult{}, err
		}
		detail = fmt.Sprintf(`{"conflict_id":%q}`, result.ConflictID)
	} else {
		result.Kind = "imported"
		if _, err = tx.Exec(`UPDATE documents SET current_revision_id=?,published_revision_id=? WHERE document_id=?`, revision, revision, document); err != nil {
			return ExternalImportResult{}, err
		}
	}
	r, err := tx.Exec(`INSERT INTO events(kind,operation_id,document_id,revision_id,detail_json) VALUES(?,?,?,?,?)`, "external_"+result.Kind, op, document, revision, detail)
	if err != nil {
		return ExternalImportResult{}, err
	}
	result.Sequence, err = r.LastInsertId()
	if err != nil {
		return ExternalImportResult{}, err
	}
	if _, err = tx.Exec(`INSERT INTO external_imports(source_commit,document_id,revision_id,result_kind,conflict_id,sequence) VALUES(?,?,?,?,?,?)`, sourceCommit, document, revision, result.Kind, result.ConflictID, result.Sequence); err != nil {
		return ExternalImportResult{}, err
	}
	if _, err = tx.Exec(`INSERT INTO audit_events(action,operation_id,device_id,document_id,revision_id,source_commit,actor,detail_json) VALUES('external_reconciled',?,?,?,?,?,?,?)`, op, "external", document, revision, sourceCommit, actor, detail); err != nil {
		return ExternalImportResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return ExternalImportResult{}, err
	}
	return result, nil
}

func (s *Store) OpenConflictCount(document string) (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT count(*) FROM conflicts WHERE document_id=? AND status='open'`, document).Scan(&count)
	return count, err
}
