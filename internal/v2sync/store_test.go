package v2sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

const (
	testOwner = "owner-a"
	testToken = "correct horse battery staple"
)

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sync.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return store, path
}

func registerTestDevice(t *testing.T, store *Store, owner, device, registration, token string) DeviceRegistration {
	t.Helper()
	got, err := store.RegisterDevice(owner, device, registration, "Test device "+device, sha256Hex([]byte(token)))
	if err != nil {
		t.Fatalf("RegisterDevice(%q, %q): %v", owner, device, err)
	}
	return got
}

func testApplyEnvelope(t *testing.T, owner, device, operation, document, base, title, payload string, cursor int64) ApplyEnvelope {
	t.Helper()
	hash, _, err := HashPayload([]byte(payload))
	if err != nil {
		t.Fatalf("HashPayload(%q): %v", payload, err)
	}
	return ApplyEnvelope{
		ProtocolVersion: ProtocolVersion,
		OwnerID:         owner,
		DeviceID:        device,
		OperationID:     operation,
		OperationKind:   "upsert",
		DocumentID:      document,
		BaseRevisionID:  base,
		Title:           title,
		Payload:         json.RawMessage(payload),
		PayloadSHA256:   hash,
		ClientCursor:    cursor,
	}
}

func testResolveEnvelope(t *testing.T, owner, device, operation, conflict, document, base, payload string, cursor int64) ResolveEnvelope {
	t.Helper()
	hash, _, err := HashPayload([]byte(payload))
	if err != nil {
		t.Fatalf("HashPayload(%q): %v", payload, err)
	}
	return ResolveEnvelope{
		ProtocolVersion: ProtocolVersion,
		OwnerID:         owner,
		DeviceID:        device,
		OperationID:     operation,
		OperationKind:   "resolve-conflict",
		ConflictID:      conflict,
		DocumentID:      document,
		BaseRevisionID:  base,
		Title:           "Resolved title",
		Payload:         json.RawMessage(payload),
		PayloadSHA256:   hash,
		ClientCursor:    cursor,
	}
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if !IsCode(err, code) {
		t.Fatalf("error = %v, want code %q", err, code)
	}
}

func requireDiagnostics(t *testing.T, store *Store, owner, device string, want Diagnostics) Diagnostics {
	t.Helper()
	got, err := store.Diagnostics(owner, device)
	if err != nil {
		t.Fatalf("Diagnostics: %v", err)
	}
	if got != want {
		t.Fatalf("Diagnostics = %+v, want %+v", got, want)
	}
	return got
}

func TestAuthenticateDeviceHashesPlaintextInternally(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)

	if err := store.AuthenticateDevice(testOwner, "device-a", testToken); err != nil {
		t.Fatalf("AuthenticateDevice(plaintext): %v", err)
	}
	if err := store.AuthenticateDevice(testOwner, "device-a", sha256Hex([]byte(testToken))); err == nil {
		t.Fatal("AuthenticateDevice accepted the persisted digest as a presented credential")
	} else {
		requireCode(t, err, "UNAUTHORIZED")
	}
	if err := store.AuthenticateDevice(testOwner, "device-a", "wrong token"); err == nil {
		t.Fatal("AuthenticateDevice accepted the wrong plaintext token")
	} else {
		requireCode(t, err, "UNAUTHORIZED")
	}

	var stored string
	if err := store.db.QueryRow(`SELECT token_hash FROM v2sync_devices WHERE owner_id=? AND device_id=?`, testOwner, "device-a").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != sha256Hex([]byte(testToken)) || stored == testToken {
		t.Fatalf("stored credential = %q, want only the SHA-256 digest", stored)
	}
}

