package v2sync

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func testBaselineRevision(t *testing.T, owner, document, base, title, payload string) BaselineRevision {
	t.Helper()
	hash, _, err := HashPayload([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	revision := BaselineRevision{
		DocumentID: document, BaseRevisionID: base, Title: title,
		Payload: json.RawMessage(payload), PayloadSHA256: hash,
	}
	revision.RevisionID, err = BaselineRevisionID(owner, revision)
	if err != nil {
		t.Fatal(err)
	}
	return revision
}

func testBaselineEnvelope(t *testing.T, owner, device, operation string) BaselineBootstrapEnvelope {
	t.Helper()
	first := testBaselineRevision(t, owner, "2021-02-20-murphys", "", "Murphy's", `{ "entries": ["one"] }`)
	second := testBaselineRevision(t, owner, "song-2", "", "Song Two", `{"body":"two"}`)
	return BaselineBootstrapEnvelope{
		ProtocolVersion: ProtocolVersion,
		OwnerID:         owner,
		DeviceID:        device,
		OperationID:     operation,
		Revisions:       []BaselineRevision{second, first},
		Documents: []DocumentMapping{
			{DocumentID: second.DocumentID, Title: second.Title, CurrentRevisionID: second.RevisionID},
			{DocumentID: first.DocumentID, Title: first.Title, CurrentRevisionID: first.RevisionID},
		},
		Publications: []PublicationMapping{
			{DocumentID: second.DocumentID, RevisionID: second.RevisionID, CommitHash: strings.Repeat("b", 40)},
			{DocumentID: first.DocumentID, RevisionID: first.RevisionID, CommitHash: strings.Repeat("a", 40)},
		},
	}
}

func TestStableIDsPermitDigitLeadingExistingIdentifiersSafely(t *testing.T) {
	valid := []string{"0", "2021-02-20-murphys", "1device", "9-registration"}
	for _, id := range valid {
		if !ValidStableID(id) {
			t.Errorf("digit-leading stable ID rejected: %q", id)
		}
	}
	for _, id := range []string{"", "-bad", "1--bad", "1_bad", "1/bad", "1.Bad", strings.Repeat("1", 64)} {
		if ValidStableID(id) {
			t.Errorf("unsafe stable ID accepted: %q", id)
		}
	}

	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "1device", "2registration", testToken)
	outcome, err := store.Apply(testApplyEnvelope(t, testOwner, "1device", "3operation", "2021-02-20-murphys", "", "Murphy's", `{}`, 0))
	if err != nil || outcome.Status != "applied" {
		t.Fatalf("digit-leading IDs apply = (%+v, %v)", outcome, err)
	}
}

func TestBootstrapBaselineTransactionalReplayAndSnapshotContract(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	envelope := testBaselineEnvelope(t, testOwner, "device-a", "baseline-1")

	outcome, err := store.BootstrapBaseline(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.ProtocolVersion != ProtocolVersion || outcome.Status != "bootstrapped" || outcome.Cursor != 0 || outcome.RevisionCount != 2 || outcome.DocumentCount != 2 || outcome.PublicationCount != 2 {
		t.Fatalf("bootstrap outcome = %+v", outcome)
	}

	// Manifest arrays are sets with a canonical ordering for replay identity.
	reordered := envelope
	reordered.Revisions = []BaselineRevision{envelope.Revisions[1], envelope.Revisions[0]}
	reordered.Documents = []DocumentMapping{envelope.Documents[1], envelope.Documents[0]}
	reordered.Publications = []PublicationMapping{envelope.Publications[1], envelope.Publications[0]}
	replay, err := store.BootstrapBaseline(reordered)
	if err != nil || replay != outcome {
		t.Fatalf("baseline exact replay = (%+v, %v), want %+v", replay, err, outcome)
	}

	mismatch := envelope
	mismatch.Revisions = append([]BaselineRevision(nil), envelope.Revisions...)
	mismatch.Revisions[0].Title = "Changed"
	mismatch.Revisions[0].PayloadSHA256, _, _ = HashPayload(mismatch.Revisions[0].Payload)
	mismatch.Revisions[0].RevisionID, _ = BaselineRevisionID(testOwner, mismatch.Revisions[0])
	mismatch.Documents = append([]DocumentMapping(nil), envelope.Documents...)
	for index := range mismatch.Documents {
		if mismatch.Documents[index].DocumentID == mismatch.Revisions[0].DocumentID {
			mismatch.Documents[index].Title = mismatch.Revisions[0].Title
			mismatch.Documents[index].CurrentRevisionID = mismatch.Revisions[0].RevisionID
		}
	}
	mismatch.Publications = append([]PublicationMapping(nil), envelope.Publications...)
	for index := range mismatch.Publications {
		if mismatch.Publications[index].DocumentID == mismatch.Revisions[0].DocumentID {
			mismatch.Publications[index].RevisionID = mismatch.Revisions[0].RevisionID
		}
	}
	if _, err := store.BootstrapBaseline(mismatch); !errors.Is(err, ErrReplayMismatch) {
		t.Fatalf("changed baseline replay error = %v", err)
	}
	otherOperation := envelope
	otherOperation.OperationID = "baseline-2"
	if _, err := store.BootstrapBaseline(otherOperation); !errors.Is(err, ErrBaselineInitialized) {
		t.Fatalf("second baseline operation error = %v", err)
	}

	snapshot, err := store.Snapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Cursor != 0 || snapshot.Floor != 0 || len(snapshot.Documents) != 2 || len(snapshot.Revisions) != 2 || len(snapshot.Publications) != 2 || len(snapshot.Conflicts) != 0 {
		t.Fatalf("baseline snapshot = %+v", snapshot)
	}
	if snapshot.Documents[0].DocumentID != "2021-02-20-murphys" || snapshot.Documents[0].CurrentRevisionID != envelope.Revisions[1].RevisionID || snapshot.Publications[0].CommitHash != strings.Repeat("a", 40) {
		t.Fatalf("authoritative mappings = documents=%+v publications=%+v", snapshot.Documents, snapshot.Publications)
	}
	current, err := store.CurrentRevision(testOwner, "device-a", "2021-02-20-murphys")
	if err != nil || current.ID != envelope.Revisions[1].RevisionID || string(current.Payload) != `{"entries":["one"]}` {
		t.Fatalf("bootstrapped current revision = (%+v, %v)", current, err)
	}
}

func TestBootstrapBaselineRejectsPartialStateWithoutMutation(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	envelope := testBaselineEnvelope(t, testOwner, "device-a", "baseline-1")
	envelope.Publications[0].RevisionID = envelope.Revisions[1].RevisionID
	if _, err := store.BootstrapBaseline(envelope); !errors.Is(err, ErrWrongDocument) {
		t.Fatalf("cross-document publication error = %v", err)
	}
	diagnostics, err := store.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics.DocumentCount != 0 || diagnostics.RevisionCount != 0 || diagnostics.PublicationCount != 0 || diagnostics.OperationCount != 0 || diagnostics.CurrentSequence != 0 {
		t.Fatalf("rejected baseline mutated ledger: %+v", diagnostics)
	}
}

func TestConcurrentBaselineBootstrapIsRaceSafe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "baseline-race.sqlite")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	registerTestDevice(t, first, testOwner, "device-a", "registration-a", testToken)
	envelope := testBaselineEnvelope(t, testOwner, "device-a", "baseline-race")

	start := make(chan struct{})
	outcomes := make(chan BaselineBootstrapOutcome, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, store := range []*Store{first, second} {
		store := store
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			outcome, err := store.BootstrapBaseline(envelope)
			outcomes <- outcome
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(outcomes)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent exact baseline: %v", err)
		}
	}
	var got []BaselineBootstrapOutcome
	for outcome := range outcomes {
		got = append(got, outcome)
	}
	if len(got) != 2 || !reflect.DeepEqual(got[0], got[1]) {
		t.Fatalf("concurrent outcomes = %+v", got)
	}
	diagnostics, err := first.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics.DocumentCount != 2 || diagnostics.RevisionCount != 2 || diagnostics.PublicationCount != 2 || diagnostics.OperationCount != 1 || diagnostics.EventCount != 0 {
		t.Fatalf("concurrent baseline duplicated state: %+v", diagnostics)
	}
}

