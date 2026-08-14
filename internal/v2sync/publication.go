package v2sync

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// ReservePublication atomically verifies that revision is current and
// conflict-free, then fences document mutation until the matching claim is
// released. Exact retries are idempotent; another claim fails closed.
func (s *Store) ReservePublication(owner, device, document, revision, claim string) error {
	if !validOwner(owner) || !ValidStableID(device) || !ValidStableID(document) || !validRevision(revision) || !ValidStableID(claim) {
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
	var current string
	if err := tx.QueryRow(`SELECT current_revision_id FROM v2sync_documents WHERE owner_id=? AND document_id=?`, owner, document).Scan(&current); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if current != revision {
		return ErrConflictCAS
	}
	var conflicts int64
	if err := tx.QueryRow(`SELECT count(*) FROM v2sync_conflicts WHERE owner_id=? AND document_id=? AND status='open'`, owner, document).Scan(&conflicts); err != nil {
		return err
	}
	if conflicts != 0 {
		return ErrConflictCAS
	}
	var existingRevision, existingClaim string
	err = tx.QueryRow(`SELECT revision_id,claim_id FROM v2sync_publication_reservations WHERE owner_id=? AND document_id=?`, owner, document).Scan(&existingRevision, &existingClaim)
	if err == nil {
		if existingRevision == revision && existingClaim == claim {
			return nil
		}
		return ErrPublicationReserved
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_publication_reservations(owner_id,document_id,revision_id,claim_id) VALUES(?,?,?,?)`, owner, document, revision, claim); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) releasePublicationClaim(owner, document, claim string) error {
	if !validOwner(owner) || !ValidStableID(document) || !ValidStableID(claim) {
		return ErrInvalidEnvelope
	}
	result, err := s.db.Exec(`DELETE FROM v2sync_publication_reservations WHERE owner_id=? AND document_id=? AND claim_id=?`, owner, document, claim)
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed == 0 {
		var existing string
		if err := s.db.QueryRow(`SELECT claim_id FROM v2sync_publication_reservations WHERE owner_id=? AND document_id=?`, owner, document).Scan(&existing); err == nil {
			return ErrPublicationReserved
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	return nil
}

// ReleasePublicationClaim is the owner-scoped recovery primitive used after a
// publisher process dies. It removes only the exact immutable intent claim.
func (s *Store) ReleasePublicationClaim(owner, document, claim string) error {
	return s.releasePublicationClaim(owner, document, claim)
}

// ReleasePublication removes only the caller's exact durable claim.
func (s *Store) ReleasePublication(owner, device, document, claim string) error {
	if !validOwner(owner) || !ValidStableID(device) || !ValidStableID(document) || !ValidStableID(claim) {
		return ErrInvalidEnvelope
	}
	if err := s.AuthenticateMetadataAccess(owner, device); err != nil {
		return err
	}
	return s.releasePublicationClaim(owner, document, claim)
}

func publicationReservation(tx *sql.Tx, owner, document string) error {
	var claim string
	err := tx.QueryRow(`SELECT claim_id FROM v2sync_publication_reservations WHERE owner_id=? AND document_id=?`, owner, document).Scan(&claim)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return ErrPublicationReserved
}

var publicationCommitRE = regexp.MustCompile(`^[a-f0-9]{40,64}$`)

// RecordPublication appends one idempotent owner event after Git has accepted a
// publication commit. Clients receive and acknowledge it through the ordinary
// TASK-017 pull/ack cursor protocol.
func (s *Store) RecordPublication(owner, device, document, revision, commit string) (Outcome, error) {
	return s.recordPublication(owner, device, document, revision, commit, true)
}

// RecordPublicationService recovers the publication event even if the
// originating device was revoked after Git accepted the commit. It is an
// internal owner-scoped service primitive and still requires an existing device
// row for the operation foreign key.
func (s *Store) RecordPublicationService(owner, device, document, revision, commit string) (Outcome, error) {
	return s.recordPublication(owner, device, document, revision, commit, false)
}

func (s *Store) recordPublication(owner, device, document, revision, commit string, requireActiveDevice bool) (Outcome, error) {
	if !validOwner(owner) || !ValidStableID(device) || !ValidStableID(document) || !validRevision(revision) || !publicationCommitRE.MatchString(commit) {
		return Outcome{}, ErrInvalidEnvelope
	}
	operation := "publication-" + framedHash(owner, document, revision, commit)[:24]
	fingerprint := framedHash("publication", owner, device, document, revision, commit)
	tx, err := s.db.Begin()
	if err != nil {
		return Outcome{}, err
	}
	defer tx.Rollback()
	if requireActiveDevice {
		if err := authorize(tx, owner, device); err != nil {
			return Outcome{}, err
		}
	} else {
		var exists int
		if err := tx.QueryRow(`SELECT 1 FROM v2sync_devices WHERE owner_id=? AND device_id=?`, owner, device).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return Outcome{}, ErrUnauthorized
		} else if err != nil {
			return Outcome{}, err
		}
	}
	var revisionDocument string
	if err := tx.QueryRow(`SELECT document_id FROM v2sync_revisions WHERE owner_id=? AND revision_id=?`, owner, revision).Scan(&revisionDocument); errors.Is(err, sql.ErrNoRows) {
		return Outcome{}, ErrNotFound
	} else if err != nil {
		return Outcome{}, err
	} else if revisionDocument != document {
		return Outcome{}, ErrWrongDocument
	}
	if outcome, found, err := replay(tx, owner, device, operation, fingerprint); found || err != nil {
		return outcome, err
	}
	sequence, err := ownerSequence(tx, owner)
	if err != nil {
		return Outcome{}, err
	}
	outcome := Outcome{OperationID: operation, Status: "published", RevisionID: revision, Sequence: sequence}
	if _, err := tx.Exec(`INSERT INTO v2sync_events(owner_id,sequence,kind,operation_id,document_id,revision_id,conflict_id) VALUES(?,?,?,?,?,?,'')`, owner, sequence, "published", operation, document, revision); err != nil {
		return Outcome{}, err
	}
	raw, err := json.Marshal(outcome)
	if err != nil {
		return Outcome{}, err
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_operations(owner_id,device_id,operation_id,operation_kind,fingerprint,outcome_json,accepted_sequence,client_cursor) VALUES(?,?,?,?,?,?,?,0)`, owner, device, operation, "publication", fingerprint, raw, sequence); err != nil {
		return Outcome{}, fmt.Errorf("record publication operation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Outcome{}, err
	}
	return outcome, nil
}

// CurrentRevision returns the document's current revision after authorizing the
// owner/device pair against durable device state.
func (s *Store) CurrentRevision(owner, device, document string) (Revision, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Revision{}, err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return Revision{}, err
	}
	if !ValidStableID(document) {
		return Revision{}, ErrInvalidEnvelope
	}

	var result Revision
	var payload []byte
	err = tx.QueryRow(`
SELECT r.revision_id,r.document_id,r.device_id,r.operation_id,r.base_revision_id,r.title,r.payload,r.content_hash
FROM v2sync_documents AS d
JOIN v2sync_revisions AS r
  ON r.owner_id=d.owner_id AND r.revision_id=d.current_revision_id
WHERE d.owner_id=? AND d.document_id=?`, owner, document).Scan(
		&result.ID,
		&result.DocumentID,
		&result.DeviceID,
		&result.OperationID,
		&result.BaseRevisionID,
		&result.Title,
		&payload,
		&result.ContentHash,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	if err != nil {
		return Revision{}, err
	}
	result.Payload = bytesClone(payload)
	return result, nil
}

// CurrentRevisionID returns the current revision identity for a document after
// authorizing the owner/device pair against durable device state.
func (s *Store) CurrentRevisionID(owner, device, document string) (string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return "", err
	}
	if !ValidStableID(document) {
		return "", ErrInvalidEnvelope
	}

	var revision sql.NullString
	err = tx.QueryRow(`SELECT current_revision_id FROM v2sync_documents WHERE owner_id=? AND document_id=?`, owner, document).Scan(&revision)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if !revision.Valid || !validRevision(revision.String) {
		return "", ErrNotFound
	}
	return revision.String, nil
}

// OpenConflictCount returns the number of unresolved conflict candidates for a
// document after authorizing the owner/device pair against durable device state.
func (s *Store) OpenConflictCount(owner, device, document string) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := authorize(tx, owner, device); err != nil {
		return 0, err
	}
	if !ValidStableID(document) {
		return 0, ErrInvalidEnvelope
	}

	var count int64
	if err := tx.QueryRow(`SELECT count(*) FROM v2sync_conflicts WHERE owner_id=? AND document_id=? AND status='open'`, owner, document).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}