func TestRegistrationExactRetryUniquenessAndRevocation(t *testing.T) {
	store, _ := openTestStore(t)
	want := registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	got, err := store.RegisterDevice(testOwner, "device-a", "registration-a", want.Name, sha256Hex([]byte(testToken)))
	if err != nil || got != want {
		t.Fatalf("exact registration retry = (%+v, %v), want (%+v, nil)", got, err, want)
	}

	mismatches := []struct {
		name, registration, deviceName, hash string
	}{
		{"registration", "registration-b", want.Name, sha256Hex([]byte(testToken))},
		{"name", "registration-a", "Renamed", sha256Hex([]byte(testToken))},
		{"credential", "registration-a", want.Name, sha256Hex([]byte("other token"))},
	}
	for _, tc := range mismatches {
		t.Run(tc.name, func(t *testing.T) {
			_, err := store.RegisterDevice(testOwner, "device-a", tc.registration, tc.deviceName, tc.hash)
			requireCode(t, err, "REGISTRATION_MISMATCH")
		})
	}
	if _, err := store.RegisterDevice(testOwner, "device-b", "registration-a", "Other device", sha256Hex([]byte("other"))); err == nil {
		t.Fatal("registration ID was reused by another device")
	} else {
		requireCode(t, err, "REGISTRATION_MISMATCH")
	}

	if err := store.RevokeDevice(testOwner, "device-a"); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	if err := store.RevokeDevice(testOwner, "device-a"); err != nil {
		t.Fatalf("idempotent RevokeDevice: %v", err)
	}
	if _, err := store.RegisterDevice(testOwner, "device-a", "registration-a", want.Name, sha256Hex([]byte(testToken))); err == nil {
		t.Fatal("revoked device was re-registered")
	} else {
		requireCode(t, err, "DEVICE_REVOKED")
	}
	if err := store.AuthenticateDevice(testOwner, "device-a", testToken); err == nil {
		t.Fatal("revoked device authenticated")
	} else {
		requireCode(t, err, "DEVICE_REVOKED")
	}
	if err := store.RevokeDevice(testOwner, "missing-device"); err == nil {
		t.Fatal("revoking a missing device succeeded")
	} else {
		requireCode(t, err, "NOT_FOUND")
	}
}

func TestOwnerIsolationAcrossAllLedgerKeys(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, "owner-a", "device-a", "registration-a", "token-a")
	registerTestDevice(t, store, "owner-b", "device-a", "registration-a", "token-b")

	a := testApplyEnvelope(t, "owner-a", "device-a", "operation-a", "document-a", "", "Owner A", `{"owner":"a"}`, 0)
	b := testApplyEnvelope(t, "owner-b", "device-a", "operation-a", "document-a", "", "Owner B", `{"owner":"b"}`, 0)
	outA, err := store.Apply(a)
	if err != nil {
		t.Fatal(err)
	}
	outB, err := store.Apply(b)
	if err != nil {
		t.Fatal(err)
	}
	if outA.Sequence != 1 || outB.Sequence != 1 || outA.RevisionID == outB.RevisionID {
		t.Fatalf("owner-local outcomes: A=%+v B=%+v", outA, outB)
	}
	if err := store.AuthenticateDevice("owner-a", "device-a", "token-b"); err == nil {
		t.Fatal("owner B credential authenticated as owner A")
	} else {
		requireCode(t, err, "UNAUTHORIZED")
	}
	if _, err := store.Revision("owner-a", "device-a", outB.RevisionID); err == nil {
		t.Fatal("owner A read owner B revision")
	} else {
		requireCode(t, err, "NOT_FOUND")
	}
	for _, owner := range []string{"owner-a", "owner-b"} {
		pull, err := store.Pull(owner, "device-a", 0, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(pull.Events) != 1 || pull.Events[0].Sequence != 1 || len(pull.Revisions) != 1 {
			t.Fatalf("%s pull crossed owner boundary: %+v", owner, pull)
		}
		if string(pull.Revisions[0].Payload) != fmt.Sprintf(`{"owner":%q}`, strings.TrimPrefix(owner, "owner-")) {
			t.Fatalf("%s received payload %s", owner, pull.Revisions[0].Payload)
		}
	}
}

