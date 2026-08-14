package v2sync

import (
	"bytes"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestPullDeduplicatesRevisionSharedByAppliedAndPublishedEvents(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	created, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordPublication(testOwner, "device-a", "document-a", created.RevisionID, strings.Repeat("a", 40)); err != nil {
		t.Fatal(err)
	}
	pulled, err := store.Pull(testOwner, "device-a", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pulled.Events) != 2 || len(pulled.Revisions) != 1 || pulled.Revisions[0].ID != created.RevisionID {
		t.Fatalf("pull=%+v", pulled)
	}
}

func TestOwnerRecoveryClearsClaimAndRecordsAfterOriginDeviceRevocation(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	registerTestDevice(t, store, testOwner, "device-b", "registration-b", "token-b")
	created, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReservePublication(testOwner, "device-a", "document-a", created.RevisionID, "pub-recovery"); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeDevice(testOwner, "device-a"); err != nil {
		t.Fatal(err)
	}
	published, err := store.RecordPublicationService(testOwner, "device-a", "document-a", created.RevisionID, strings.Repeat("c", 40))
	if err != nil || published.Status != "published" {
		t.Fatalf("service publication after revocation = (%+v, %v)", published, err)
	}
	if err := store.ReleasePublicationClaim(testOwner, "document-a", "pub-recovery"); err != nil {
		t.Fatal(err)
	}
	edit := testApplyEnvelope(t, testOwner, "device-b", "edit-a", "document-a", created.RevisionID, "Edited", `{"v":1}`, published.Sequence)
	if _, err := store.Apply(edit); err != nil {
		t.Fatalf("claim remained after owner recovery: %v", err)
	}
}

func TestPublicationReservationFencesMutationsUntilExactRelease(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	registerTestDevice(t, store, testOwner, "device-b", "registration-b", "token-b")
	created, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReservePublication(testOwner, "device-a", "document-a", created.RevisionID, "pub-claim-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.ReservePublication(testOwner, "device-a", "document-a", created.RevisionID, "pub-claim-1"); err != nil {
		t.Fatalf("exact reservation replay: %v", err)
	}
	edit := testApplyEnvelope(t, testOwner, "device-b", "edit-a", "document-a", created.RevisionID, "Edited", `{"v":1}`, created.Sequence)
	if _, err := store.Apply(edit); !errors.Is(err, ErrPublicationReserved) {
		t.Fatalf("reserved Apply error = %v", err)
	}
	if err := store.ReleasePublication(testOwner, "device-a", "document-a", "pub-other"); !errors.Is(err, ErrPublicationReserved) {
		t.Fatalf("wrong claim release error = %v", err)
	}
	if err := store.ReleasePublication(testOwner, "device-a", "document-a", "pub-claim-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(edit); err != nil {
		t.Fatalf("Apply after release: %v", err)
	}
}

func TestRecordPublicationUsesOrdinaryPullAndAcknowledgement(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	created, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("a", 40)
	published, err := store.RecordPublication(testOwner, "device-a", "document-a", created.RevisionID, commit)
	if err != nil || published.Status != "published" || published.Sequence != created.Sequence+1 {
		t.Fatalf("RecordPublication = (%+v, %v)", published, err)
	}
	replayed, err := store.RecordPublication(testOwner, "device-a", "document-a", created.RevisionID, commit)
	if err != nil || replayed != published {
		t.Fatalf("publication replay = (%+v, %v), want %+v", replayed, err, published)
	}
	pull, err := store.Pull(testOwner, "device-a", created.Sequence, 10)
	if err != nil || len(pull.Events) != 1 || pull.Events[0].Kind != "published" || pull.Events[0].RevisionID != created.RevisionID {
		t.Fatalf("publication pull = (%+v, %v)", pull, err)
	}
	cursor, err := store.DeviceCursor(testOwner, "device-a")
	if err != nil || cursor != 0 {
		t.Fatalf("pull advanced ack = (%d, %v)", cursor, err)
	}
	if err := store.Ack(testOwner, "device-a", pull.Cursor); err != nil {
		t.Fatal(err)
	}
	cursor, err = store.DeviceCursor(testOwner, "device-a")
	if err != nil || cursor != published.Sequence {
		t.Fatalf("publication ack = (%d, %v)", cursor, err)
	}
	if _, err := store.RecordPublication(testOwner, "device-a", "document-a", created.RevisionID, strings.Repeat("b", 39)); !errors.Is(err, ErrInvalidEnvelope) {
		t.Fatalf("invalid commit error = %v", err)
	}
}

func TestPublicationCurrentRevisionReturnsFullHead(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)

	created, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "First title", `{"value":0}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	headEnvelope := testApplyEnvelope(t, testOwner, "device-a", "advance-a", "document-a", created.RevisionID, "Current title", `{ "z": 2, "a": 1 }`, created.Sequence)
	head, err := store.Apply(headEnvelope)
	if err != nil {
		t.Fatal(err)
	}

	got, err := store.CurrentRevision(testOwner, "device-a", "document-a")
	if err != nil {
		t.Fatalf("CurrentRevision: %v", err)
	}
	if got.ID != head.RevisionID || got.DocumentID != "document-a" || got.DeviceID != "device-a" || got.OperationID != "advance-a" || got.BaseRevisionID != created.RevisionID || got.Title != "Current title" {
		t.Fatalf("CurrentRevision metadata = %+v", got)
	}
	if !bytes.Equal(got.Payload, []byte(`{"a":1,"z":2}`)) || got.ContentHash != headEnvelope.PayloadSHA256 {
		t.Fatalf("CurrentRevision payload/hash = %s/%s", got.Payload, got.ContentHash)
	}
	id, err := store.CurrentRevisionID(testOwner, "device-a", "document-a")
	if err != nil || id != head.RevisionID {
		t.Fatalf("CurrentRevisionID = (%q, %v), want (%q, nil)", id, err, head.RevisionID)
	}

	if _, err := store.CurrentRevision(testOwner, "device-a", "missing-document"); err == nil {
		t.Fatal("CurrentRevision found a missing document")
	} else {
		requireCode(t, err, "NOT_FOUND")
	}
	if _, err := store.CurrentRevisionID(testOwner, "device-a", "missing-document"); err == nil {
		t.Fatal("CurrentRevisionID found a missing document")
	} else {
		requireCode(t, err, "NOT_FOUND")
	}
}

func TestPublicationReadsAreOwnerIsolated(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, "owner-a", "device-a", "registration-a", "token-a")
	registerTestDevice(t, store, "owner-b", "device-b", "registration-b", "token-b")

	ownerA, err := store.Apply(testApplyEnvelope(t, "owner-a", "device-a", "create-a", "shared-document", "", "Owner A", `{"owner":"a"}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	ownerB, err := store.Apply(testApplyEnvelope(t, "owner-b", "device-b", "create-b", "shared-document", "", "Owner B", `{"owner":"b"}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	staleA, err := store.Apply(testApplyEnvelope(t, "owner-a", "device-a", "stale-a", "shared-document", ownerA.RevisionID, "Owner A stale", `{"candidate":true}`, ownerA.Sequence))
	if err != nil {
		t.Fatal(err)
	}
	if staleA.Status != "applied" {
		t.Fatalf("first owner A advance = %+v", staleA)
	}
	conflictA, err := store.Apply(testApplyEnvelope(t, "owner-a", "device-a", "conflict-a", "shared-document", ownerA.RevisionID, "Owner A conflict", `{"conflict":true}`, staleA.Sequence))
	if err != nil || conflictA.Status != "conflict" {
		t.Fatalf("owner A conflict = (%+v, %v)", conflictA, err)
	}

	gotA, err := store.CurrentRevision(testOwner, "device-a", "shared-document")
	if err != nil || gotA.ID != staleA.RevisionID || string(gotA.Payload) != `{"candidate":true}` {
		t.Fatalf("owner A current = (%+v, %v)", gotA, err)
	}
	gotB, err := store.CurrentRevision("owner-b", "device-b", "shared-document")
	if err != nil || gotB.ID != ownerB.RevisionID || string(gotB.Payload) != `{"owner":"b"}` {
		t.Fatalf("owner B current = (%+v, %v)", gotB, err)
	}
	countA, err := store.OpenConflictCount("owner-a", "device-a", "shared-document")
	if err != nil || countA != 1 {
		t.Fatalf("owner A open conflicts = (%d, %v)", countA, err)
	}
	countB, err := store.OpenConflictCount("owner-b", "device-b", "shared-document")
	if err != nil || countB != 0 {
		t.Fatalf("owner B open conflicts = (%d, %v)", countB, err)
	}

	checks := []struct {
		name string
		call func() error
	}{
		{"current revision", func() error { _, err := store.CurrentRevision("owner-a", "device-b", "shared-document"); return err }},
		{"current revision ID", func() error { _, err := store.CurrentRevisionID("owner-a", "device-b", "shared-document"); return err }},
		{"open conflicts", func() error { _, err := store.OpenConflictCount("owner-a", "device-b", "shared-document"); return err }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			requireCode(t, check.call(), "UNAUTHORIZED")
		})
	}
}

func TestPublicationReadsRejectRevokedDevice(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	if _, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0)); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeDevice(testOwner, "device-a"); err != nil {
		t.Fatal(err)
	}

	checks := []struct {
		name string
		call func() error
	}{
		{"current revision", func() error { _, err := store.CurrentRevision(testOwner, "device-a", "document-a"); return err }},
		{"current revision ID", func() error { _, err := store.CurrentRevisionID(testOwner, "device-a", "document-a"); return err }},
		{"open conflicts", func() error { _, err := store.OpenConflictCount(testOwner, "device-a", "document-a"); return err }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			requireCode(t, check.call(), "DEVICE_REVOKED")
		})
	}
}

func TestPublicationConflictCountsTrackOpenStatePerDocument(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)

	baseA, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "A base", `{"v":0}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	headA, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-a", "document-a", baseA.RevisionID, "A head", `{"v":1}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	staleA, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "stale-a", "document-a", baseA.RevisionID, "A stale", `{"v":2}`, 0))
	if err != nil || staleA.Status != "conflict" {
		t.Fatalf("document A conflict = (%+v, %v)", staleA, err)
	}

	baseB, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-b", "document-b", "", "B base", `{"v":0}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	headB, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-b", "document-b", baseB.RevisionID, "B head", `{"v":1}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	staleB, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "stale-b", "document-b", baseB.RevisionID, "B stale", `{"v":2}`, 0))
	if err != nil || staleB.Status != "conflict" {
		t.Fatalf("document B conflict = (%+v, %v)", staleB, err)
	}

	for _, tc := range []struct {
		document string
		want     int64
	}{{"document-a", 1}, {"document-b", 1}, {"document-c", 0}} {
		got, err := store.OpenConflictCount(testOwner, "device-a", tc.document)
		if err != nil || got != tc.want {
			t.Fatalf("OpenConflictCount(%q) = (%d, %v), want (%d, nil)", tc.document, got, err, tc.want)
		}
	}
	currentA, err := store.CurrentRevisionID(testOwner, "device-a", "document-a")
	if err != nil || currentA != headA.RevisionID {
		t.Fatalf("conflict candidate became current: (%q, %v), want %q", currentA, err, headA.RevisionID)
	}

	resolvedA, err := store.Resolve(testResolveEnvelope(t, testOwner, "device-a", "resolve-a", staleA.ConflictID, "document-a", headA.RevisionID, `{"v":3}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	countA, err := store.OpenConflictCount(testOwner, "device-a", "document-a")
	if err != nil || countA != 0 {
		t.Fatalf("resolved document A open conflicts = (%d, %v)", countA, err)
	}
	countB, err := store.OpenConflictCount(testOwner, "device-a", "document-b")
	if err != nil || countB != 1 {
		t.Fatalf("unresolved document B open conflicts = (%d, %v)", countB, err)
	}
	current, err := store.CurrentRevision(testOwner, "device-a", "document-a")
	if err != nil || current.ID != resolvedA.RevisionID || current.BaseRevisionID != headA.RevisionID || string(current.Payload) != `{"v":3}` {
		t.Fatalf("resolved current revision = (%+v, %v)", current, err)
	}
	currentB, err := store.CurrentRevisionID(testOwner, "device-a", "document-b")
	if err != nil || currentB != headB.RevisionID {
		t.Fatalf("document B current = (%q, %v), want %q", currentB, err, headB.RevisionID)
	}
}

func TestExactMutationReplayPrecedesPublicationReservation(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	registerTestDevice(t, store, testOwner, "device-b", "registration-b", "token-b")

	create := testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0)
	created, err := store.Apply(create)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReservePublication(testOwner, "device-b", "document-a", created.RevisionID, "pub-replay-fence"); err != nil {
		t.Fatal(err)
	}
	if replay, err := store.Apply(create); err != nil || replay != created {
		t.Fatalf("reserved exact replay = (%+v, %v), want %+v", replay, err, created)
	}
	changed := create
	changed.Title = "Changed"
	if _, err := store.Apply(changed); !errors.Is(err, ErrReplayMismatch) {
		t.Fatalf("reserved changed replay error = %v", err)
	}
	newOperation := testApplyEnvelope(t, testOwner, "device-a", "edit-a", "document-a", created.RevisionID, "Edit", `{"v":1}`, created.Sequence)
	if _, err := store.Apply(newOperation); !errors.Is(err, ErrPublicationReserved) {
		t.Fatalf("reserved new operation error = %v", err)
	}
}

func TestPublicationMappingIsDurableIdempotentAndSurvivesCompaction(t *testing.T) {
	store, path := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	registerTestDevice(t, store, testOwner, "device-b", "registration-b", "token-b")
	created, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("d", 40)
	published, err := store.RecordPublication(testOwner, "device-a", "document-a", created.RevisionID, commit)
	if err != nil {
		t.Fatal(err)
	}
	// Publication idempotence is owner-wide, not tied to whichever existing
	// device performs recovery of the same immutable tuple.
	crossDevice, err := store.RecordPublication(testOwner, "device-b", "document-a", created.RevisionID, commit)
	if err != nil || crossDevice != published {
		t.Fatalf("cross-device publication replay = (%+v, %v), want %+v", crossDevice, err, published)
	}
	// An exact retry also repairs a legacy operation/event pair whose durable
	// mapping table had not yet been populated by an older schema.
	if _, err := store.db.Exec(`DELETE FROM v2sync_publications WHERE owner_id=? AND document_id=?`, testOwner, "document-a"); err != nil {
		t.Fatal(err)
	}
	if repaired, err := store.RecordPublication(testOwner, "device-a", "document-a", created.RevisionID, commit); err != nil || repaired != published {
		t.Fatalf("publication mapping repair = (%+v, %v), want %+v", repaired, err, published)
	}
	if err := store.SetCompactionFloor(testOwner, published.Sequence); err != nil {
		t.Fatal(err)
	}
	// Model physical event compaction after advancing the floor. Publication
	// state must not depend on retaining the historical published event.
	if _, err := store.db.Exec(`DELETE FROM v2sync_events WHERE owner_id=? AND sequence<=?`, testOwner, published.Sequence); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Snapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Publications) != 1 || snapshot.Publications[0] != (PublicationMapping{DocumentID: "document-a", RevisionID: created.RevisionID, CommitHash: commit, Sequence: published.Sequence}) {
		t.Fatalf("publication mapping after compaction = %+v", snapshot.Publications)
	}
	diagnostics, err := store.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics.PublicationCount != 1 || diagnostics.EventCount != 0 || diagnostics.OperationCount != 2 {
		t.Fatalf("publication replay duplicated effects: %+v", diagnostics)
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	afterRestart, err := reopened.Snapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(afterRestart.Publications, snapshot.Publications) {
		t.Fatalf("publication mapping changed across restart: before=%+v after=%+v", snapshot.Publications, afterRestart.Publications)
	}
}

func TestDelayedAncestorPublicationDoesNotRewindDurableMapping(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	first, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "First", `{}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "advance-a", "document-a", first.RevisionID, "Second", `{"v":2}`, first.Sequence))
	if err != nil {
		t.Fatal(err)
	}
	newCommit := strings.Repeat("e", 40)
	newPublication, err := store.RecordPublication(testOwner, "device-a", "document-a", second.RevisionID, newCommit)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordPublication(testOwner, "device-a", "document-a", first.RevisionID, strings.Repeat("f", 40)); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Snapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Publications) != 1 || snapshot.Publications[0].RevisionID != second.RevisionID || snapshot.Publications[0].CommitHash != newCommit || snapshot.Publications[0].Sequence != newPublication.Sequence {
		t.Fatalf("delayed ancestor rewound publication mapping: %+v", snapshot.Publications)
	}
}

func TestExactResolutionReplayPrecedesPublicationReservation(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	base, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Base", `{}`, 0))
	head, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-a", "document-a", base.RevisionID, "Head", `{"v":1}`, 1))
	stale, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "stale-a", "document-a", base.RevisionID, "Stale", `{"v":2}`, 2))
	if err != nil {
		t.Fatal(err)
	}
	resolution := testResolveEnvelope(t, testOwner, "device-a", "resolve-a", stale.ConflictID, "document-a", head.RevisionID, `{"v":3}`, stale.Sequence)
	resolved, err := store.Resolve(resolution)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReservePublication(testOwner, "device-a", "document-a", resolved.RevisionID, "pub-resolve-replay"); err != nil {
		t.Fatal(err)
	}
	if replay, err := store.Resolve(resolution); err != nil || replay != resolved {
		t.Fatalf("reserved resolution replay = (%+v, %v), want %+v", replay, err, resolved)
	}
	changed := resolution
	changed.Title = "Changed"
	if _, err := store.Resolve(changed); !errors.Is(err, ErrReplayMismatch) {
		t.Fatalf("reserved changed resolution replay error = %v", err)
	}
}

func TestConcurrentPublicationRecordingIsOwnerWideIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "publication-race.sqlite")
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
	registerTestDevice(t, first, testOwner, "device-a", "registration-a", "token-a")
	registerTestDevice(t, first, testOwner, "device-b", "registration-b", "token-b")
	created, err := first.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Title", `{}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("9", 40)
	start := make(chan struct{})
	outcomes := make(chan Outcome, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, call := range []func() (Outcome, error){
		func() (Outcome, error) {
			return first.RecordPublication(testOwner, "device-a", "document-a", created.RevisionID, commit)
		},
		func() (Outcome, error) {
			return second.RecordPublication(testOwner, "device-b", "document-a", created.RevisionID, commit)
		},
	} {
		call := call
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			outcome, err := call()
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
			t.Errorf("concurrent publication: %v", err)
		}
	}
	var got []Outcome
	for outcome := range outcomes {
		got = append(got, outcome)
	}
	if len(got) != 2 || got[0] != got[1] {
		t.Fatalf("concurrent publication outcomes = %+v", got)
	}
	diagnostics, err := first.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics.PublicationCount != 1 || diagnostics.EventCount != 2 || diagnostics.OperationCount != 2 || diagnostics.CurrentSequence != 2 {
		t.Fatalf("concurrent publication duplicated durable state: %+v", diagnostics)
	}
}
