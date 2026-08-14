package v2sync

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// BaselineRevisionID returns the content-addressed revision identity required by
// BootstrapBaseline. It intentionally excludes the importing device and
// operation so independently reviewed manifests produce identical identities.
func BaselineRevisionID(owner string, revision BaselineRevision) (string, error) {
	if !validOwner(owner) || !ValidStableID(revision.DocumentID) ||
		(revision.BaseRevisionID != "" && !validRevision(revision.BaseRevisionID)) ||
		!validText(revision.Title, 512) {
		return "", ErrInvalidEnvelope
	}
	hash, _, err := HashPayload(revision.Payload)
	if err != nil {
		return "", err
	}
	if !validHash(revision.PayloadSHA256) || revision.PayloadSHA256 != hash {
		return "", ErrPayloadHash
	}
	return "rev-" + framedHash("baseline", owner, revision.DocumentID, revision.BaseRevisionID, revision.Title, hash)[:24], nil
}

type validatedBaseline struct {
	revisions    []BaselineRevision
	documents    []DocumentMapping
	publications []PublicationMapping
	fingerprint  string
}

func validateBaseline(envelope BaselineBootstrapEnvelope) (validatedBaseline, error) {
	if envelope.ProtocolVersion != ProtocolVersion || !validOwner(envelope.OwnerID) ||
		!ValidStableID(envelope.DeviceID) || !ValidStableID(envelope.OperationID) ||
		len(envelope.Revisions) == 0 || len(envelope.Revisions) > maxBaselineRevisions ||
		len(envelope.Documents) == 0 || len(envelope.Documents) > maxBaselineDocuments ||
		len(envelope.Publications) > maxBaselinePublications {
		return validatedBaseline{}, ErrInvalidEnvelope
	}

	result := validatedBaseline{
		revisions:    append([]BaselineRevision(nil), envelope.Revisions...),
		documents:    append([]DocumentMapping(nil), envelope.Documents...),
		publications: append([]PublicationMapping(nil), envelope.Publications...),
	}
	revisionsByID := make(map[string]BaselineRevision, len(result.revisions))
	documentRevisionCount := make(map[string]int, len(result.documents))
	for index := range result.revisions {
		revision := &result.revisions[index]
		hash, canonical, err := HashPayload(revision.Payload)
		if err != nil {
			return validatedBaseline{}, err
		}
		if !validHash(revision.PayloadSHA256) || revision.PayloadSHA256 != hash {
			return validatedBaseline{}, ErrPayloadHash
		}
		revision.Payload = canonical
		expected, err := BaselineRevisionID(envelope.OwnerID, *revision)
		if err != nil {
			return validatedBaseline{}, err
		}
		if revision.RevisionID == "" {
			revision.RevisionID = expected
		} else if !validRevision(revision.RevisionID) || revision.RevisionID != expected {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		if _, duplicate := revisionsByID[revision.RevisionID]; duplicate {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		revisionsByID[revision.RevisionID] = *revision
		documentRevisionCount[revision.DocumentID]++
	}

	leavesByDocument := make(map[string]map[string]bool, len(documentRevisionCount))
	for _, revision := range result.revisions {
		if leavesByDocument[revision.DocumentID] == nil {
			leavesByDocument[revision.DocumentID] = map[string]bool{}
		}
		leavesByDocument[revision.DocumentID][revision.RevisionID] = true
	}
	for _, revision := range result.revisions {
		if revision.BaseRevisionID == "" {
			continue
		}
		base, ok := revisionsByID[revision.BaseRevisionID]
		if !ok {
			return validatedBaseline{}, ErrUnknownBase
		}
		if base.DocumentID != revision.DocumentID {
			return validatedBaseline{}, ErrWrongDocument
		}
		delete(leavesByDocument[revision.DocumentID], revision.BaseRevisionID)
	}

	documentsByID := make(map[string]DocumentMapping, len(result.documents))
	for index := range result.documents {
		document := &result.documents[index]
		if !ValidStableID(document.DocumentID) || !validText(document.Title, 512) {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		if _, duplicate := documentsByID[document.DocumentID]; duplicate {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		if document.CurrentRevisionID == "" {
			leaves := leavesByDocument[document.DocumentID]
			if len(leaves) != 1 {
				return validatedBaseline{}, ErrInvalidEnvelope
			}
			for leaf := range leaves {
				document.CurrentRevisionID = leaf
			}
		}
		if !validRevision(document.CurrentRevisionID) {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		current, ok := revisionsByID[document.CurrentRevisionID]
		if !ok || current.DocumentID != document.DocumentID || current.Title != document.Title {
			return validatedBaseline{}, ErrWrongDocument
		}
		documentsByID[document.DocumentID] = *document
	}
	if len(documentsByID) != len(documentRevisionCount) {
		return validatedBaseline{}, ErrInvalidEnvelope
	}
	for document := range documentRevisionCount {
		if _, ok := documentsByID[document]; !ok {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
	}

	// Every imported revision must be on the single authoritative chain ending
	// at that document's current revision. A baseline cannot silently import
	// unresolved branches without corresponding conflict state.
	for _, revision := range result.revisions {
		current := documentsByID[revision.DocumentID].CurrentRevisionID
		ancestor, err := baselineAncestor(revisionsByID, revision.RevisionID, current)
		if err != nil || !ancestor {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
	}

	publicationDocuments := make(map[string]bool, len(result.publications))
	for index := range result.publications {
		publication := &result.publications[index]
		if !ValidStableID(publication.DocumentID) || !publicationCommitRE.MatchString(publication.CommitHash) ||
			publication.Sequence != 0 || publicationDocuments[publication.DocumentID] {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		document, ok := documentsByID[publication.DocumentID]
		if !ok {
			return validatedBaseline{}, ErrWrongDocument
		}
		if publication.RevisionID == "" {
			publication.RevisionID = document.CurrentRevisionID
		}
		if !validRevision(publication.RevisionID) {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		revision, ok := revisionsByID[publication.RevisionID]
		if !ok || revision.DocumentID != publication.DocumentID {
			return validatedBaseline{}, ErrWrongDocument
		}
		current := documentsByID[publication.DocumentID].CurrentRevisionID
		ancestor, err := baselineAncestor(revisionsByID, publication.RevisionID, current)
		if err != nil || !ancestor {
			return validatedBaseline{}, ErrInvalidEnvelope
		}
		publicationDocuments[publication.DocumentID] = true
	}

	sort.Slice(result.revisions, func(i, j int) bool { return result.revisions[i].RevisionID < result.revisions[j].RevisionID })
	sort.Slice(result.documents, func(i, j int) bool { return result.documents[i].DocumentID < result.documents[j].DocumentID })
	sort.Slice(result.publications, func(i, j int) bool { return result.publications[i].DocumentID < result.publications[j].DocumentID })
	canonical, err := json.Marshal(struct {
		ProtocolVersion string               `json:"protocol_version"`
		OwnerID         string               `json:"owner_id"`
		DeviceID        string               `json:"device_id"`
		OperationID     string               `json:"operation_id"`
		Revisions       []BaselineRevision   `json:"revisions"`
		Documents       []DocumentMapping    `json:"documents"`
		Publications    []PublicationMapping `json:"publications"`
	}{envelope.ProtocolVersion, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, result.revisions, result.documents, result.publications})
	if err != nil {
		return validatedBaseline{}, err
	}
	result.fingerprint = framedHash("baseline-bootstrap", string(canonical))
	return result, nil
}

func baselineAncestor(revisions map[string]BaselineRevision, ancestor, descendant string) (bool, error) {
	seen := map[string]bool{}
	for descendant != "" {
		if descendant == ancestor {
			return true, nil
		}
		if seen[descendant] {
			return false, errors.New("cycle in baseline revision ancestry")
		}
		seen[descendant] = true
		revision, ok := revisions[descendant]
		if !ok {
			return false, ErrUnknownBase
		}
		descendant = revision.BaseRevisionID
	}
	return false, nil
}

func replayBaseline(tx *sql.Tx, owner, device, operation, fingerprint string) (BaselineBootstrapOutcome, bool, error) {
	var storedFingerprint string
	var raw []byte
	err := tx.QueryRow(`SELECT fingerprint,outcome_json FROM v2sync_operations WHERE owner_id=? AND device_id=? AND operation_id=?`, owner, device, operation).Scan(&storedFingerprint, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return BaselineBootstrapOutcome{}, false, nil
	}
	if err != nil {
		return BaselineBootstrapOutcome{}, false, err
	}
	if storedFingerprint != fingerprint {
		return BaselineBootstrapOutcome{}, true, ErrReplayMismatch
	}
	var outcome BaselineBootstrapOutcome
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return BaselineBootstrapOutcome{}, true, fmt.Errorf("decode durable baseline outcome: %w", err)
	}
	return outcome, true, nil
}

func baselineIsPristine(tx *sql.Tx, owner string) (bool, error) {
	var sequence, floor int64
	if err := tx.QueryRow(`SELECT current_sequence,compaction_floor FROM v2sync_metadata WHERE owner_id=?`, owner).Scan(&sequence, &floor); err != nil {
		return false, err
	}
	if sequence != 0 || floor != 0 {
		return false, nil
	}
	queries := []string{
		`SELECT count(*) FROM v2sync_documents WHERE owner_id=?`,
		`SELECT count(*) FROM v2sync_revisions WHERE owner_id=?`,
		`SELECT count(*) FROM v2sync_conflicts WHERE owner_id=?`,
		`SELECT count(*) FROM v2sync_operations WHERE owner_id=?`,
		`SELECT count(*) FROM v2sync_events WHERE owner_id=?`,
		`SELECT count(*) FROM v2sync_publication_reservations WHERE owner_id=?`,
		`SELECT count(*) FROM v2sync_publications WHERE owner_id=?`,
	}
	for _, query := range queries {
		var count int64
		if err := tx.QueryRow(query, owner).Scan(&count); err != nil {
			return false, err
		}
		if count != 0 {
			return false, nil
		}
	}
	return true, nil
}

type PublicationBaselineEnvelope struct {
	OwnerID      string
	DeviceID     string
	OperationID  string
	Publications []PublicationMapping
}

// BootstrapPublications installs the reviewed published pointers after the
// complete revision baseline and archive ledger have both verified. Exact
// retries are idempotent; partial or changed mappings fail closed.
func (s *Store) BootstrapPublications(envelope PublicationBaselineEnvelope) error {
	if !validOwner(envelope.OwnerID) || !ValidStableID(envelope.DeviceID) || !ValidStableID(envelope.OperationID) || len(envelope.Publications) == 0 || len(envelope.Publications) > maxBaselinePublications {
		return ErrInvalidEnvelope
	}
	publications := append([]PublicationMapping(nil), envelope.Publications...)
	sort.Slice(publications, func(i, j int) bool { return publications[i].DocumentID < publications[j].DocumentID })
	seen := map[string]bool{}
	for _, publication := range publications {
		if !ValidStableID(publication.DocumentID) || !validRevision(publication.RevisionID) || !publicationCommitRE.MatchString(publication.CommitHash) || publication.Sequence != 0 || seen[publication.DocumentID] {
			return ErrInvalidEnvelope
		}
		seen[publication.DocumentID] = true
	}
	rawFingerprint, err := json.Marshal(publications)
	if err != nil {
		return err
	}
	fingerprint := framedHash("publication-baseline", string(rawFingerprint))
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := authorize(tx, envelope.OwnerID, envelope.DeviceID); err != nil {
		return err
	}
	if outcome, found, err := replayBaseline(tx, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, fingerprint); found || err != nil {
		_ = outcome
		return err
	}
	var existing int
	if err := tx.QueryRow(`SELECT count(*) FROM v2sync_publications WHERE owner_id=?`, envelope.OwnerID).Scan(&existing); err != nil {
		return err
	}
	if existing != 0 {
		return ErrBaselineInitialized
	}
	for _, publication := range publications {
		var current string
		if err := tx.QueryRow(`SELECT current_revision_id FROM v2sync_documents WHERE owner_id=? AND document_id=?`, envelope.OwnerID, publication.DocumentID).Scan(&current); err != nil {
			return ErrWrongDocument
		}
		if current != publication.RevisionID {
			return ErrWrongDocument
		}
		if _, err := tx.Exec(`INSERT INTO v2sync_publications(owner_id,document_id,revision_id,commit_hash,sequence) VALUES(?,?,?,?,0)`, envelope.OwnerID, publication.DocumentID, publication.RevisionID, publication.CommitHash); err != nil {
			return err
		}
	}
	outcome := BaselineBootstrapOutcome{ProtocolVersion: ProtocolVersion, OperationID: envelope.OperationID, Status: "bootstrapped", PublicationCount: len(publications)}
	outcomeRaw, err := json.Marshal(outcome)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_operations(owner_id,device_id,operation_id,operation_kind,fingerprint,outcome_json,accepted_sequence,client_cursor) VALUES(?,?,?,?,?,?,0,0)`, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, "publication-baseline", fingerprint, outcomeRaw); err != nil {
		return err
	}
	return tx.Commit()
}

// BootstrapBaseline installs one reviewed, complete owner baseline in a single
// transaction. It is allowed only before any owner sync state exists. Exact
// operation retries return the byte-stable durable outcome; any changed
// manifest under the same operation ID fails with ErrReplayMismatch.
func (s *Store) BootstrapBaseline(envelope BaselineBootstrapEnvelope) (BaselineBootstrapOutcome, error) {
	baseline, err := validateBaseline(envelope)
	if err != nil {
		return BaselineBootstrapOutcome{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return BaselineBootstrapOutcome{}, err
	}
	defer tx.Rollback()
	if err := authorize(tx, envelope.OwnerID, envelope.DeviceID); err != nil {
		return BaselineBootstrapOutcome{}, err
	}
	if outcome, found, err := replayBaseline(tx, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, baseline.fingerprint); found || err != nil {
		return outcome, err
	}
	pristine, err := baselineIsPristine(tx, envelope.OwnerID)
	if err != nil {
		return BaselineBootstrapOutcome{}, err
	}
	if !pristine {
		return BaselineBootstrapOutcome{}, ErrBaselineInitialized
	}

	for _, document := range baseline.documents {
		if _, err := tx.Exec(`INSERT INTO v2sync_documents(owner_id,document_id,title,current_revision_id) VALUES(?,?,?,NULL)`, envelope.OwnerID, document.DocumentID, document.Title); err != nil {
			return BaselineBootstrapOutcome{}, err
		}
	}
	for _, revision := range baseline.revisions {
		if _, err := tx.Exec(`INSERT INTO v2sync_revisions(owner_id,revision_id,document_id,device_id,operation_id,operation_kind,base_revision_id,title,payload,content_hash) VALUES(?,?,?,?,?,'baseline-bootstrap',?,?,?,?)`, envelope.OwnerID, revision.RevisionID, revision.DocumentID, envelope.DeviceID, envelope.OperationID, revision.BaseRevisionID, revision.Title, []byte(revision.Payload), revision.PayloadSHA256); err != nil {
			return BaselineBootstrapOutcome{}, err
		}
	}
	for _, document := range baseline.documents {
		if _, err := tx.Exec(`UPDATE v2sync_documents SET current_revision_id=? WHERE owner_id=? AND document_id=?`, document.CurrentRevisionID, envelope.OwnerID, document.DocumentID); err != nil {
			return BaselineBootstrapOutcome{}, err
		}
	}
	for _, publication := range baseline.publications {
		if _, err := tx.Exec(`INSERT INTO v2sync_publications(owner_id,document_id,revision_id,commit_hash,sequence) VALUES(?,?,?,?,0)`, envelope.OwnerID, publication.DocumentID, publication.RevisionID, publication.CommitHash); err != nil {
			return BaselineBootstrapOutcome{}, err
		}
	}
	outcome := BaselineBootstrapOutcome{
		ProtocolVersion: ProtocolVersion, OperationID: envelope.OperationID, Status: "bootstrapped", Cursor: 0,
		RevisionCount: len(baseline.revisions), DocumentCount: len(baseline.documents), PublicationCount: len(baseline.publications),
	}
	raw, err := json.Marshal(outcome)
	if err != nil {
		return BaselineBootstrapOutcome{}, err
	}
	if _, err := tx.Exec(`INSERT INTO v2sync_operations(owner_id,device_id,operation_id,operation_kind,fingerprint,outcome_json,accepted_sequence,client_cursor) VALUES(?,?,?,?,?,?,0,0)`, envelope.OwnerID, envelope.DeviceID, envelope.OperationID, "baseline-bootstrap", baseline.fingerprint, raw); err != nil {
		return BaselineBootstrapOutcome{}, err
	}
	hooks := s.currentHooks()
	if hooks.BeforeCommit != nil {
		if err := hooks.BeforeCommit(); err != nil {
			return BaselineBootstrapOutcome{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return BaselineBootstrapOutcome{}, err
	}
	if hooks.AfterCommit != nil {
		if err := hooks.AfterCommit(); err != nil {
			return outcome, err
		}
	}
	return outcome, nil
}

// Bootstrap is a concise compatibility spelling for BootstrapBaseline.
func (s *Store) Bootstrap(envelope BaselineBootstrapEnvelope) (BaselineBootstrapOutcome, error) {
	return s.BootstrapBaseline(envelope)
}