func TestApplyCanonicalIdempotencyAndReplayMismatch(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)

	first := testApplyEnvelope(t, testOwner, "device-a", "operation-a", "document-a", "", "Title", `{ "b": 2, "a": 1 }`, 0)
	out, err := store.Apply(first)
	if err != nil {
		t.Fatal(err)
	}
	retry := first
	retry.Payload = json.RawMessage(`{"a":1,"b":2}`)
	retry.PayloadSHA256, _, err = HashPayload(retry.Payload)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := store.Apply(retry)
	if err != nil || replayed != out {
		t.Fatalf("canonical replay = (%+v, %v), want (%+v, nil)", replayed, err, out)
	}
	diagnostics, err := store.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics.RevisionCount != 1 || diagnostics.OperationCount != 1 || diagnostics.EventCount != 1 || diagnostics.CurrentSequence != 1 {
		t.Fatalf("replay duplicated effects: %+v", diagnostics)
	}

	changed := retry
	changed.Payload = json.RawMessage(`{"a":1,"b":3}`)
	changed.PayloadSHA256, _, err = HashPayload(changed.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(changed); err == nil {
		t.Fatal("operation ID reuse with different canonical bytes succeeded")
	} else {
		requireCode(t, err, "OPERATION_REPLAY_MISMATCH")
	}
	changed = retry
	changed.Title = "Different title"
	if _, err := store.Apply(changed); err == nil {
		t.Fatal("operation ID reuse with different envelope semantics succeeded")
	} else {
		requireCode(t, err, "OPERATION_REPLAY_MISMATCH")
	}
}

func TestKnownUnknownAndCrossDocumentBases(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)

	a0, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "A", `{"v":0}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	b0, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-b", "document-b", "", "B", `{"v":0}`, 1))
	if err != nil {
		t.Fatal(err)
	}
	known, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "update-a", "document-a", a0.RevisionID, "A1", `{"v":1}`, 2))
	if err != nil || known.Status != "applied" {
		t.Fatalf("known base = (%+v, %v)", known, err)
	}
	unknown := "rev-000000000000000000000000"
	if _, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "unknown-a", "document-a", unknown, "bad", `{}`, 3)); err == nil {
		t.Fatal("unknown base accepted")
	} else {
		requireCode(t, err, "UNKNOWN_BASE")
	}
	if _, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "cross-a", "document-a", b0.RevisionID, "bad", `{}`, 3)); err == nil {
		t.Fatal("cross-document base accepted")
	} else {
		requireCode(t, err, "WRONG_DOCUMENT")
	}
	if _, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "new-with-base", "document-c", a0.RevisionID, "bad", `{}`, 3)); err == nil {
		t.Fatal("new document accepted a non-empty base")
	} else {
		requireCode(t, err, "UNKNOWN_BASE")
	}
}

func TestStaleWritePreservationAndExactConflictResolution(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", "token-a")
	registerTestDevice(t, store, testOwner, "device-b", "registration-b", "token-b")

	base, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Base", `{"text":"base"}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	head, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-a", "document-a", base.RevisionID, "Head", `{"text":"head"}`, 1))
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := store.Apply(testApplyEnvelope(t, testOwner, "device-b", "stale-a", "document-a", base.RevisionID, "Candidate", `{"text":"candidate"}`, 1))
	if err != nil || candidate.Status != "conflict" || candidate.ConflictID == "" || candidate.Sequence != 3 {
		t.Fatalf("stale apply = (%+v, %v)", candidate, err)
	}
	candidateRevision, err := store.Revision(testOwner, "device-a", candidate.RevisionID)
	if err != nil || string(candidateRevision.Payload) != `{"text":"candidate"}` {
		t.Fatalf("candidate revision not preserved: (%+v, %v)", candidateRevision, err)
	}
	conflict, err := store.Conflict(testOwner, "device-a", candidate.ConflictID)
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Status != "open" || conflict.CurrentRevisionID != head.RevisionID || conflict.CandidateRevisionID != candidate.RevisionID {
		t.Fatalf("conflict metadata = %+v", conflict)
	}

	badDocument := testResolveEnvelope(t, testOwner, "device-a", "resolve-wrong-doc", candidate.ConflictID, "document-b", head.RevisionID, `{"text":"merged"}`, 3)
	if _, err := store.Resolve(badDocument); err == nil {
		t.Fatal("resolution with wrong document succeeded")
	} else {
		requireCode(t, err, "CONFLICT_CAS_FAILED")
	}
	badBase := testResolveEnvelope(t, testOwner, "device-a", "resolve-wrong-base", candidate.ConflictID, "document-a", base.RevisionID, `{"text":"merged"}`, 3)
	if _, err := store.Resolve(badBase); err == nil {
		t.Fatal("resolution with wrong current revision succeeded")
	} else {
		requireCode(t, err, "CONFLICT_CAS_FAILED")
	}

	resolutionEnvelope := testResolveEnvelope(t, testOwner, "device-a", "resolve-a", candidate.ConflictID, "document-a", head.RevisionID, `{"text":"merged"}`, 3)
	resolved, err := store.Resolve(resolutionEnvelope)
	if err != nil || resolved.Status != "resolved" || resolved.ConflictID != candidate.ConflictID || resolved.Sequence != 4 {
		t.Fatalf("Resolve = (%+v, %v)", resolved, err)
	}
	resolvedConflict, err := store.Conflict(testOwner, "device-b", candidate.ConflictID)
	if err != nil || resolvedConflict.Status != "resolved" || resolvedConflict.ResolutionRevisionID != resolved.RevisionID {
		t.Fatalf("resolved conflict = (%+v, %v)", resolvedConflict, err)
	}
	replayed, err := store.Resolve(resolutionEnvelope)
	if err != nil || replayed != resolved {
		t.Fatalf("resolution replay = (%+v, %v), want %+v", replayed, err, resolved)
	}
	changed := resolutionEnvelope
	changed.Payload = json.RawMessage(`{"text":"different"}`)
	changed.PayloadSHA256, _, _ = HashPayload(changed.Payload)
	if _, err := store.Resolve(changed); err == nil {
		t.Fatal("resolution operation ID reuse with different bytes succeeded")
	} else {
		requireCode(t, err, "OPERATION_REPLAY_MISMATCH")
	}
}

