package v2publish

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
	sqlite "modernc.org/sqlite"
)

// Ledger is the durable publication state machine. It is safe to open from
// multiple processes; Git-side mutation additionally requires AcquireLease.
type Ledger struct {
	db           *sql.DB
	path         string
	lockPath     string
	lockIdentity string
}

func OpenLedger(path string, lockPath ...string) (*Ledger, error) {
	if path == "" || path == ":memory:" {
		return nil, codeError(CodeInvalidConfig, "publication ledger requires a filesystem SQLite path", nil)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve publication ledger path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return nil, fmt.Errorf("create publication ledger directory: %w", err)
	}
	if info, err := os.Lstat(absolute); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, codeError(CodeInvalidConfig, "publication ledger path is a symlink", nil)
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	realParent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return nil, fmt.Errorf("resolve publication ledger directory: %w", err)
	}
	absolute = filepath.Join(realParent, filepath.Base(absolute))
	lock := absolute + ".flock"
	if len(lockPath) > 0 && lockPath[0] != "" {
		lock, err = filepath.Abs(lockPath[0])
		if err != nil {
			return nil, fmt.Errorf("resolve publication lock path: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(lock), 0o700); err != nil {
			return nil, fmt.Errorf("create publication lock directory: %w", err)
		}
		if info, err := os.Lstat(lock); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return nil, codeError(CodeInvalidConfig, "publication lock path is a symlink", nil)
		} else if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		realLockParent, err := filepath.EvalSymlinks(filepath.Dir(lock))
		if err != nil {
			return nil, fmt.Errorf("resolve publication lock directory: %w", err)
		}
		lock = filepath.Join(realLockParent, filepath.Base(lock))
	}
	lockIdentity := "path:" + lock
	dsn := "file:" + absolute + "?_txlock=immediate&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	ledger := &Ledger{db: database, path: absolute, lockPath: lock, lockIdentity: lockIdentity}
	if err := ledger.migrate(); err != nil {
		_ = database.Close()
		return nil, err
	}
	if err := ledger.bindLockIdentity(); err != nil {
		_ = database.Close()
		return nil, err
	}
	return ledger, nil
}

func (l *Ledger) Close() error { return l.db.Close() }
func (l *Ledger) Path() string { return l.path }

func (l *Ledger) bindLockIdentity() error {
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var durable string
	if err := tx.QueryRow(`SELECT lock_path FROM v2publish_lock_identity WHERE singleton=1`).Scan(&durable); err != nil {
		return err
	}
	if durable == "" {
		if _, err := tx.Exec(`UPDATE v2publish_lock_identity SET lock_path=? WHERE singleton=1 AND lock_path=''`, l.lockIdentity); err != nil {
			return err
		}
	} else if durable != l.lockIdentity {
		return codeError(CodeInvalidConfig, "publication ledger is already bound to a different flock path", nil)
	}
	return tx.Commit()
}

func (l *Ledger) migrate() error {
	_, err := l.db.Exec(`
CREATE TABLE IF NOT EXISTS v2publish_schema(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2publish_lock_identity(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  lock_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2publish_archive(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner_id TEXT NOT NULL,
  bootstrap_manifest_sha256 TEXT NOT NULL,
  bootstrap_head TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2publish_lease(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  generation INTEGER NOT NULL CHECK(generation>=0),
  holder TEXT NOT NULL,
  acquired_unix INTEGER NOT NULL,
  disabled INTEGER NOT NULL CHECK(disabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS v2publish_git_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  initialized INTEGER NOT NULL CHECK(initialized IN (0,1)),
  base_commit TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2publish_intents(
  intent_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_schema TEXT NOT NULL,
  document_kind TEXT NOT NULL CHECK(document_kind IN ('lead-sheet','set-list')),
  path TEXT NOT NULL,
  source BLOB NOT NULL,
  source_sha256 TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  expected_current_revision_id TEXT NOT NULL,
  expected_published_revision_id TEXT NOT NULL,
  expected_git_base TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','commit_failed','committed','validation_failed','ineligible','remote_drift','finalized')),
  commit_hash TEXT NOT NULL,
  commit_unix INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  created_unix INTEGER NOT NULL,
  updated_unix INTEGER NOT NULL,
  UNIQUE(owner_id,document_id,revision_id)
);
CREATE TABLE IF NOT EXISTS v2publish_published_documents(
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  title TEXT NOT NULL,
  document_kind TEXT NOT NULL CHECK(document_kind IN ('lead-sheet','set-list')),
  path TEXT NOT NULL,
  source BLOB NOT NULL,
  source_sha256 TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  commit_hash TEXT NOT NULL,
  published_unix INTEGER NOT NULL,
  external_source INTEGER NOT NULL CHECK(external_source IN (0,1)),
  PRIMARY KEY(owner_id,document_id),
  UNIQUE(path)
);
CREATE TABLE IF NOT EXISTS v2publish_attempts(
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL,
  fence_generation INTEGER NOT NULL,
  holder TEXT NOT NULL,
  created_unix INTEGER NOT NULL,
  FOREIGN KEY(intent_id) REFERENCES v2publish_intents(intent_id)
);
CREATE TABLE IF NOT EXISTS v2publish_reconciliations(
  reconciliation_id TEXT PRIMARY KEY,
  conflict_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK(change_kind IN ('edit','delete','rename','rename-edit')),
  source_commit TEXT NOT NULL,
  actor TEXT NOT NULL,
  prior_published_revision_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  candidate_revision_id TEXT NOT NULL,
  prior_path TEXT NOT NULL,
  candidate_path TEXT NOT NULL,
  candidate_source BLOB NOT NULL,
  candidate_source_sha256 TEXT NOT NULL,
  candidate_deleted INTEGER NOT NULL CHECK(candidate_deleted IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  validation_error TEXT NOT NULL,
  detected_unix INTEGER NOT NULL,
  resolution_revision_id TEXT NOT NULL,
  UNIQUE(owner_id,document_id,source_commit)
);
CREATE TABLE IF NOT EXISTS v2publish_unowned_additions(
  addition_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  document_kind TEXT NOT NULL CHECK(document_kind IN ('lead-sheet','set-list')),
  path TEXT NOT NULL,
  source BLOB NOT NULL,
  source_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  detected_unix INTEGER NOT NULL,
  UNIQUE(owner_id,source_commit,path)
);
CREATE TABLE IF NOT EXISTS v2publish_audit(
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_unix INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2publish_intents_owner_document
  ON v2publish_intents(owner_id,document_id,created_unix);
CREATE INDEX IF NOT EXISTS v2publish_reconciliations_open
  ON v2publish_reconciliations(owner_id,document_id,status);
CREATE INDEX IF NOT EXISTS v2publish_unowned_additions_open
  ON v2publish_unowned_additions(owner_id,status);
INSERT OR IGNORE INTO v2publish_schema(singleton,version) VALUES(1,'v2publish-1');
INSERT OR IGNORE INTO v2publish_lock_identity(singleton,lock_path) VALUES(1,'');
INSERT OR IGNORE INTO v2publish_archive(singleton,owner_id,bootstrap_manifest_sha256,bootstrap_head) VALUES(1,'','','');
INSERT OR IGNORE INTO v2publish_lease(singleton,epoch,generation,holder,acquired_unix,disabled) VALUES(1,1,0,'',0,0);
INSERT OR IGNORE INTO v2publish_git_state(singleton,initialized,base_commit) VALUES(1,0,'');
`)
	if err != nil {
		return fmt.Errorf("migrate publication ledger: %w", err)
	}
	var version string
	if err := l.db.QueryRow(`SELECT version FROM v2publish_schema WHERE singleton=1`).Scan(&version); err != nil {
		return err
	}
	if version != SchemaVersion {
		return codeError(CodeInvalidConfig, fmt.Sprintf("unsupported publication ledger schema %q", version), nil)
	}
	return nil
}