func TestConcurrentChangedBaselineUsesReplayMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "baseline-mismatch-race.sqlite")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	registerTestDevice(t, first, testOwner, "device-a", "registration-a", testToken)
	original := testBaselineEnvelope(t, testOwner, "device-a", "baseline-race")
	changed := testBaselineEnvelope(t, testOwner, "device-a", "baseline-race")
	changedRevision := testBaselineRevision(t, testOwner, changed.Revisions[0].DocumentID, "", "Changed Song Two", `{"body":"changed"}`)
	changed.Revisions[0] = changedRevision
	changed.Documents[0] = DocumentMapping{DocumentID: changedRevision.DocumentID, Title: changedRevision.Title, CurrentRevisionID: changedRevision.RevisionID}
	changed.Publications[0].RevisionID = changedRevision.RevisionID

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for index, envelope := range []BaselineBootstrapEnvelope{original, changed} {
		store := first
		if index == 1 {
			store = second
		}
		envelope := envelope
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := store.BootstrapBaseline(envelope)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	var successes, mismatches int
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrReplayMismatch):
			mismatches++
		default:
			t.Errorf("concurrent changed baseline error = %v", err)
		}
	}
	if successes != 1 || mismatches != 1 {
		t.Fatalf("concurrent changed baseline results: success=%d mismatch=%d", successes, mismatches)
	}
}