func TestConflictResolutionCASPreservesConflictAfterHeadAdvances(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	base, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Base", `{"v":0}`, 0))
	head, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-a", "document-a", base.RevisionID, "Head", `{"v":1}`, 1))
	stale, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "stale-a", "document-a", base.RevisionID, "Stale", `{"v":2}`, 2))
	if err != nil {
		t.Fatal(err)
	}
	advanced, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "advance-a", "document-a", head.RevisionID, "Advanced", `{"v":3}`, 3))
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Resolve(testResolveEnvelope(t, testOwner, "device-a", "resolve-a", stale.ConflictID, "document-a", head.RevisionID, `{"v":4}`, 4))
	requireCode(t, err, "CONFLICT_CAS_FAILED")
	after, err := store.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("failed CAS mutated ledger: before=%+v after=%+v", before, after)
	}
	conflict, err := store.Conflict(testOwner, "device-a", stale.ConflictID)
	if err != nil || conflict.Status != "open" || conflict.ResolutionRevisionID != "" {
		t.Fatalf("failed CAS changed conflict: (%+v, %v)", conflict, err)
	}
	pull, err := store.Pull(testOwner, "device-a", 3, 10)
	if err != nil || len(pull.Events) != 1 || pull.Events[0].RevisionID != advanced.RevisionID {
		t.Fatalf("advanced head event missing: (%+v, %v)", pull, err)
	}
}