func pathAvailableTx(tx *sql.Tx, owner, document, publicationPath, excludingIntent string) error {
	var existingOwner, existingDocument string
	err := tx.QueryRow(`SELECT owner_id,document_id FROM v2publish_published_documents WHERE path=?`, publicationPath).Scan(&existingOwner, &existingDocument)
	if err == nil && (existingOwner != owner || existingDocument != document) {
		return codeError(CodeIneligible, "canonical publication path is owned by another document", nil)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	err = tx.QueryRow(`SELECT owner_id,document_id FROM v2publish_intents WHERE path=? AND intent_id<>? AND state IN ('queued','commit_failed','committed','remote_drift') LIMIT 1`, publicationPath, excludingIntent).Scan(&existingOwner, &existingDocument)
	if err == nil && (existingOwner != owner || existingDocument != document) {
		return codeError(CodeIneligible, "canonical publication path is reserved by another active intent", nil)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

func bindArchiveOwnerTx(tx *sql.Tx, owner string) error {
	var durable string
	if err := tx.QueryRow(`SELECT owner_id FROM v2publish_archive WHERE singleton=1`).Scan(&durable); err != nil {
		return err
	}
	if durable == "" {
		_, err := tx.Exec(`UPDATE v2publish_archive SET owner_id=? WHERE singleton=1 AND owner_id=''`, owner)
		return err
	}
	if durable != owner {
		return codeError(CodeIneligible, "publication ledger is bound to another archive owner", nil)
	}
	return nil
}

func (l *Ledger) ArchiveOwner() (string, error) {
	var owner string
	err := l.db.QueryRow(`SELECT owner_id FROM v2publish_archive WHERE singleton=1`).Scan(&owner)
	return owner, err
}

func (l *Ledger) LeaseState() (LeaseState, error) {
	var state LeaseState
	if err := l.db.QueryRow(`SELECT epoch,generation,holder,acquired_unix FROM v2publish_lease WHERE singleton=1`).Scan(&state.Epoch, &state.Generation, &state.Holder, &state.AcquiredUnix); err != nil {
		return LeaseState{}, err
	}
	return state, nil
}

func assertFenceTx(tx *sql.Tx, token FenceToken) error {
	var epoch, generation int64
	var holder string
	var disabled int
	if err := tx.QueryRow(`SELECT epoch,generation,holder,disabled FROM v2publish_lease WHERE singleton=1`).Scan(&epoch, &generation, &holder, &disabled); err != nil {
		return err
	}
	if disabled != 0 || epoch != token.Epoch || generation != token.Generation || holder != token.Holder || holder == "" {
		return codeError(CodeStaleFence, "publication lease token is stale", nil)
	}
	return nil
}

func (l *Ledger) AssertFence(token FenceToken) error {
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	return assertFenceTx(tx, token)
}

func (l *Ledger) AssertIntentPath(token FenceToken, id string) error {
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	intent, err := scanIntent(tx.QueryRow(selectIntent+` WHERE intent_id=?`, id))
	if err != nil {
		return err
	}
	return pathAvailableTx(tx, intent.OwnerID, intent.DocumentID, intent.Payload.Path, intent.ID)
}

func (l *Ledger) GitBase() (base string, initialized bool, err error) {
	var value int
	err = l.db.QueryRow(`SELECT initialized,base_commit FROM v2publish_git_state WHERE singleton=1`).Scan(&value, &base)
	return base, value != 0, err
}

func (l *Ledger) InitializeGitBase(token FenceToken, head string, now time.Time) error {
	if head != "" && !validGitHash(head) {
		return codeError(CodeUnsupportedGitState, "invalid Git head while initializing ledger", nil)
	}
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	var initialized int
	var base string
	if err := tx.QueryRow(`SELECT initialized,base_commit FROM v2publish_git_state WHERE singleton=1`).Scan(&initialized, &base); err != nil {
		return err
	}
	if initialized != 0 {
		if base != head {
			return codeError(CodeRemoteDrift, "remote head differs from initialized publication base", nil)
		}
		return nil
	}
	var count int64
	if err := tx.QueryRow(`SELECT (SELECT count(*) FROM v2publish_intents)+(SELECT count(*) FROM v2publish_published_documents)`).Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return codeError(CodeIntegrity, "uninitialized Git base has durable publication rows", nil)
	}
	if _, err := tx.Exec(`UPDATE v2publish_git_state SET initialized=1,base_commit=? WHERE singleton=1`, head); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('git-base-initialized','','','','',?,'',?)`, head, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func scanIntent(scanner interface{ Scan(...any) error }) (Intent, error) {
	var intent Intent
	var kind string
	var source []byte
	var deleted int
	err := scanner.Scan(
		&intent.ID, &intent.OwnerID, &intent.DeviceID, &intent.DocumentID, &intent.RevisionID, &intent.Title,
		&intent.Payload.SchemaVersion, &kind, &intent.Payload.Path, &source, &intent.SourceSHA256, &deleted,
		&intent.ExpectedCurrentRevisionID, &intent.ExpectedPublishedRevisionID, &intent.ExpectedGitBase,
		&intent.State, &intent.CommitHash, &intent.CommitUnix, &intent.LastError, &intent.CreatedUnix, &intent.UpdatedUnix,
	)
	if err != nil {
		return Intent{}, err
	}
	intent.Payload.Kind = DocumentKind(kind)
	intent.Payload.Source = string(source)
	intent.Payload.Deleted = deleted != 0
	return intent, nil
}

const selectIntent = `SELECT intent_id,owner_id,device_id,document_id,revision_id,title,payload_schema,document_kind,path,source,source_sha256,deleted,expected_current_revision_id,expected_published_revision_id,expected_git_base,state,commit_hash,commit_unix,last_error,created_unix,updated_unix FROM v2publish_intents`

func (l *Ledger) Intent(id string) (Intent, error) {
	intent, err := scanIntent(l.db.QueryRow(selectIntent+` WHERE intent_id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Intent{}, codeError(CodeNotFound, "publication intent not found", err)
	}
	return intent, err
}

func (l *Ledger) CommittedIntents(owner string) ([]Intent, error) {
	rows, err := l.db.Query(selectIntent+` WHERE owner_id=? AND state='committed' ORDER BY created_unix,intent_id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var intents []Intent
	for rows.Next() {
		intent, err := scanIntent(rows)
		if err != nil {
			return nil, err
		}
		intents = append(intents, intent)
	}
	return intents, rows.Err()
}

func (l *Ledger) IntentForRevision(owner, document, revision string) (Intent, error) {
	intent, err := scanIntent(l.db.QueryRow(selectIntent+` WHERE owner_id=? AND document_id=? AND revision_id=?`, owner, document, revision))
	if errors.Is(err, sql.ErrNoRows) {
		return Intent{}, codeError(CodeNotFound, "publication intent not found", err)
	}
	return intent, err
}

func publishedTx(tx *sql.Tx, owner, document string) (PublishedDocument, error) {
	var result PublishedDocument
	var kind string
	var deleted, external int
	err := tx.QueryRow(`SELECT owner_id,document_id,revision_id,title,document_kind,path,source,source_sha256,deleted,commit_hash,published_unix,external_source FROM v2publish_published_documents WHERE owner_id=? AND document_id=?`, owner, document).Scan(
		&result.OwnerID, &result.DocumentID, &result.RevisionID, &result.Title, &kind, &result.Path, &result.Source, &result.SourceSHA256, &deleted, &result.CommitHash, &result.PublishedUnix, &external,
	)
	result.Kind, result.Deleted, result.ExternalSource = DocumentKind(kind), deleted != 0, external != 0
	return result, err
}

func (l *Ledger) BootstrapDocuments(token FenceToken, owner, head, manifestHash string, documents []BootstrapDocument, now time.Time) error {
	if !validOwner(owner) || head == "" || !validGitHash(head) || !sha256RE.MatchString(manifestHash) || len(documents) == 0 {
		return codeError(CodeInvalidPayload, "invalid archive bootstrap identity", nil)
	}
	seenDocuments, seenPaths := map[string]bool{}, map[string]bool{}
	for _, document := range documents {
		if !validStableID(document.DocumentID) || !validRevision(document.RevisionID) || document.Title == "" || strings.TrimSpace(document.Title) != document.Title || document.Kind != LeadSheet && document.Kind != SetList || len(document.Source) == 0 || !utf8.Valid(document.Source) || bytes.IndexByte(document.Source, 0) >= 0 {
			return codeError(CodeInvalidPayload, "invalid archive bootstrap document", nil)
		}
		if err := ValidatePublicationPath(document.Kind, document.Path); err != nil {
			return err
		}
		if seenDocuments[document.DocumentID] || seenPaths[document.Path] {
			return codeError(CodeInvalidPayload, "duplicate archive bootstrap identity or path", nil)
		}
		seenDocuments[document.DocumentID], seenPaths[document.Path] = true, true
	}
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	if err := bindArchiveOwnerTx(tx, owner); err != nil {
		return err
	}
	var initialized int
	var base string
	if err := tx.QueryRow(`SELECT initialized,base_commit FROM v2publish_git_state WHERE singleton=1`).Scan(&initialized, &base); err != nil {
		return err
	}
	if initialized == 0 || base != head {
		return codeError(CodeRemoteDrift, "archive bootstrap head differs from durable Git base", nil)
	}
	var existing int64
	if err := tx.QueryRow(`SELECT count(*) FROM v2publish_published_documents`).Scan(&existing); err != nil {
		return err
	}
	if existing != 0 {
		var storedManifest, storedHead string
		if err := tx.QueryRow(`SELECT bootstrap_manifest_sha256,bootstrap_head FROM v2publish_archive WHERE singleton=1`).Scan(&storedManifest, &storedHead); err != nil {
			return err
		}
		if existing != int64(len(documents)) || storedManifest != manifestHash || storedHead != head {
			return codeError(CodeReplayMismatch, "archive bootstrap replay differs from durable baseline", nil)
		}
		for _, document := range documents {
			published, err := publishedTx(tx, owner, document.DocumentID)
			if err != nil || published.RevisionID != document.RevisionID || published.Title != document.Title || published.Kind != document.Kind || published.Path != document.Path || published.Deleted || !bytes.Equal(published.Source, document.Source) || published.CommitHash != head {
				return codeError(CodeReplayMismatch, "archive bootstrap replay document differs", err)
			}
		}
		return nil
	}
	for _, document := range documents {
		if _, err := tx.Exec(`INSERT INTO v2publish_published_documents(owner_id,document_id,revision_id,title,document_kind,path,source,source_sha256,deleted,commit_hash,published_unix,external_source) VALUES(?,?,?,?,?,?,?,?,0,?,?,0)`, owner, document.DocumentID, document.RevisionID, document.Title, string(document.Kind), document.Path, document.Source, sourceHash(document.Source), head, now.Unix()); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE v2publish_archive SET bootstrap_manifest_sha256=?,bootstrap_head=? WHERE singleton=1`, manifestHash, head); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('archive-bootstrap',?,'','','',?,?,?)`, owner, head, fmt.Sprintf("documents=%d", len(documents)), now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Ledger) PublishedDocument(owner, document string) (PublishedDocument, error) {
	tx, err := l.db.Begin()
	if err != nil {
		return PublishedDocument{}, err
	}
	defer tx.Rollback()
	result, err := publishedTx(tx, owner, document)
	if errors.Is(err, sql.ErrNoRows) {
		return PublishedDocument{}, codeError(CodeNotFound, "published document not found", err)
	}
	return result, err
}

func (l *Ledger) PublishedDocuments(owner string) ([]PublishedDocument, error) {
	rows, err := l.db.Query(`SELECT owner_id,document_id,revision_id,title,document_kind,path,source,source_sha256,deleted,commit_hash,published_unix,external_source FROM v2publish_published_documents WHERE owner_id=? ORDER BY document_id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []PublishedDocument
	for rows.Next() {
		var item PublishedDocument
		var kind string
		var deleted, external int
		if err := rows.Scan(&item.OwnerID, &item.DocumentID, &item.RevisionID, &item.Title, &kind, &item.Path, &item.Source, &item.SourceSHA256, &deleted, &item.CommitHash, &item.PublishedUnix, &external); err != nil {
			return nil, err
		}
		item.Kind, item.Deleted, item.ExternalSource = DocumentKind(kind), deleted != 0, external != 0
		result = append(result, item)
	}
	return result, rows.Err()
}

func (l *Ledger) CreateIntent(token FenceToken, revisionTitle string, owner, device, document, revision string, payload PublicationPayload, expectedCurrent, expectedPublished, expectedBase string, now time.Time) (Intent, bool, error) {
	if !validOwner(owner) || !validStableID(device) || !validStableID(document) || !validRevision(revision) || expectedCurrent != revision || expectedPublished != "" && !validArchiveRevision(expectedPublished) || expectedBase != "" && !validGitHash(expectedBase) || revisionTitle == "" || len(revisionTitle) > 512 || !utf8.ValidString(revisionTitle) || strings.ContainsRune(revisionTitle, 0) {
		return Intent{}, false, codeError(CodeInvalidPayload, "invalid durable publication intent fields", nil)
	}
	if err := validatePayloadValue(payload); err != nil {
		return Intent{}, false, err
	}
	id := publicationIntentID(owner, document, revision)
	hash := sourceHash([]byte(payload.Source))
	tx, err := l.db.Begin()
	if err != nil {
		return Intent{}, false, err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return Intent{}, false, err
	}
	if err := bindArchiveOwnerTx(tx, owner); err != nil {
		return Intent{}, false, err
	}
	if err := pathAvailableTx(tx, owner, document, payload.Path, id); err != nil {
		return Intent{}, false, err
	}
	existing, scanErr := scanIntent(tx.QueryRow(selectIntent+` WHERE intent_id=?`, id))
	if scanErr == nil {
		if existing.OwnerID != owner || existing.DeviceID != device || existing.DocumentID != document || existing.RevisionID != revision || existing.Title != revisionTitle || existing.Payload != payload || existing.ExpectedCurrentRevisionID != expectedCurrent || existing.ExpectedPublishedRevisionID != expectedPublished || existing.ExpectedGitBase != expectedBase {
			return Intent{}, true, codeError(CodeReplayMismatch, "publication intent replay differs from durable intent", nil)
		}
		return existing, true, nil
	}
	if !errors.Is(scanErr, sql.ErrNoRows) {
		return Intent{}, false, scanErr
	}
	commitUnix := now.UTC().Unix()
	_, err = tx.Exec(`INSERT INTO v2publish_intents(intent_id,owner_id,device_id,document_id,revision_id,title,payload_schema,document_kind,path,source,source_sha256,deleted,expected_current_revision_id,expected_published_revision_id,expected_git_base,state,commit_hash,commit_unix,last_error,created_unix,updated_unix) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued','',?,'',?,?)`,
		id, owner, device, document, revision, revisionTitle, payload.SchemaVersion, string(payload.Kind), payload.Path, []byte(payload.Source), hash, boolInt(payload.Deleted), expectedCurrent, expectedPublished, expectedBase, commitUnix, now.Unix(), now.Unix())
	if err != nil {
		return Intent{}, false, err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('intent-created',?,?,?,?,?,'',?)`, owner, document, revision, id, expectedBase, now.Unix()); err != nil {
		return Intent{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Intent{}, false, err
	}
	created, err := l.Intent(id)
	return created, false, err
}

func (l *Ledger) setIntentState(token FenceToken, id string, state IntentState, commit, detail string, now time.Time) error {
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	result, err := tx.Exec(`UPDATE v2publish_intents SET state=?,commit_hash=CASE WHEN ?='' THEN commit_hash ELSE ? END,last_error=?,updated_unix=? WHERE intent_id=?`, state, commit, commit, detail, now.Unix(), id)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return err
		}
		return codeError(CodeNotFound, "publication intent not found", nil)
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_attempts(intent_id,state,detail,commit_hash,fence_epoch,fence_generation,holder,created_unix) VALUES(?,?,?,?,?,?,?,?)`, id, string(state), detail, commit, token.Epoch, token.Generation, token.Holder, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Ledger) RebaseIntent(token FenceToken, id, expectedBase string, now time.Time) error {
	if expectedBase != "" && !validGitHash(expectedBase) {
		return codeError(CodeUnsupportedGitState, "invalid reconciled Git base", nil)
	}
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	intent, err := scanIntent(tx.QueryRow(selectIntent+` WHERE intent_id=?`, id))
	if err != nil {
		return err
	}
	if intent.State == IntentFinalized || intent.State == IntentValidationFailed || intent.State == IntentIneligible {
		return codeError(CodeIneligible, "terminal publication intent cannot be rebased", nil)
	}
	if _, err := tx.Exec(`UPDATE v2publish_intents SET expected_git_base=?,state='queued',commit_hash='',last_error='',commit_unix=?,updated_unix=? WHERE intent_id=?`, expectedBase, now.Unix(), now.Unix(), id); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_attempts(intent_id,state,detail,commit_hash,fence_epoch,fence_generation,holder,created_unix) VALUES(?,'queued','rebased immutable revision on reconciled Git head','',?,?,?,?)`, id, token.Epoch, token.Generation, token.Holder, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Ledger) RecordFailure(token FenceToken, id string, state IntentState, commit string, cause error, now time.Time) error {
	detail := ""
	if cause != nil {
		detail = cause.Error()
	}
	return l.setIntentState(token, id, state, commit, detail, now)
}

func (l *Ledger) MarkCommitted(token FenceToken, id, commit string, now time.Time) error {
	if !validGitHash(commit) {
		return codeError(CodeUnsupportedGitState, "invalid deterministic commit hash", nil)
	}
	return l.setIntentState(token, id, IntentCommitted, commit, "local commit created", now)
}

func (l *Ledger) Finalize(token FenceToken, id, commit string, now time.Time) error {
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	intent, err := scanIntent(tx.QueryRow(selectIntent+` WHERE intent_id=?`, id))
	if err != nil {
		return err
	}
	if intent.CommitHash != commit || !validGitHash(commit) {
		return codeError(CodeIntegrity, "finalization commit does not match durable intent", nil)
	}
	var initialized int
	var base string
	if err := tx.QueryRow(`SELECT initialized,base_commit FROM v2publish_git_state WHERE singleton=1`).Scan(&initialized, &base); err != nil {
		return err
	}
	if initialized == 0 || base != intent.ExpectedGitBase {
		return codeError(CodeRemoteDrift, "publication Git base changed before finalization", nil)
	}
	if err := pathAvailableTx(tx, intent.OwnerID, intent.DocumentID, intent.Payload.Path, intent.ID); err != nil {
		return err
	}
	prior, err := publishedTx(tx, intent.OwnerID, intent.DocumentID)
	if errors.Is(err, sql.ErrNoRows) {
		if intent.ExpectedPublishedRevisionID != "" {
			return codeError(CodeIneligible, "expected prior published revision is absent", nil)
		}
	} else if err != nil {
		return err
	} else if prior.RevisionID != intent.ExpectedPublishedRevisionID {
		return codeError(CodeIneligible, "published revision changed before finalization", nil)
	}
	_, err = tx.Exec(`INSERT INTO v2publish_published_documents(owner_id,document_id,revision_id,title,document_kind,path,source,source_sha256,deleted,commit_hash,published_unix,external_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)
ON CONFLICT(owner_id,document_id) DO UPDATE SET revision_id=excluded.revision_id,title=excluded.title,document_kind=excluded.document_kind,path=excluded.path,source=excluded.source,source_sha256=excluded.source_sha256,deleted=excluded.deleted,commit_hash=excluded.commit_hash,published_unix=excluded.published_unix,external_source=0`,
		intent.OwnerID, intent.DocumentID, intent.RevisionID, intent.Title, string(intent.Payload.Kind), intent.Payload.Path, []byte(intent.Payload.Source), intent.SourceSHA256, boolInt(intent.Payload.Deleted), commit, now.Unix())
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE v2publish_git_state SET base_commit=? WHERE singleton=1 AND base_commit=?`, commit, intent.ExpectedGitBase); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE v2publish_intents SET state='finalized',last_error='',updated_unix=? WHERE intent_id=?`, now.Unix(), id); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_attempts(intent_id,state,detail,commit_hash,fence_epoch,fence_generation,holder,created_unix) VALUES(?,'finalized','remote accepted and ledger finalized',?,?,?,?,?)`, id, commit, token.Epoch, token.Generation, token.Holder, now.Unix()); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('publication-finalized',?,?,?,?,?,'',?)`, intent.OwnerID, intent.DocumentID, intent.RevisionID, id, commit, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Ledger) AcknowledgeAncestor(token FenceToken, id, commit string, now time.Time) error {
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	intent, err := scanIntent(tx.QueryRow(selectIntent+` WHERE intent_id=?`, id))
	if err != nil {
		return err
	}
	if intent.CommitHash != commit || !validGitHash(commit) {
		return codeError(CodeIntegrity, "ancestor acknowledgement does not match durable intent", nil)
	}
	if _, err := tx.Exec(`UPDATE v2publish_intents SET state='finalized',last_error='',updated_unix=? WHERE intent_id=?`, now.Unix(), id); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_attempts(intent_id,state,detail,commit_hash,fence_epoch,fence_generation,holder,created_unix) VALUES(?,'finalized','acknowledged as an ancestor of a newer durable publication',?,?,?,?,?)`, id, commit, token.Epoch, token.Generation, token.Holder, now.Unix()); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('publication-ancestor-acknowledged',?,?,?,?,?,'',?)`, intent.OwnerID, intent.DocumentID, intent.RevisionID, id, commit, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Ledger) OpenReconciliationCount(owner, document string) (int64, error) {
	var count int64
	err := l.db.QueryRow(`SELECT count(*) FROM v2publish_reconciliations WHERE owner_id=? AND document_id=? AND status='open'`, owner, document).Scan(&count)
	return count, err
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (l *Ledger) Integrity() error {
	var result string
	if err := l.db.QueryRow(`PRAGMA integrity_check`).Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return codeError(CodeIntegrity, "SQLite integrity check failed: "+result, nil)
	}
	rows, err := l.db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return codeError(CodeIntegrity, "SQLite foreign-key check failed", nil)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var bad int64
	hashRows, err := l.db.Query(`SELECT source,source_sha256 FROM v2publish_intents UNION ALL SELECT source,source_sha256 FROM v2publish_published_documents UNION ALL SELECT candidate_source,candidate_source_sha256 FROM v2publish_reconciliations UNION ALL SELECT source,source_sha256 FROM v2publish_unowned_additions`)
	if err != nil {
		return err
	}
	for hashRows.Next() {
		var source []byte
		var hash string
		if err := hashRows.Scan(&source, &hash); err != nil {
			hashRows.Close()
			return err
		}
		if sourceHash(source) != hash {
			bad++
		}
	}
	if err := hashRows.Close(); err != nil {
		return err
	}
	if bad != 0 {
		return codeError(CodeIntegrity, fmt.Sprintf("%d durable source hashes do not match bytes", bad), nil)
	}
	owner, err := l.ArchiveOwner()
	if err != nil {
		return err
	}
	var rowCount, wrongOwner int64
	if err := l.db.QueryRow(`SELECT (SELECT count(*) FROM v2publish_intents)+(SELECT count(*) FROM v2publish_published_documents)+(SELECT count(*) FROM v2publish_reconciliations)+(SELECT count(*) FROM v2publish_unowned_additions)`).Scan(&rowCount); err != nil {
		return err
	}
	if rowCount != 0 && owner == "" {
		return codeError(CodeIntegrity, "durable publication rows exist without an archive owner binding", nil)
	}
	if owner != "" {
		if err := l.db.QueryRow(`SELECT (SELECT count(*) FROM v2publish_intents WHERE owner_id<>?)+(SELECT count(*) FROM v2publish_published_documents WHERE owner_id<>?)+(SELECT count(*) FROM v2publish_reconciliations WHERE owner_id<>?)+(SELECT count(*) FROM v2publish_unowned_additions WHERE owner_id<>?)`, owner, owner, owner, owner).Scan(&wrongOwner); err != nil {
			return err
		}
		if wrongOwner != 0 {
			return codeError(CodeIntegrity, "publication rows cross the archive owner boundary", nil)
		}
	}
	base, initialized, err := l.GitBase()
	if err != nil {
		return err
	}
	if initialized && base != "" && !validGitHash(base) || !initialized && base != "" {
		return codeError(CodeIntegrity, "durable Git base is malformed", nil)
	}
	intentRows, err := l.db.Query(`SELECT document_kind,path,source,deleted,state,commit_hash FROM v2publish_intents`)
	if err != nil {
		return err
	}
	for intentRows.Next() {
		var kind, publicationPath, state, commit string
		var source []byte
		var deleted int
		if err := intentRows.Scan(&kind, &publicationPath, &source, &deleted, &state, &commit); err != nil {
			intentRows.Close()
			return err
		}
		if err := ValidatePublicationPath(DocumentKind(kind), publicationPath); err != nil || deleted == 0 && len(source) == 0 || deleted != 0 && len(source) != 0 || (state == string(IntentCommitted) || state == string(IntentFinalized)) && !validGitHash(commit) || state == string(IntentFinalized) && commit == "" {
			intentRows.Close()
			return codeError(CodeIntegrity, "publication intent semantic invariant failed", err)
		}
	}
	if err := intentRows.Close(); err != nil {
		return err
	}
	publishedRows, err := l.db.Query(`SELECT document_kind,path,source,deleted,commit_hash FROM v2publish_published_documents`)
	if err != nil {
		return err
	}
	for publishedRows.Next() {
		var kind, publicationPath, commit string
		var source []byte
		var deleted int
		if err := publishedRows.Scan(&kind, &publicationPath, &source, &deleted, &commit); err != nil {
			publishedRows.Close()
			return err
		}
		if err := ValidatePublicationPath(DocumentKind(kind), publicationPath); err != nil || deleted == 0 && len(source) == 0 || deleted != 0 && len(source) != 0 || !validGitHash(commit) {
			publishedRows.Close()
			return codeError(CodeIntegrity, "published document semantic invariant failed", err)
		}
	}
	if err := publishedRows.Close(); err != nil {
		return err
	}
	reconciliationRows, err := l.db.Query(`SELECT candidate_path,candidate_source,candidate_deleted,source_commit,candidate_revision_id FROM v2publish_reconciliations`)
	if err != nil {
		return err
	}
	for reconciliationRows.Next() {
		var candidatePath, sourceCommit, candidateRevision string
		var source []byte
		var deleted int
		if err := reconciliationRows.Scan(&candidatePath, &source, &deleted, &sourceCommit, &candidateRevision); err != nil {
			reconciliationRows.Close()
			return err
		}
		kind := LeadSheet
		if strings.HasPrefix(candidatePath, "sets/") {
			kind = SetList
		}
		if err := ValidatePublicationPath(kind, candidatePath); err != nil || deleted == 0 && len(source) == 0 || deleted != 0 && len(source) != 0 || !validGitHash(sourceCommit) || !strings.HasPrefix(candidateRevision, "ext-") {
			reconciliationRows.Close()
			return codeError(CodeIntegrity, "reconciliation semantic invariant failed", err)
		}
	}
	if err := reconciliationRows.Close(); err != nil {
		return err
	}
	additionRows, err := l.db.Query(`SELECT document_kind,path,source,source_commit,addition_id,status FROM v2publish_unowned_additions`)
	if err != nil {
		return err
	}
	for additionRows.Next() {
		var kind, additionPath, sourceCommit, additionID, status string
		var source []byte
		if err := additionRows.Scan(&kind, &additionPath, &source, &sourceCommit, &additionID, &status); err != nil {
			additionRows.Close()
			return err
		}
		if err := ValidatePublicationPath(DocumentKind(kind), additionPath); err != nil || len(source) == 0 || !validGitHash(sourceCommit) || additionID != unownedAdditionID(owner, sourceCommit, additionPath, source) || status != "open" && status != "resolved" {
			additionRows.Close()
			return codeError(CodeIntegrity, "unowned addition semantic invariant failed", err)
		}
	}
	if err := additionRows.Close(); err != nil {
		return err
	}
	return nil
}

func (l *Ledger) Backup(destination string) error {
	if destination == "" {
		return codeError(CodeInvalidConfig, "empty ledger backup destination", nil)
	}
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if absolute == l.path || absolute == l.path+"-wal" || absolute == l.path+"-shm" || absolute == l.lockPath {
		return codeError(CodeInvalidConfig, "ledger backup destination collides with live publication state", nil)
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return err
	}
	if err := os.Remove(absolute); err != nil && !os.IsNotExist(err) {
		return err
	}
	connection, err := l.db.Conn(context.Background())
	if err != nil {
		return err
	}
	defer connection.Close()
	err = connection.Raw(func(driverConnection any) error {
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
	if err != nil {
		return err
	}
	// The flock path is an installation property, not publication evidence.
	// Clear it in the copy so a restored ledger can bind one canonical lock for
	// its new location without weakening the source ledger's binding.
	backupDB, err := sql.Open("sqlite", "file:"+absolute+"?_txlock=immediate&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	if _, err := backupDB.Exec(`UPDATE v2publish_lock_identity SET lock_path='' WHERE singleton=1`); err != nil {
		_ = backupDB.Close()
		return err
	}
	return backupDB.Close()
}

func (l *Ledger) AuditCount(action string) (int64, error) {
	var count int64
	var err error
	if strings.TrimSpace(action) == "" {
		err = l.db.QueryRow(`SELECT count(*) FROM v2publish_audit`).Scan(&count)
	} else {
		err = l.db.QueryRow(`SELECT count(*) FROM v2publish_audit WHERE action=?`, action).Scan(&count)
	}
	return count, err
}

func scanReconciliation(scanner interface{ Scan(...any) error }) (Reconciliation, error) {
	var result Reconciliation
	var kind string
	var deleted int
	err := scanner.Scan(
		&result.ID, &result.ConflictID, &result.OwnerID, &result.DocumentID, &kind, &result.SourceCommit, &result.Actor,
		&result.PriorPublishedRevisionID, &result.CurrentRevisionID, &result.CandidateRevisionID,
		&result.PriorPath, &result.CandidatePath, &result.CandidateSource, &result.CandidateSourceSHA256, &deleted,
		&result.Status, &result.ValidationError, &result.DetectedUnix, &result.ResolutionRevisionID,
	)
	result.Kind = ReconciliationKind(kind)
	result.CandidateDeleted = deleted != 0
	return result, err
}

const selectReconciliation = `SELECT reconciliation_id,conflict_id,owner_id,document_id,change_kind,source_commit,actor,prior_published_revision_id,current_revision_id,candidate_revision_id,prior_path,candidate_path,candidate_source,candidate_source_sha256,candidate_deleted,status,validation_error,detected_unix,resolution_revision_id FROM v2publish_reconciliations`

func (l *Ledger) Reconciliation(conflictID string) (Reconciliation, error) {
	result, err := scanReconciliation(l.db.QueryRow(selectReconciliation+` WHERE conflict_id=?`, conflictID))
	if errors.Is(err, sql.ErrNoRows) {
		return Reconciliation{}, codeError(CodeNotFound, "reconciliation conflict not found", err)
	}
	return result, err
}

func (l *Ledger) RecordReconciliations(token FenceToken, owner, expectedBase, sourceCommit string, records []Reconciliation, now time.Time) error {
	if !validOwner(owner) || sourceCommit == "" || !validGitHash(sourceCommit) || expectedBase != "" && !validGitHash(expectedBase) {
		return codeError(CodeInvalidPayload, "invalid reconciliation owner or Git identity", nil)
	}
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	if err := bindArchiveOwnerTx(tx, owner); err != nil {
		return err
	}
	var initialized int
	var base string
	if err := tx.QueryRow(`SELECT initialized,base_commit FROM v2publish_git_state WHERE singleton=1`).Scan(&initialized, &base); err != nil {
		return err
	}
	if initialized == 0 || base != expectedBase {
		return codeError(CodeRemoteDrift, "durable Git base changed during reconciliation", nil)
	}
	for _, record := range records {
		candidateMatches := record.CandidateRevisionID == externalRevisionID(owner, record.DocumentID, sourceCommit, record.CandidatePath, record.CandidateDeleted, record.CandidateSource) || validRevision(record.CandidateRevisionID)
		if record.OwnerID != owner || record.SourceCommit != sourceCommit || record.ID != reconciliationID(owner, record.DocumentID, sourceCommit) || !validReconciliationConflict(record.ConflictID) || !candidateMatches || record.CandidateSourceSHA256 != sourceHash(record.CandidateSource) || record.CurrentRevisionID != "" && !validRevision(record.CurrentRevisionID) || record.Actor == "" || len(record.Actor) > 255 || strings.ContainsRune(record.Actor, 0) {
			return codeError(CodeInvalidPayload, "invalid durable reconciliation record", nil)
		}
		prior, err := publishedTx(tx, record.OwnerID, record.DocumentID)
		if err != nil {
			return err
		}
		if err := ValidatePublicationPath(prior.Kind, record.CandidatePath); err != nil || record.CandidateDeleted && len(record.CandidateSource) != 0 || !record.CandidateDeleted && len(record.CandidateSource) == 0 {
			return codeError(CodeInvalidPayload, "invalid reconciliation candidate path/source", err)
		}
		expectedKind := ReconcileEdit
		if record.CandidateDeleted {
			expectedKind = ReconcileDelete
		} else if prior.Path != record.CandidatePath && bytes.Equal(prior.Source, record.CandidateSource) {
			expectedKind = ReconcileRename
		} else if prior.Path != record.CandidatePath {
			expectedKind = ReconcileRenameEdit
		}
		if record.Kind != expectedKind {
			return codeError(CodeInvalidPayload, "reconciliation kind does not match actual candidate change", nil)
		}
		if prior.RevisionID != record.PriorPublishedRevisionID || prior.Path != record.PriorPath {
			return codeError(CodeReplayMismatch, "published state changed during external reconciliation", nil)
		}
		status := record.Status
		if status == "" {
			status = "open"
		}
		if status != "open" && status != "resolved" {
			return codeError(CodeInvalidPayload, "invalid reconciliation status", nil)
		}
		_, err = tx.Exec(`INSERT INTO v2publish_reconciliations(reconciliation_id,conflict_id,owner_id,document_id,change_kind,source_commit,actor,prior_published_revision_id,current_revision_id,candidate_revision_id,prior_path,candidate_path,candidate_source,candidate_source_sha256,candidate_deleted,status,validation_error,detected_unix,resolution_revision_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			record.ID, record.ConflictID, record.OwnerID, record.DocumentID, string(record.Kind), sourceCommit, record.Actor,
			record.PriorPublishedRevisionID, record.CurrentRevisionID, record.CandidateRevisionID, record.PriorPath, record.CandidatePath,
			record.CandidateSource, record.CandidateSourceSHA256, boolInt(record.CandidateDeleted), status, record.ValidationError, now.Unix(), record.ResolutionRevisionID)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`UPDATE v2publish_published_documents SET revision_id=?,path=?,source=?,source_sha256=?,deleted=?,commit_hash=?,published_unix=?,external_source=1 WHERE owner_id=? AND document_id=?`,
			record.CandidateRevisionID, record.CandidatePath, record.CandidateSource, record.CandidateSourceSHA256, boolInt(record.CandidateDeleted), sourceCommit, now.Unix(), record.OwnerID, record.DocumentID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('external-reconciliation',?,?,?,'',?,?,?)`, record.OwnerID, record.DocumentID, record.CandidateRevisionID, sourceCommit, string(record.Kind), now.Unix()); err != nil {
			return err
		}
	}
	result, err := tx.Exec(`UPDATE v2publish_git_state SET base_commit=? WHERE singleton=1 AND base_commit=?`, sourceCommit, expectedBase)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return err
		}
		return codeError(CodeRemoteDrift, "Git base CAS failed during reconciliation", nil)
	}
	if len(records) == 0 {
		if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('external-reconciliation-no-content-change','','','','',?,'',?)`, sourceCommit, now.Unix()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (l *Ledger) ResolveReconciliation(token FenceToken, owner, conflictID, resolutionRevision string, now time.Time) error {
	if !validOwner(owner) || !validRevision(resolutionRevision) {
		return codeError(CodeInvalidPayload, "invalid reconciliation resolution identity", nil)
	}
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	record, err := scanReconciliation(tx.QueryRow(selectReconciliation+` WHERE owner_id=? AND conflict_id=?`, owner, conflictID))
	if errors.Is(err, sql.ErrNoRows) {
		return codeError(CodeNotFound, "reconciliation conflict not found", err)
	}
	if err != nil {
		return err
	}
	if record.Status == "resolved" {
		if record.ResolutionRevisionID == resolutionRevision {
			return nil
		}
		return codeError(CodeReplayMismatch, "reconciliation conflict was resolved with another revision", nil)
	}
	if _, err := tx.Exec(`UPDATE v2publish_reconciliations SET status='resolved',resolution_revision_id=? WHERE conflict_id=? AND status='open'`, resolutionRevision, conflictID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('external-reconciliation-resolved',?,?,?,'',?,'',?)`, owner, record.DocumentID, resolutionRevision, record.SourceCommit, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Ledger) OpenUnownedAdditionCount(owner string) (int64, error) {
	var count int64
	err := l.db.QueryRow(`SELECT count(*) FROM v2publish_unowned_additions WHERE owner_id=? AND status='open'`, owner).Scan(&count)
	return count, err
}

func (l *Ledger) UnownedAdditions(owner string) ([]UnownedAddition, error) {
	rows, err := l.db.Query(`SELECT addition_id,owner_id,source_commit,document_kind,path,source,source_sha256,status,detected_unix FROM v2publish_unowned_additions WHERE owner_id=? ORDER BY source_commit,path`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []UnownedAddition
	for rows.Next() {
		var item UnownedAddition
		var kind string
		if err := rows.Scan(&item.ID, &item.OwnerID, &item.SourceCommit, &kind, &item.Path, &item.Source, &item.SourceSHA256, &item.Status, &item.DetectedUnix); err != nil {
			return nil, err
		}
		item.Kind = DocumentKind(kind)
		result = append(result, item)
	}
	return result, rows.Err()
}

// RecordBlockedReconciliation durably preserves known-document candidates and
// unowned canonical additions without moving the Git base or published
// pointers. This is the fail-closed path for ambiguous delete/add transitions.
func (l *Ledger) RecordBlockedReconciliation(token FenceToken, owner, expectedBase, sourceCommit string, records []Reconciliation, additions []UnownedAddition, now time.Time) error {
	if !validOwner(owner) || sourceCommit == "" || !validGitHash(sourceCommit) || expectedBase != "" && !validGitHash(expectedBase) || len(additions) == 0 {
		return codeError(CodeInvalidPayload, "invalid blocked reconciliation envelope", nil)
	}
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, token); err != nil {
		return err
	}
	if err := bindArchiveOwnerTx(tx, owner); err != nil {
		return err
	}
	var initialized int
	var base string
	if err := tx.QueryRow(`SELECT initialized,base_commit FROM v2publish_git_state WHERE singleton=1`).Scan(&initialized, &base); err != nil {
		return err
	}
	if initialized == 0 || base != expectedBase {
		return codeError(CodeRemoteDrift, "durable Git base changed during blocked reconciliation", nil)
	}
	for _, record := range records {
		candidateMatches := record.CandidateRevisionID == externalRevisionID(owner, record.DocumentID, sourceCommit, record.CandidatePath, record.CandidateDeleted, record.CandidateSource) || validRevision(record.CandidateRevisionID)
		if record.OwnerID != owner || record.SourceCommit != sourceCommit || record.ID != reconciliationID(owner, record.DocumentID, sourceCommit) || !validReconciliationConflict(record.ConflictID) || !candidateMatches || record.CandidateSourceSHA256 != sourceHash(record.CandidateSource) || record.CurrentRevisionID != "" && !validRevision(record.CurrentRevisionID) || record.Actor == "" || len(record.Actor) > 255 || strings.ContainsRune(record.Actor, 0) {
			return codeError(CodeInvalidPayload, "invalid blocked reconciliation record", nil)
		}
		prior, err := publishedTx(tx, owner, record.DocumentID)
		if err != nil {
			return err
		}
		if prior.RevisionID != record.PriorPublishedRevisionID || prior.Path != record.PriorPath {
			return codeError(CodeReplayMismatch, "published state changed during blocked reconciliation", nil)
		}
		if err := ValidatePublicationPath(prior.Kind, record.CandidatePath); err != nil || record.CandidateDeleted && len(record.CandidateSource) != 0 || !record.CandidateDeleted && len(record.CandidateSource) == 0 {
			return codeError(CodeInvalidPayload, "invalid blocked reconciliation candidate", err)
		}
		expectedKind := ReconcileEdit
		if record.CandidateDeleted {
			expectedKind = ReconcileDelete
		} else if prior.Path != record.CandidatePath && bytes.Equal(prior.Source, record.CandidateSource) {
			expectedKind = ReconcileRename
		} else if prior.Path != record.CandidatePath {
			expectedKind = ReconcileRenameEdit
		}
		if record.Kind != expectedKind {
			return codeError(CodeInvalidPayload, "blocked reconciliation kind does not match candidate", nil)
		}
		_, err = tx.Exec(`INSERT OR IGNORE INTO v2publish_reconciliations(reconciliation_id,conflict_id,owner_id,document_id,change_kind,source_commit,actor,prior_published_revision_id,current_revision_id,candidate_revision_id,prior_path,candidate_path,candidate_source,candidate_source_sha256,candidate_deleted,status,validation_error,detected_unix,resolution_revision_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,'')`,
			record.ID, record.ConflictID, owner, record.DocumentID, string(record.Kind), sourceCommit, record.Actor,
			record.PriorPublishedRevisionID, record.CurrentRevisionID, record.CandidateRevisionID, record.PriorPath, record.CandidatePath,
			record.CandidateSource, record.CandidateSourceSHA256, boolInt(record.CandidateDeleted), record.ValidationError, now.Unix())
		if err != nil {
			return err
		}
	}
	for _, addition := range additions {
		if addition.OwnerID != owner || addition.SourceCommit != sourceCommit || addition.ID != unownedAdditionID(owner, sourceCommit, addition.Path, addition.Source) || addition.SourceSHA256 != sourceHash(addition.Source) || addition.Status != "open" || len(addition.Source) == 0 || ValidatePublicationPath(addition.Kind, addition.Path) != nil {
			return codeError(CodeInvalidPayload, "invalid unowned canonical addition", nil)
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO v2publish_unowned_additions(addition_id,owner_id,source_commit,document_kind,path,source,source_sha256,status,detected_unix) VALUES(?,?,?,?,?,?,?,'open',?)`, addition.ID, owner, sourceCommit, string(addition.Kind), addition.Path, addition.Source, addition.SourceSHA256, now.Unix()); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO v2publish_audit(action,owner_id,document_id,revision_id,intent_id,source_commit,detail,created_unix) VALUES('external-unowned-addition',?,'','','',?,?,?)`, owner, sourceCommit, addition.Path, now.Unix()); err != nil {
			return err
		}
	}
	return tx.Commit()
}