func TestBootstrapPublicationsAfterHeadIndependentRevisionBaseline(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	envelope := testBaselineEnvelope(t, testOwner, "device-a", "baseline-split")
	publications := append([]PublicationMapping(nil), envelope.Publications...)
	envelope.Publications = nil
	if _, err := store.BootstrapBaseline(envelope); err != nil {
		t.Fatal(err)
	}
	publicationEnvelope := PublicationBaselineEnvelope{OwnerID: testOwner, DeviceID: "device-a", OperationID: "publication-split", Publications: publications}
	if err := store.BootstrapPublications(publicationEnvelope); err != nil {
		t.Fatal(err)
	}
	if err := store.BootstrapPublications(publicationEnvelope); err != nil {
		t.Fatalf("exact replay: %v", err)
	}
	snapshot, err := store.Snapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Publications) != len(publications) {
		t.Fatalf("publications=%+v", snapshot.Publications)
	}
	changed := publicationEnvelope
	changed.Publications = append([]PublicationMapping(nil), publications...)
	changed.Publications[0].CommitHash = strings.Repeat("9", 40)
	if err := store.BootstrapPublications(changed); !errors.Is(err, ErrReplayMismatch) {
		t.Fatalf("changed replay=%v", err)
	}
}

func TestBootstrapBaselineComputesOmittedDeterministicReferences(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	revision := testBaselineRevision(t, testOwner, "2021-02-20-murphys", "", "Murphy's", `{}`)
	wantRevision := revision.RevisionID
	revision.RevisionID = ""
	envelope := BaselineBootstrapEnvelope{
		ProtocolVersion: ProtocolVersion, OwnerID: testOwner, DeviceID: "device-a", OperationID: "baseline-compute",
		Revisions:    []BaselineRevision{revision},
		Documents:    []DocumentMapping{{DocumentID: revision.DocumentID, Title: revision.Title}},
		Publications: []PublicationMapping{{DocumentID: revision.DocumentID, CommitHash: strings.Repeat("7", 40)}},
	}
	if _, err := store.BootstrapBaseline(envelope); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Snapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Revisions) != 1 || snapshot.Revisions[0].ID != wantRevision || snapshot.Documents[0].CurrentRevisionID != wantRevision || snapshot.Publications[0].RevisionID != wantRevision {
		t.Fatalf("computed baseline references = %+v", snapshot)
	}
}