func TestPullReturnsEventRevisionPayloadConflictMetadataAndIsReadOnly(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	base, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Base", `{ "z": 0, "a": true }`, 0))
	head, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-a", "document-a", base.RevisionID, "Head", `{"v":1}`, 1))
	stale, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "stale-a", "document-a", base.RevisionID, "Stale", `{"candidate":true}`, 1))
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.SemanticSnapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	pull, err := store.Pull(testOwner, "device-a", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	after, err := store.SemanticSnapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("Pull mutated the semantic ledger or acknowledgement cursor")
	}
	if pull.Cursor != 3 || pull.Floor != 0 || len(pull.Events) != 3 || len(pull.Revisions) != 3 || len(pull.Conflicts) != 1 {
		t.Fatalf("Pull shape = %+v", pull)
	}
	for i, event := range pull.Events {
		if event.Sequence != int64(i+1) || pull.Revisions[i].ID != event.RevisionID || pull.Revisions[i].OperationID != event.OperationID {
			t.Fatalf("event/revision %d not paired: %+v %+v", i, event, pull.Revisions[i])
		}
	}
	if string(pull.Revisions[0].Payload) != `{"a":true,"z":0}` {
		t.Fatalf("non-canonical revision payload: %s", pull.Revisions[0].Payload)
	}
	lastEvent := pull.Events[2]
	conflict := pull.Conflicts[0]
	if lastEvent.Kind != "conflict" || lastEvent.ConflictID != stale.ConflictID || conflict.ID != stale.ConflictID || conflict.CurrentRevisionID != head.RevisionID || conflict.CandidateRevisionID != stale.RevisionID || conflict.Status != "open" {
		t.Fatalf("conflict event/payload mismatch: event=%+v conflict=%+v", lastEvent, conflict)
	}
	cursor, err := store.DeviceCursor(testOwner, "device-a")
	if err != nil || cursor != 0 {
		t.Fatalf("Pull implicitly acknowledged: cursor=%d err=%v", cursor, err)
	}
}

func TestAcknowledgementAndCompactionCursorMonotonicity(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	first, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "A", `{}`, 0))
	second, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-b", "document-b", "", "B", `{}`, 1))
	if first.Sequence != 1 || second.Sequence != 2 {
		t.Fatalf("unexpected sequences: %+v %+v", first, second)
	}
	if err := store.Ack(testOwner, "device-a", 2); err != nil {
		t.Fatal(err)
	}
	if err := store.Ack(testOwner, "device-a", 1); err != nil {
		t.Fatal(err)
	}
	cursor, err := store.DeviceCursor(testOwner, "device-a")
	if err != nil || cursor != 2 {
		t.Fatalf("ack regressed: cursor=%d err=%v", cursor, err)
	}
	if err := store.Ack(testOwner, "device-a", 3); err == nil {
		t.Fatal("future acknowledgement accepted")
	} else {
		requireCode(t, err, "FUTURE_CURSOR")
	}
	if err := store.SetCompactionFloor(testOwner, 1); err != nil {
		t.Fatal(err)
	}
	if err := store.SetCompactionFloor(testOwner, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.SetCompactionFloor(testOwner, 3); err == nil {
		t.Fatal("future compaction floor accepted")
	} else {
		requireCode(t, err, "FUTURE_CURSOR")
	}
	if result, err := store.Pull(testOwner, "device-a", 0, 10); err == nil {
		t.Fatalf("pull below compaction floor succeeded: %+v", result)
	} else {
		requireCode(t, err, "RESNAPSHOT_REQUIRED")
		if result.Floor != 1 || result.Cursor != 0 {
			t.Fatalf("resnapshot metadata = %+v", result)
		}
	}
	pull, err := store.Pull(testOwner, "device-a", 1, 10)
	if err != nil || pull.Floor != 1 || pull.Cursor != 2 || len(pull.Events) != 1 {
		t.Fatalf("pull at floor = (%+v, %v)", pull, err)
	}
	if _, err := store.Pull(testOwner, "device-a", 3, 10); err == nil {
		t.Fatal("pull with future cursor succeeded")
	} else {
		requireCode(t, err, "FUTURE_CURSOR")
	}
}

func TestRevokedDeviceCannotAccessAnyDeviceLedgerOperation(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	base, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Base", `{}`, 0))
	head, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-a", "document-a", base.RevisionID, "Head", `{"v":1}`, 1))
	stale, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "stale-a", "document-a", base.RevisionID, "Stale", `{"v":2}`, 2))
	if err := store.RevokeDevice(testOwner, "device-a"); err != nil {
		t.Fatal(err)
	}

	checks := []struct {
		name string
		call func() error
	}{
		{"authenticate", func() error { return store.AuthenticateDevice(testOwner, "device-a", testToken) }},
		{"apply", func() error {
			_, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "after-revoke", "document-a", head.RevisionID, "No", `{}`, 3))
			return err
		}},
		{"resolve", func() error {
			_, err := store.Resolve(testResolveEnvelope(t, testOwner, "device-a", "resolve-revoked", stale.ConflictID, "document-a", head.RevisionID, `{}`, 3))
			return err
		}},
		{"pull", func() error { _, err := store.Pull(testOwner, "device-a", 0, 10); return err }},
		{"ack", func() error { return store.Ack(testOwner, "device-a", 1) }},
		{"device cursor", func() error { _, err := store.DeviceCursor(testOwner, "device-a"); return err }},
		{"revision", func() error { _, err := store.Revision(testOwner, "device-a", base.RevisionID); return err }},
		{"conflict", func() error { _, err := store.Conflict(testOwner, "device-a", stale.ConflictID); return err }},
		{"metadata access", func() error { return store.AuthenticateMetadataAccess(testOwner, "device-a") }},
		{"diagnostics", func() error { _, err := store.Diagnostics(testOwner, "device-a"); return err }},
		{"snapshot", func() error { _, err := store.SemanticSnapshot(testOwner, "device-a"); return err }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			requireCode(t, check.call(), "DEVICE_REVOKED")
		})
	}
}

func TestCommitHooksModelBeforeAndAfterCommitBoundaries(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	beforeFailure := errors.New("simulated failure before commit")
	var beforeCalls atomic.Int64
	store.SetHooks(Hooks{BeforeCommit: func() error {
		beforeCalls.Add(1)
		return beforeFailure
	}})
	envelope := testApplyEnvelope(t, testOwner, "device-a", "operation-a", "document-a", "", "A", `{}`, 0)
	if _, err := store.Apply(envelope); !errors.Is(err, beforeFailure) {
		t.Fatalf("before-commit error = %v", err)
	}
	if beforeCalls.Load() != 1 {
		t.Fatalf("BeforeCommit calls = %d", beforeCalls.Load())
	}
	requireDiagnostics(t, store, testOwner, "device-a", Diagnostics{SchemaVersion: SchemaVersion, DeviceCount: 1, ActiveDeviceCount: 1})

	store.SetHooks(Hooks{})
	committed, err := store.Apply(envelope)
	if err != nil || committed.Sequence != 1 {
		t.Fatalf("apply after rollback = (%+v, %v)", committed, err)
	}
	afterFailure := errors.New("simulated lost response after commit")
	var afterCalls atomic.Int64
	store.SetHooks(Hooks{AfterCommit: func() error {
		afterCalls.Add(1)
		return afterFailure
	}})
	secondEnvelope := testApplyEnvelope(t, testOwner, "device-a", "operation-b", "document-b", "", "B", `{"saved":true}`, 1)
	outcome, err := store.Apply(secondEnvelope)
	if !errors.Is(err, afterFailure) || outcome.Sequence != 2 || outcome.RevisionID == "" {
		t.Fatalf("after-commit result = (%+v, %v)", outcome, err)
	}
	if afterCalls.Load() != 1 {
		t.Fatalf("AfterCommit calls = %d", afterCalls.Load())
	}
	diagnostics, err := store.Diagnostics(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics.CurrentSequence != 2 || diagnostics.OperationCount != 2 || diagnostics.EventCount != 2 || diagnostics.RevisionCount != 2 {
		t.Fatalf("after-commit failure was not durable: %+v", diagnostics)
	}
	store.SetHooks(Hooks{})
	replayed, err := store.Apply(secondEnvelope)
	if err != nil || replayed != outcome {
		t.Fatalf("retry after lost response = (%+v, %v), want %+v", replayed, err, outcome)
	}
}

func TestRestartPreservesOperationsConflictsAndAcknowledgements(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "restart.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	base, _ := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "create-a", "document-a", "", "Base", `{}`, 0))
	_, _ = store.Apply(testApplyEnvelope(t, testOwner, "device-a", "head-a", "document-a", base.RevisionID, "Head", `{"v":1}`, 1))
	staleEnvelope := testApplyEnvelope(t, testOwner, "device-a", "stale-a", "document-a", base.RevisionID, "Candidate", `{"v":2}`, 2)
	stale, err := store.Apply(staleEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ack(testOwner, "device-a", 2); err != nil {
		t.Fatal(err)
	}
	before, err := store.SemanticSnapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.AuthenticateDevice(testOwner, "device-a", testToken); err != nil {
		t.Fatalf("authentication after restart: %v", err)
	}
	after, err := reopened.SemanticSnapshot(testOwner, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("semantic state changed across restart\nbefore=%s\nafter=%s", before, after)
	}
	replayed, err := reopened.Apply(staleEnvelope)
	if err != nil || replayed != stale {
		t.Fatalf("durable replay after restart = (%+v, %v), want %+v", replayed, err, stale)
	}
	cursor, err := reopened.DeviceCursor(testOwner, "device-a")
	if err != nil || cursor != 2 {
		t.Fatalf("ack after restart = (%d, %v)", cursor, err)
	}
}

func TestConcurrentStoreInstancesAllocateUniqueOrderedOwnerSequences(t *testing.T) {
	path := filepath.Join(t.TempDir(), "concurrent.sqlite")
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

	const count = 24
	start := make(chan struct{})
	results := make(chan Outcome, count)
	errorsCh := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			store, device := first, "device-a"
			if i%2 == 1 {
				store, device = second, "device-b"
			}
			envelope := testApplyEnvelope(t, testOwner, device, fmt.Sprintf("operation-%02d", i), fmt.Sprintf("document-%02d", i), "", fmt.Sprintf("Document %02d", i), fmt.Sprintf(`{"index":%d}`, i), 0)
			outcome, err := store.Apply(envelope)
			if err != nil {
				errorsCh <- err
				return
			}
			results <- outcome
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		t.Errorf("concurrent Apply: %v", err)
	}
	if t.Failed() {
		return
	}
	var sequences []int
	for result := range results {
		sequences = append(sequences, int(result.Sequence))
	}
	sort.Ints(sequences)
	if len(sequences) != count {
		t.Fatalf("outcome count = %d, want %d", len(sequences), count)
	}
	for i, sequence := range sequences {
		if sequence != i+1 {
			t.Fatalf("sequences = %v, want contiguous 1..%d", sequences, count)
		}
	}
	pull, err := second.Pull(testOwner, "device-b", 0, count)
	if err != nil {
		t.Fatal(err)
	}
	if len(pull.Events) != count || pull.Cursor != count {
		t.Fatalf("Pull after concurrency = %d events, cursor %d", len(pull.Events), pull.Cursor)
	}
	for i, event := range pull.Events {
		if event.Sequence != int64(i+1) {
			t.Fatalf("events not strictly ordered at %d: %+v", i, event)
		}
	}
}

func TestSemanticSnapshotIsDeterministicOwnerScopedAndSecretFree(t *testing.T) {
	store, _ := openTestStore(t)
	secret := "never include this device credential"
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", secret)
	registerTestDevice(t, store, testOwner, "device-b", "registration-b", "active-token")
	_, err := store.Apply(testApplyEnvelope(t, testOwner, "device-b", "operation-a", "document-a", "", "A", `{ "b": 2, "a": 1 }`, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ack(testOwner, "device-b", 1); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeDevice(testOwner, "device-a"); err != nil {
		t.Fatal(err)
	}
	first, err := store.SemanticSnapshot(testOwner, "device-b")
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.SemanticSnapshot(testOwner, "device-b")
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("semantic snapshot is nondeterministic")
	}
	if !json.Valid(first) {
		t.Fatalf("snapshot is invalid JSON: %s", first)
	}
	if strings.Contains(string(first), secret) || strings.Contains(string(first), sha256Hex([]byte(secret))) || strings.Contains(string(first), "token_hash") {
		t.Fatalf("snapshot leaked device authorization secret material: %s", first)
	}
	var decoded struct {
		Owner   string `json:"owner_id"`
		Devices []struct {
			DeviceID string `json:"device_id"`
			Status   string `json:"status"`
		} `json:"devices"`
	}
	if err := json.Unmarshal(first, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Owner != testOwner || len(decoded.Devices) != 2 || decoded.Devices[0].DeviceID != "device-a" || decoded.Devices[0].Status != "revoked" || decoded.Devices[1].Status != "active" {
		t.Fatalf("snapshot semantic device state = %+v", decoded)
	}
}

func TestOnlineBackupRestorePreservesLedgerAndAuthorizationState(t *testing.T) {
	source, _ := openTestStore(t)
	registerTestDevice(t, source, testOwner, "device-old", "registration-old", "old-token")
	registerTestDevice(t, source, testOwner, "device-active", "registration-active", "active-token")
	out, err := source.Apply(testApplyEnvelope(t, testOwner, "device-active", "operation-a", "document-a", "", "A", `{"backed_up":true}`, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := source.Ack(testOwner, "device-active", out.Sequence); err != nil {
		t.Fatal(err)
	}
	if err := source.RevokeDevice(testOwner, "device-old"); err != nil {
		t.Fatal(err)
	}
	want, err := source.SemanticSnapshot(testOwner, "device-active")
	if err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(t.TempDir(), "backup", "restored.sqlite")
	if err := source.Backup(backupPath); err != nil {
		t.Fatalf("online Backup: %v", err)
	}

	restored, err := Open(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err := restored.Integrity(); err != nil {
		t.Fatalf("restored Integrity: %v", err)
	}
	if err := restored.AuthenticateDevice(testOwner, "device-active", "active-token"); err != nil {
		t.Fatalf("active authorization was not restored: %v", err)
	}
	if err := restored.AuthenticateDevice(testOwner, "device-active", "wrong-token"); err == nil {
		t.Fatal("restored database accepted wrong authorization state")
	} else {
		requireCode(t, err, "UNAUTHORIZED")
	}
	if err := restored.AuthenticateDevice(testOwner, "device-old", "old-token"); err == nil {
		t.Fatal("restored database reactivated revoked device")
	} else {
		requireCode(t, err, "DEVICE_REVOKED")
	}
	got, err := restored.SemanticSnapshot(testOwner, "device-active")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("backup semantic mismatch\nwant=%s\ngot=%s", want, got)
	}
}

func TestIntegrityChecksSQLiteAndForeignKeys(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	if _, err := store.Apply(testApplyEnvelope(t, testOwner, "device-a", "operation-a", "document-a", "", "A", `{}`, 0)); err != nil {
		t.Fatal(err)
	}
	if err := store.Integrity(); err != nil {
		t.Fatalf("healthy Integrity: %v", err)
	}

	if _, err := store.db.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO v2sync_acks(owner_id,device_id,cursor) VALUES('ghost-owner','ghost-device',0)`); err != nil {
		t.Fatalf("inject foreign-key violation: %v", err)
	}
	if _, err := store.db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		t.Fatal(err)
	}
	if err := store.Integrity(); err == nil || !strings.Contains(err.Error(), "foreign-key") {
		t.Fatalf("Integrity did not report injected foreign-key violation: %v", err)
	}
}
func TestApplyAcceptsPublicationPayloadContainingOneMiBExactSource(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-large", "registration-large", testToken)
	prefix := "---\ntitle: \"Large\"\nartist: \"Band\"\n---\n\n# Large\n\n"
	source := prefix + strings.Repeat("\\", (1<<20)-len(prefix))
	raw, err := json.Marshal(map[string]any{"schema_version": "v2publish-1", "kind": "lead-sheet", "path": "songs/Large.md", "source": source, "deleted": false})
	if err != nil {
		t.Fatal(err)
	}
	envelope := testApplyEnvelope(t, testOwner, "device-large", "operation-large", "song-large", "", "Large", string(raw), 0)
	if _, err := store.Apply(envelope); err != nil {
		t.Fatalf("Apply near-limit source: %v (payload bytes=%d)", err, len(raw))
	}
}
