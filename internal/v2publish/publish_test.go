package v2publish

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"songs.exe.dev/internal/v2sync"
)

type fakeSync struct {
	mu        sync.Mutex
	revisions map[string]v2sync.Revision
	conflicts map[string]int64
	claims    map[string]string
}

func newFakeSync() *fakeSync {
	return &fakeSync{revisions: map[string]v2sync.Revision{}, conflicts: map[string]int64{}, claims: map[string]string{}}
}

func (f *fakeSync) CurrentRevision(_, _, document string) (v2sync.Revision, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	revision, ok := f.revisions[document]
	if !ok {
		return v2sync.Revision{}, v2sync.ErrNotFound
	}
	return revision, nil
}
func (f *fakeSync) Apply(envelope v2sync.ApplyEnvelope) (v2sync.Outcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	current, ok := f.revisions[envelope.DocumentID]
	if !ok {
		return v2sync.Outcome{}, v2sync.ErrNotFound
	}
	revisionID := "rev-" + envelope.PayloadSHA256[:24]
	outcome := v2sync.Outcome{OperationID: envelope.OperationID, Status: "applied", RevisionID: revisionID, Sequence: 1}
	if current.ID != envelope.BaseRevisionID {
		outcome.Status = "conflict"
		outcome.ConflictID = "conf-" + envelope.PayloadSHA256[24:48]
		f.conflicts[envelope.DocumentID]++
		return outcome, nil
	}
	f.revisions[envelope.DocumentID] = v2sync.Revision{
		ID: revisionID, DocumentID: envelope.DocumentID, DeviceID: envelope.DeviceID,
		OperationID: envelope.OperationID, BaseRevisionID: envelope.BaseRevisionID,
		Title: envelope.Title, Payload: append([]byte(nil), envelope.Payload...), ContentHash: envelope.PayloadSHA256,
	}
	return outcome, nil
}

func (f *fakeSync) ReservePublication(_, _, document, revision, claim string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	current, ok := f.revisions[document]
	if !ok || current.ID != revision || f.conflicts[document] != 0 {
		return v2sync.ErrConflictCAS
	}
	if existing := f.claims[document]; existing != "" && existing != claim {
		return v2sync.ErrPublicationReserved
	}
	f.claims[document] = claim
	return nil
}

func (f *fakeSync) ReleasePublicationClaim(_, document, claim string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if existing := f.claims[document]; existing != "" && existing != claim {
		return v2sync.ErrPublicationReserved
	}
	delete(f.claims, document)
	return nil
}

func (f *fakeSync) RecordPublicationService(_, _, _, revision, commit string) (v2sync.Outcome, error) {
	if revision == "" || commit == "" {
		return v2sync.Outcome{}, v2sync.ErrInvalidEnvelope
	}
	return v2sync.Outcome{OperationID: "publication-test", Status: "published", RevisionID: revision, Sequence: 1}, nil
}

func (f *fakeSync) OpenConflictCount(_, _, document string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conflicts[document], nil
}
func (f *fakeSync) remove(document string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.revisions, document)
}

func (f *fakeSync) attemptSet(document, revision, title string, payload PublicationPayload) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claims[document] != "" {
		return v2sync.ErrPublicationReserved
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	hash, canonical, err := v2sync.HashPayload(raw)
	if err != nil {
		return err
	}
	f.revisions[document] = v2sync.Revision{ID: revision, DocumentID: document, Title: title, Payload: canonical, ContentHash: hash}
	return nil
}

func (f *fakeSync) set(document, revision, title string, payload PublicationPayload) {
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	hash, canonical, err := v2sync.HashPayload(raw)
	if err != nil {
		panic(err)
	}
	f.revisions[document] = v2sync.Revision{ID: revision, DocumentID: document, Title: title, Payload: canonical, ContentHash: hash}
}

func runGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	all := append([]string{}, args...)
	if directory != "" {
		all = append([]string{"-C", directory}, all...)
	}
	command := exec.Command("git", all...)
	command.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(all, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func initRemote(t *testing.T, fixtures map[string]string) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	seed := filepath.Join(root, "seed")
	runGit(t, "", "init", "--bare", "--initial-branch=main", remote)
	runGit(t, "", "init", "--initial-branch=main", seed)
	runGit(t, seed, "config", "user.name", "Fixture")
	runGit(t, seed, "config", "user.email", "fixture@example.invalid")
	if len(fixtures) == 0 {
		fixtures = map[string]string{"README.md": "fixture\n"}
	}
	for path, source := range fixtures {
		target := filepath.Join(seed, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(source), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, seed, "add", "-A")
	command := exec.Command("git", "-C", seed, "commit", "-m", "fixture")
	command.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_DATE=2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("seed commit: %v: %s", err, output)
	}
	runGit(t, seed, "remote", "add", "origin", remote)
	runGit(t, seed, "push", "--quiet", "origin", "HEAD:refs/heads/main")
	return root, remote
}

func remoteHead(t *testing.T, remote string) string {
	t.Helper()
	return runGit(t, "", "--git-dir="+remote, "rev-parse", "refs/heads/main")
}
func remoteCount(t *testing.T, remote string) int {
	t.Helper()
	var count int
	if _, err := fmt.Sscan(runGit(t, "", "--git-dir="+remote, "rev-list", "--count", "refs/heads/main"), &count); err != nil {
		t.Fatal(err)
	}
	return count
}

func testPublisher(t *testing.T, root, remote string, source SyncSource, options ...func(*Options)) *Publisher {
	t.Helper()
	config := Options{
		LedgerPath: filepath.Join(root, "publication.sqlite"),
		Remote:     remote, WorkRoot: filepath.Join(root, "publisher-work"), Sync: source,
		ValidatorOptions: ValidatorOptions{SkipApex: true},
		Hooks:            Hooks{Now: func() time.Time { return time.Unix(1_700_000_000, 0).UTC() }},
	}
	for _, option := range options {
		option(&config)
	}
	publisher, err := Open(config)
	if err != nil {
		t.Fatalf("Open publisher: %v", err)
	}
	t.Cleanup(func() {
		if err := publisher.Close(); err != nil {
			t.Errorf("Close publisher: %v", err)
		}
	})
	return publisher
}

func leadPayload(path, title, text string) PublicationPayload {
	return PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: LeadSheet, Path: path, Source: "# " + title + "\n\n" + text + "\n", Deleted: false}
}

func request(document, revision string) PublishRequest {
	return PublishRequest{OwnerID: "owner-a", DeviceID: "device-a", DocumentID: document, RevisionID: revision, Holder: "worker-a"}
}

func TestVerifiedArchiveBootstrapEnablesExistingDocumentPublication(t *testing.T) {
	source := "# Existing Song\n\nPublished archive bytes\n"
	root, remote := initRemote(t, map[string]string{"songs/Existing-Song.md": source})
	syncStore := newFakeSync()
	baseline := "rev-969696969696969696969696"
	syncStore.set("existing-song", baseline, "Existing Song", leadPayload("songs/Existing-Song.md", "Existing Song", "Published archive bytes"))
	documents := []BootstrapDocument{{
		DocumentID: "existing-song", RevisionID: baseline, Title: "Existing Song", Kind: LeadSheet,
		Path: "songs/Existing-Song.md", Source: []byte(source),
	}}
	manifestHash, err := BootstrapManifestSHA256(documents)
	if err != nil {
		t.Fatal(err)
	}
	publisher := testPublisher(t, root, remote, syncStore, func(options *Options) { options.BootstrapManifestSHA256 = manifestHash })
	if err := publisher.BootstrapArchive(context.Background(), "owner-a", "device-a", "bootstrap-worker", documents); err != nil {
		t.Fatal(err)
	}
	if err := publisher.BootstrapArchive(context.Background(), "owner-a", "device-a", "bootstrap-worker", documents); err != nil {
		t.Fatalf("exact archive bootstrap replay: %v", err)
	}
	edited := "rev-959595959595959595959595"
	syncStore.set("existing-song", edited, "Existing Song", leadPayload("songs/Existing-Song.md", "Existing Song", "Edited archive bytes"))
	before := remoteCount(t, remote)
	result, err := publisher.Publish(context.Background(), requestFor("existing-song", edited))
	if err != nil || result.State != IntentFinalized || remoteCount(t, remote) != before+1 {
		t.Fatalf("publish bootstrapped existing document = %+v, %v", result, err)
	}
}

func TestArchiveBootstrapRejectsPartialCanonicalCoverage(t *testing.T) {
	root, remote := initRemote(t, map[string]string{
		"songs/One.md": "# One\n", "songs/Two.md": "# Two\n",
	})
	syncStore := newFakeSync()
	revision := "rev-949494949494949494949494"
	syncStore.set("one", revision, "One", PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: LeadSheet, Path: "songs/One.md", Source: "# One\n"})
	documents := []BootstrapDocument{{DocumentID: "one", RevisionID: revision, Title: "One", Kind: LeadSheet, Path: "songs/One.md", Source: []byte("# One\n")}}
	manifestHash, err := BootstrapManifestSHA256(documents)
	if err != nil {
		t.Fatal(err)
	}
	publisher := testPublisher(t, root, remote, syncStore, func(options *Options) { options.BootstrapManifestSHA256 = manifestHash })
	if err := publisher.BootstrapArchive(context.Background(), "owner-a", "device-a", "bootstrap-worker", documents); err == nil || !IsCode(err, CodeIntegrity) {
		t.Fatalf("partial archive bootstrap error = %v", err)
	}
	if _, err := publisher.Ledger().PublishedDocument("owner-a", "one"); err == nil || !IsCode(err, CodeNotFound) {
		t.Fatalf("partial bootstrap wrote durable rows: %v", err)
	}
}

func TestFreshLedgerRefusesUnownedCanonicalOverwrite(t *testing.T) {
	root, remote := initRemote(t, map[string]string{"songs/Occupied.md": "# Existing Archive Song\n"})
	syncStore := newFakeSync()
	revision := "rev-989898989898989898989898"
	syncStore.set("document-new", revision, "Replacement", leadPayload("songs/Occupied.md", "Replacement", "new bytes"))
	publisher := testPublisher(t, root, remote, syncStore)
	before := remoteCount(t, remote)
	result, err := publisher.Publish(context.Background(), requestFor("document-new", revision))
	if err == nil || !IsCode(err, CodeIneligible) || result.Commit != "" {
		t.Fatalf("unowned canonical overwrite = %+v, %v", result, err)
	}
	if remoteCount(t, remote) != before {
		t.Fatal("unowned canonical path reached remote")
	}
}

func TestReconcileFinalizesRemoteAcceptedApplicationCommitBeforeDiffing(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	revision := "rev-979797979797979797979797"
	syncStore.set("song-a", revision, "Song A", leadPayload("songs/song-a.md", "Song A", "application bytes"))
	publisher := testPublisher(t, root, remote, syncStore)
	failed := false
	publisher.SetHooks(Hooks{
		Now: func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
		Failure: func(point FailurePoint, _ Intent) error {
			if point == FailureAfterPush && !failed {
				failed = true
				return errors.New("response lost")
			}
			return nil
		},
	})
	result, err := publisher.Publish(context.Background(), request("song-a", revision))
	if err == nil || result.State != IntentCommitted || result.Commit == "" {
		t.Fatalf("after-push loss = %+v, %v", result, err)
	}
	publisher.SetHooks(Hooks{Now: func() time.Time { return time.Unix(1_700_000_000, 0).UTC() }})
	records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"})
	if err != nil || len(records) != 0 {
		t.Fatalf("reconcile application commit = %+v, %v", records, err)
	}
	intent, err := publisher.Ledger().Intent(result.IntentID)
	if err != nil || intent.State != IntentFinalized {
		t.Fatalf("intent not finalized before reconciliation: %+v, %v", intent, err)
	}
	published, err := publisher.Ledger().PublishedDocument("owner-a", "song-a")
	if err != nil || published.RevisionID != revision || published.ExternalSource {
		t.Fatalf("application commit was misclassified as external: %+v, %v", published, err)
	}
}

func requestFor(document, revision string) PublishRequest {
	return PublishRequest{OwnerID: "owner-a", DeviceID: "device-a", DocumentID: document, RevisionID: revision, Holder: "worker-a"}
}

func TestStrictPublicationPayload(t *testing.T) {
	valid, _ := json.Marshal(leadPayload("songs/Song-A.md", "Song A", "Body"))
	payload, err := ParsePublicationPayload(valid)
	if err != nil || payload.Path != "songs/Song-A.md" {
		t.Fatalf("valid payload = %+v, %v", payload, err)
	}
	cases := []string{
		`{"schema_version":"v2publish-1","kind":"lead-sheet","path":"../Song.md","source":"# Song\n","deleted":false}`,
		`{"schema_version":"v2publish-1","kind":"lead-sheet","path":"sets/Song.md","source":"# Song\n","deleted":false}`,
		`{"schema_version":"v2publish-1","kind":"lead-sheet","path":"songs/Song.md","source":"# Song\n","deleted":false,"extra":1}`,
		`{"schema_version":"v2publish-1","kind":"lead-sheet","kind":"set-list","path":"songs/Song.md","source":"# Song\n","deleted":false}`,
		`{"schema_version":"v2publish-1","kind":"lead-sheet","path":"songs/Song.md","source":"x","deleted":true}`,
	}
	for _, raw := range cases {
		if _, err := ParsePublicationPayload([]byte(raw)); err == nil || !IsCode(err, CodeInvalidPayload) {
			t.Errorf("unsafe payload accepted or wrong error: %s: %v", raw, err)
		}
	}
}

func TestCrossInstanceFlockAndDurableStaleFence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.sqlite")
	first, err := OpenLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := OpenLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	leaseA, err := first.AcquireLease(context.Background(), "process-a")
	if err != nil {
		t.Fatal(err)
	}
	stale := leaseA.Token()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if _, err := second.AcquireLease(ctx, "process-b"); err == nil || !IsCode(err, CodeLeaseBusy) {
		t.Fatalf("second process lease = %v, want busy", err)
	}
	if err := leaseA.Release(); err != nil {
		t.Fatal(err)
	}
	leaseB, err := second.AcquireLease(context.Background(), "process-b")
	if err != nil {
		t.Fatal(err)
	}
	defer leaseB.Release()
	if leaseB.Token().Epoch != stale.Epoch || leaseB.Token().Generation <= stale.Generation || leaseB.Token().Holder == stale.Holder {
		t.Fatalf("new fence = %+v, stale = %+v", leaseB.Token(), stale)
	}
	if err := first.AssertFence(stale); err == nil || !IsCode(err, CodeStaleFence) {
		t.Fatalf("stale token assertion = %v", err)
	}
}

func TestIntentPersistsExpectationsBeforeMaterializationAndValidationNeverCommits(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	revision := "rev-aaaaaaaaaaaaaaaaaaaaaaaa"
	payload := leadPayload("songs/song-a.md", "Wrong", "invalid")
	syncStore.set("song-a", revision, "Song A", payload)
	publisher := testPublisher(t, root, remote, syncStore)
	before := remoteCount(t, remote)
	result, err := publisher.Publish(context.Background(), request("song-a", revision))
	if err == nil || result.State != IntentValidationFailed || !IsCode(err, CodeValidation) {
		t.Fatalf("Publish invalid = %+v, %v", result, err)
	}
	if remoteCount(t, remote) != before {
		t.Fatal("validation failure created a remote commit")
	}
	intent, err := publisher.Ledger().Intent(result.IntentID)
	if err != nil {
		t.Fatal(err)
	}
	if intent.ExpectedCurrentRevisionID != revision || intent.ExpectedPublishedRevisionID != "" || intent.ExpectedGitBase != remoteHead(t, remote) || intent.CommitHash != "" {
		t.Fatalf("durable intent expectations = %+v", intent)
	}
}

func TestValidationGatesSchemaIdentityLinksCorpusAndApex(t *testing.T) {
	cases := []struct {
		name     string
		fixtures map[string]string
		payload  PublicationPayload
		title    string
		apexFail bool
	}{
		{name: "schema", payload: leadPayload("songs/song-a.md", "Different", "Body"), title: "Song A"},
		{name: "identity", payload: PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: SetList, Path: "sets/set-a.md", Source: "---\nschema_version: 1\nid: set-b\ntitle: Set A\n---\n\n# Set A\n\n## Set 1\n", Deleted: false}, title: "Set A"},
		{name: "link", payload: PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: LeadSheet, Path: "songs/song-a.md", Source: "# Song A\n\n[missing](missing.md)\n"}, title: "Song A"},
		{name: "corpus identity", fixtures: map[string]string{"songs/existing.md": "---\nid: song-a\n---\n\n# Existing\n"}, payload: PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: LeadSheet, Path: "songs/song-a.md", Source: "---\nid: song-a\n---\n\n# Song A\n"}, title: "Song A"},
		{name: "apex", payload: leadPayload("songs/song-a.md", "Song A", "Body"), title: "Song A", apexFail: true},
	}
	for index, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			root, remote := initRemote(t, test.fixtures)
			syncStore := newFakeSync()
			revision := fmt.Sprintf("rev-%024x", index+1)
			syncStore.set("song-a", revision, test.title, test.payload)
			var options []func(*Options)
			if test.apexFail {
				script := filepath.Join(root, "apex-fail")
				if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 9\n"), 0o755); err != nil {
					t.Fatal(err)
				}
				options = append(options, func(config *Options) { config.ValidatorOptions = ValidatorOptions{ApexPath: script} })
			}
			publisher := testPublisher(t, root, remote, syncStore, options...)
			before := remoteCount(t, remote)
			result, err := publisher.Publish(context.Background(), request("song-a", revision))
			if err == nil || result.State != IntentValidationFailed {
				t.Fatalf("invalid publication = %+v, %v", result, err)
			}
			if remoteCount(t, remote) != before {
				t.Fatal("validation gate created a commit")
			}
		})
	}
}

func TestCommitPushAndFinalizationCrashRecoveryNoDuplicateCommits(t *testing.T) {
	points := []FailurePoint{FailureBeforeCommit, FailureAfterCommit, FailureBeforePush, FailureAfterPush, FailureBeforeFinalize, FailureAfterFinalize}
	for index, point := range points {
		t.Run(string(point), func(t *testing.T) {
			root, remote := initRemote(t, nil)
			syncStore := newFakeSync()
			document := fmt.Sprintf("song-%c", 'a'+index)
			revision := fmt.Sprintf("rev-%024x", 100+index)
			syncStore.set(document, revision, "Song", leadPayload("songs/"+document+".md", "Song", "Body"))
			fired := false
			publisher := testPublisher(t, root, remote, syncStore, func(config *Options) {
				config.Hooks.Failure = func(observed FailurePoint, _ Intent) error {
					if observed == point && !fired {
						fired = true
						return errors.New("crash")
					}
					return nil
				}
			})
			before := remoteCount(t, remote)
			first, err := publisher.Publish(context.Background(), request(document, revision))
			if err == nil || !IsCode(err, CodeInjectedFailure) {
				t.Fatalf("injected %s = %+v, %v", point, first, err)
			}
			acceptedCount := remoteCount(t, remote)
			acceptedBeforeFailure := point == FailureAfterPush || point == FailureBeforeFinalize || point == FailureAfterFinalize
			if !acceptedBeforeFailure && acceptedCount != before {
				t.Fatalf("%s failure unexpectedly reached remote", point)
			}
			if acceptedBeforeFailure && acceptedCount != before+1 {
				t.Fatalf("%s remote count = %d, want %d", point, acceptedCount, before+1)
			}
			if first.Commit != "" && !acceptedBeforeFailure {
				if err := os.RemoveAll(filepath.Join(root, "publisher-work", "intents", first.IntentID)); err != nil {
					t.Fatal(err)
				}
			}
			second, err := publisher.Recover(context.Background(), request(document, revision))
			if err != nil || second.State != IntentFinalized || second.Commit == "" {
				t.Fatalf("recovery = %+v, %v", second, err)
			}
			if first.Commit != "" && first.Commit != second.Commit {
				t.Fatalf("recovery rebuilt a different commit: %s != %s", first.Commit, second.Commit)
			}
			if remoteCount(t, remote) != before+1 {
				t.Fatal("recovery created a duplicate commit")
			}
			third, err := publisher.Recover(context.Background(), request(document, revision))
			if err != nil || !third.Idempotent || third.Commit != second.Commit || remoteCount(t, remote) != before+1 {
				t.Fatalf("idempotent retry = %+v, %v", third, err)
			}
		})
	}
}

func externalCommit(t *testing.T, root, remote, label string, mutate func(string)) string {
	t.Helper()
	clone := filepath.Join(root, "external-"+label)
	runGit(t, "", "clone", "--quiet", remote, clone)
	runGit(t, clone, "config", "user.name", "External Editor")
	runGit(t, clone, "config", "user.email", "external@example.invalid")
	mutate(clone)
	runGit(t, clone, "add", "-A")
	command := exec.Command("git", "-C", clone, "commit", "-m", "external "+label)
	command.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_DATE=2000-01-02T00:00:00Z", "GIT_COMMITTER_DATE=2000-01-02T00:00:00Z")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("external commit: %v: %s", err, output)
	}
	head := runGit(t, clone, "rev-parse", "HEAD")
	runGit(t, clone, "push", "--quiet", "origin", "HEAD:refs/heads/main")
	return head
}

func TestRemoteDriftDoesNotOverwriteExternalCommit(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	revision := "rev-bbbbbbbbbbbbbbbbbbbbbbbb"
	syncStore.set("song-a", revision, "Song A", leadPayload("songs/song-a.md", "Song A", "Body"))
	fired := false
	publisher := testPublisher(t, root, remote, syncStore, func(config *Options) {
		config.Hooks.Failure = func(point FailurePoint, _ Intent) error {
			if point == FailureAfterIntent && !fired {
				fired = true
				return errors.New("pause")
			}
			return nil
		}
	})
	first, err := publisher.Publish(context.Background(), request("song-a", revision))
	if err == nil || first.IntentID == "" {
		t.Fatalf("intent pause = %+v, %v", first, err)
	}
	external := externalCommit(t, root, remote, "drift", func(clone string) {
		if err := os.WriteFile(filepath.Join(clone, "README.md"), []byte("external\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	result, err := publisher.Recover(context.Background(), request("song-a", revision))
	if err == nil || !IsCode(err, CodeRemoteDrift) || result.State != IntentRemoteDrift {
		t.Fatalf("remote drift recovery = %+v, %v", result, err)
	}
	if remoteHead(t, remote) != external {
		t.Fatal("publisher overwrote external remote head")
	}
	if records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"}); err != nil || len(records) != 0 {
		t.Fatalf("reconcile unrelated drift = %+v, %v", records, err)
	}
	rebased, err := publisher.Recover(context.Background(), request("song-a", revision))
	if err != nil || rebased.State != IntentFinalized || rebased.Commit == "" || remoteCount(t, remote) != 3 {
		t.Fatalf("rebase accepted revision after reconciliation = %+v, %v", rebased, err)
	}
}

func publishBaseline(t *testing.T, root, remote string, syncStore *fakeSync) (*Publisher, string) {
	t.Helper()
	revision := "rev-cccccccccccccccccccccccc"
	syncStore.set("song-a", revision, "Song A", leadPayload("songs/song-a.md", "Song A", "Published body"))
	publisher := testPublisher(t, root, remote, syncStore)
	if result, err := publisher.Publish(context.Background(), request("song-a", revision)); err != nil || result.State != IntentFinalized {
		t.Fatalf("baseline publication = %+v, %v", result, err)
	}
	return publisher, revision
}

func mutateSidecarClaims(t *testing.T, clone string, path string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(clone, filepath.FromSlash(sidecarPath("song-a"))))
	if err != nil {
		t.Fatal(err)
	}
	var sidecar map[string]any
	if err := json.Unmarshal(raw, &sidecar); err != nil {
		t.Fatal(err)
	}
	sidecar["revision_id"] = "rev-ffffffffffffffffffffffff"
	sidecar["source_sha256"] = strings.Repeat("0", 64)
	if path != "" {
		sidecar["path"] = path
	}
	changed, _ := json.Marshal(sidecar)
	if err := os.WriteFile(filepath.Join(clone, filepath.FromSlash(sidecarPath("song-a"))), append(changed, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestExternalEditDeleteRenameImportDurablyAndIgnoreClaims(t *testing.T) {
	cases := []struct {
		name        string
		kind        ReconciliationKind
		mutate      func(*testing.T, string)
		wantPath    string
		wantDeleted bool
		wantSource  string
	}{
		{name: "edit", kind: ReconcileEdit, wantPath: "songs/song-a.md", wantSource: "# Song A\n\nExternal edit\n", mutate: func(t *testing.T, clone string) {
			if err := os.WriteFile(filepath.Join(clone, "songs/song-a.md"), []byte("# Song A\n\nExternal edit\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			mutateSidecarClaims(t, clone, "")
		}},
		{name: "delete", kind: ReconcileDelete, wantPath: "songs/song-a.md", wantDeleted: true, mutate: func(t *testing.T, clone string) {
			if err := os.Remove(filepath.Join(clone, "songs/song-a.md")); err != nil {
				t.Fatal(err)
			}
			mutateSidecarClaims(t, clone, "")
		}},
		{name: "rename", kind: ReconcileRename, wantPath: "songs/Song-Renamed.md", wantSource: "# Song A\n\nPublished body\n", mutate: func(t *testing.T, clone string) {
			runGit(t, clone, "mv", "songs/song-a.md", "songs/Song-Renamed.md")
			mutateSidecarClaims(t, clone, "songs/Song-Renamed.md")
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			root, remote := initRemote(t, nil)
			syncStore := newFakeSync()
			publisher, _ := publishBaseline(t, root, remote, syncStore)
			externalCommit(t, root, remote, test.name, func(clone string) { test.mutate(t, clone) })
			records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"})
			if err != nil || len(records) != 1 {
				t.Fatalf("Reconcile = %+v, %v", records, err)
			}
			record := records[0]
			if record.Kind != test.kind || record.CandidatePath != test.wantPath || record.CandidateDeleted != test.wantDeleted || string(record.CandidateSource) != test.wantSource || record.ConflictID == "" || record.Status != "resolved" || record.ResolutionRevisionID != record.CandidateRevisionID {
				t.Fatalf("reconciliation record = %+v", record)
			}
			stored, err := publisher.Ledger().Reconciliation(record.ConflictID)
			if err != nil || string(stored.CandidateSource) != test.wantSource || stored.CandidateRevisionID == "rev-ffffffffffffffffffffffff" {
				t.Fatalf("preserved candidate = %+v, %v", stored, err)
			}
			if again, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"}); err != nil || len(again) != 0 {
				t.Fatalf("idempotent reconciliation = %+v, %v", again, err)
			}
			published, err := publisher.Ledger().PublishedDocument("owner-a", "song-a")
			if err != nil || !published.ExternalSource || published.RevisionID != record.CandidateRevisionID || published.Path != test.wantPath {
				t.Fatalf("durable actual published state = %+v, %v", published, err)
			}
		})
	}
}

func TestCoordinatedBackupAndRestorePackage(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore, err := v2sync.Open(filepath.Join(root, "sync.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer syncStore.Close()
	if _, err := syncStore.RegisterDevice("owner-a", "device-a", "registration-a", "Publisher", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(leadPayload("songs/backup-song.md", "Backup Song", "Body"))
	if err != nil {
		t.Fatal(err)
	}
	hash, canonical, err := v2sync.HashPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := syncStore.Apply(v2sync.ApplyEnvelope{
		ProtocolVersion: v2sync.ProtocolVersion, OwnerID: "owner-a", DeviceID: "device-a",
		OperationID: "backup-operation", OperationKind: "replace", DocumentID: "backup-song",
		Title: "Backup Song", Payload: canonical, PayloadSHA256: hash,
	})
	if err != nil {
		t.Fatal(err)
	}
	publisher := testPublisher(t, root, remote, syncStore)
	if result, err := publisher.Publish(context.Background(), request("backup-song", outcome.RevisionID)); err != nil || result.State != IntentFinalized {
		t.Fatalf("publish before backup = %+v, %v", result, err)
	}
	backup := filepath.Join(root, "coordinated-backup")
	manifest, err := publisher.CoordinatedBackup(context.Background(), syncStore, "backup-worker", backup)
	if err != nil || manifest.SchemaVersion != "v2backup-1" {
		t.Fatalf("CoordinatedBackup = (%+v, %v)", manifest, err)
	}
	if err := VerifyCoordinatedBackup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreCoordinatedBackup(context.Background(), backup, filepath.Join(root, "restored"))
	if err != nil {
		t.Fatal(err)
	}
	restoredSync, err := v2sync.Open(restored.SyncPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := restoredSync.Integrity(); err != nil {
		t.Fatal(err)
	}
	_ = restoredSync.Close()
	restoredLedger, err := OpenLedger(restored.PublicationPath, restored.LockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restoredLedger.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := restoredLedger.AcquireLease(ctx, "worker"); err == nil || !IsCode(err, CodeLeaseBusy) {
		t.Fatalf("restored publication was not disabled: %v", err)
	}
}

func TestIntegrityOnlineBackupAndGitBundleRestore(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	if err := publisher.Integrity(context.Background()); err != nil {
		t.Fatalf("Integrity: %v", err)
	}
	backupDB := filepath.Join(root, "backup", "publication.sqlite")
	bundle := filepath.Join(root, "backup", "publication.bundle")
	result, err := publisher.Backup(context.Background(), "backup-worker", backupDB, bundle)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if result.LedgerBase == "" || result.RemoteHead != remoteHead(t, remote) {
		t.Fatalf("backup result = %+v", result)
	}
	restoredLedger, err := OpenLedger(backupDB)
	if err != nil {
		t.Fatal(err)
	}
	defer restoredLedger.Close()
	if err := restoredLedger.Integrity(); err != nil {
		t.Fatalf("restored ledger integrity: %v", err)
	}
	published, err := restoredLedger.PublishedDocument("owner-a", "song-a")
	if err != nil || published.RevisionID == "" {
		t.Fatalf("restored publication = %+v, %v", published, err)
	}
	restoredRemote := filepath.Join(root, "restored.git")
	if err := RestoreBundle(context.Background(), bundle, restoredRemote); err != nil {
		t.Fatalf("RestoreBundle: %v", err)
	}
	if got := remoteHead(t, restoredRemote); got != result.RemoteHead {
		t.Fatalf("restored Git head = %s, want %s", got, result.RemoteHead)
	}
}

func TestSidecarClaimOnlyDriftIsIgnored(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, revision := publishBaseline(t, root, remote, syncStore)
	external := externalCommit(t, root, remote, "claims-only", func(clone string) {
		mutateSidecarClaims(t, clone, "")
	})
	records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"})
	if err != nil || len(records) != 0 {
		t.Fatalf("claim-only reconcile = %+v, %v", records, err)
	}
	published, err := publisher.Ledger().PublishedDocument("owner-a", "song-a")
	if err != nil || published.RevisionID != revision || published.CommitHash == external || published.ExternalSource {
		t.Fatalf("claim-only drift changed durable content state: %+v, %v", published, err)
	}
	base, initialized, err := publisher.Ledger().GitBase()
	if err != nil || !initialized || base != external {
		t.Fatalf("claim-only reconciliation base = %q/%v, %v", base, initialized, err)
	}
}

func TestReconciliationResolutionAllowsDeliberateMergedPublication(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	local := "rev-aaaaaaaaaaaaaaaaaaaaaaaa"
	syncStore.set("song-a", local, "Song A", leadPayload("songs/song-a.md", "Song A", "Unpublished local edit"))
	externalCommit(t, root, remote, "resolve", func(clone string) {
		if err := os.WriteFile(filepath.Join(clone, "songs/song-a.md"), []byte("# Song A\n\nExternal edit\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		mutateSidecarClaims(t, clone, "")
	})
	records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"})
	if err != nil || len(records) != 1 {
		t.Fatalf("Reconcile = %+v, %v", records, err)
	}
	if records[0].Status != "open" || records[0].ConflictID == "" {
		t.Fatalf("external/local divergence did not create an open sync conflict: %+v", records[0])
	}
	resolution := "rev-dddddddddddddddddddddddd"
	syncStore.set("song-a", resolution, "Song A", leadPayload("songs/song-a.md", "Song A", "Merged external and local"))
	syncStore.mu.Lock()
	syncStore.conflicts["song-a"] = 0
	syncStore.mu.Unlock()
	if err := publisher.ResolveReconciliation(context.Background(), ResolveReconciliationRequest{OwnerID: "owner-a", DeviceID: "device-a", ConflictID: records[0].ConflictID, ResolutionRevisionID: resolution, Holder: "resolver"}); err != nil {
		t.Fatalf("ResolveReconciliation: %v", err)
	}
	if open, err := publisher.Ledger().OpenReconciliationCount("owner-a", "song-a"); err != nil || open != 0 {
		t.Fatalf("open reconciliation count = %d, %v", open, err)
	}
	before := remoteCount(t, remote)
	result, err := publisher.Publish(context.Background(), request("song-a", resolution))
	if err != nil || result.State != IntentFinalized || remoteCount(t, remote) != before+1 {
		t.Fatalf("merged publication = %+v, %v", result, err)
	}
}

func TestApplicationRenameAndDeleteMaterialization(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)

	renameRevision := "rev-eeeeeeeeeeeeeeeeeeeeeeee"
	syncStore.set("song-a", renameRevision, "Song A", leadPayload("songs/Song-Renamed.md", "Song A", "Published body"))
	if result, err := publisher.Publish(context.Background(), request("song-a", renameRevision)); err != nil || result.State != IntentFinalized {
		t.Fatalf("rename publication = %+v, %v", result, err)
	}
	clone := filepath.Join(root, "inspect-rename")
	runGit(t, "", "clone", "--quiet", remote, clone)
	if _, err := os.Stat(filepath.Join(clone, "songs/song-a.md")); !os.IsNotExist(err) {
		t.Fatalf("old path remains after rename: %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(clone, "songs/Song-Renamed.md")); err != nil || string(raw) != "# Song A\n\nPublished body\n" {
		t.Fatalf("renamed source = %q, %v", raw, err)
	}

	deleteRevision := "rev-ffffffffffffffffffffffff"
	syncStore.set("song-a", deleteRevision, "Song A", PublicationPayload{SchemaVersion: PayloadSchemaVersion, Kind: LeadSheet, Path: "songs/Song-Renamed.md", Source: "", Deleted: true})
	if result, err := publisher.Publish(context.Background(), request("song-a", deleteRevision)); err != nil || result.State != IntentFinalized {
		t.Fatalf("delete publication = %+v, %v", result, err)
	}
	deleted, err := publisher.Ledger().PublishedDocument("owner-a", "song-a")
	if err != nil || !deleted.Deleted || len(deleted.Source) != 0 || deleted.Path != "songs/Song-Renamed.md" {
		t.Fatalf("deleted durable state = %+v, %v", deleted, err)
	}
	deleteClone := filepath.Join(root, "inspect-delete")
	runGit(t, "", "clone", "--quiet", remote, deleteClone)
	if _, err := os.Stat(filepath.Join(deleteClone, "songs/Song-Renamed.md")); !os.IsNotExist(err) {
		t.Fatalf("deleted path remains: %v", err)
	}
}

func TestCurrentCanonicalCorpusPassesIdentityAndLinkValidation(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateCorpus(root); err != nil {
		t.Fatalf("current canonical corpus validation: %v", err)
	}
}

func TestPublisherHoldsProcessLockAcrossMaterializationAndGit(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	revision := "rev-111111111111111111111111"
	syncStore.set("song-a", revision, "Song A", leadPayload("songs/song-a.md", "Song A", "Body"))
	entered := make(chan struct{})
	release := make(chan struct{})
	publisherA := testPublisher(t, root, remote, syncStore, func(config *Options) {
		config.WorkRoot = filepath.Join(root, "work-a")
		config.Hooks.Failure = func(point FailurePoint, _ Intent) error {
			if point == FailureAfterMaterialize {
				close(entered)
				<-release
			}
			return nil
		}
	})
	publisherB := testPublisher(t, root, remote, syncStore, func(config *Options) {
		config.WorkRoot = filepath.Join(root, "work-b")
	})
	done := make(chan error, 1)
	go func() {
		_, err := publisherA.Publish(context.Background(), request("song-a", revision))
		done <- err
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	secondRequest := request("song-a", revision)
	secondRequest.Holder = "worker-b"
	if _, err := publisherB.Publish(ctx, secondRequest); err == nil || !IsCode(err, CodeLeaseBusy) {
		close(release)
		t.Fatalf("concurrent publisher = %v, want lease busy", err)
	}
	integrityContext, integrityCancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer integrityCancel()
	if err := publisherB.Integrity(integrityContext, "integrity-b"); err == nil || !IsCode(err, CodeLeaseBusy) {
		close(release)
		t.Fatalf("concurrent integrity check = %v, want lease busy", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("first publisher: %v", err)
	}
}

func TestBackupRestoreRepairsRemoteAcceptedUnfinalizedCommit(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	revision := "rev-222222222222222222222222"
	syncStore.set("song-a", revision, "Song A", leadPayload("songs/song-a.md", "Song A", "Body"))
	fired := false
	publisher := testPublisher(t, root, remote, syncStore, func(config *Options) {
		config.Hooks.Failure = func(point FailurePoint, _ Intent) error {
			if point == FailureAfterPush && !fired {
				fired = true
				return errors.New("remote accepted, finalization lost")
			}
			return nil
		}
	})
	first, err := publisher.Publish(context.Background(), request("song-a", revision))
	if err == nil || first.State != IntentCommitted || first.Commit == "" {
		t.Fatalf("unfinalized publication = %+v, %v", first, err)
	}
	backupDB := filepath.Join(root, "skew-backup", "publication.sqlite")
	bundle := filepath.Join(root, "skew-backup", "publication.bundle")
	if _, err := publisher.Backup(context.Background(), "backup-worker", backupDB, bundle); err != nil {
		t.Fatalf("skew backup: %v", err)
	}
	restoredRemote := filepath.Join(root, "skew-restored.git")
	if err := RestoreBundle(context.Background(), bundle, restoredRemote); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(Options{
		LedgerPath: backupDB,
		Remote:     restoredRemote, WorkRoot: filepath.Join(root, "skew-restored-work"), Sync: syncStore,
		ValidatorOptions: ValidatorOptions{SkipApex: true},
		Hooks:            Hooks{Now: func() time.Time { return time.Unix(1_700_000_000, 0).UTC() }},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	before := remoteCount(t, restoredRemote)
	result, err := restored.Recover(context.Background(), request("song-a", revision))
	if err != nil || result.State != IntentFinalized || result.Commit != first.Commit || remoteCount(t, restoredRemote) != before {
		t.Fatalf("restored skew recovery = %+v, %v", result, err)
	}
}

func TestArchiveLedgerRejectsCrossOwnerGitCollisions(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	firstRevision := "rev-333333333333333333333333"
	syncStore.set("song-a", firstRevision, "Song A", leadPayload("songs/song-a.md", "Song A", "Owner A"))
	publisher := testPublisher(t, root, remote, syncStore)
	if _, err := publisher.Publish(context.Background(), request("song-a", firstRevision)); err != nil {
		t.Fatal(err)
	}
	secondRevision := "rev-444444444444444444444444"
	syncStore.set("song-b", secondRevision, "Song B", leadPayload("songs/song-b.md", "Song B", "Owner B"))
	other := request("song-b", secondRevision)
	other.OwnerID = "owner-b"
	other.Holder = "owner-b-worker"
	if _, err := publisher.Publish(context.Background(), other); err == nil || !IsCode(err, CodeIneligible) {
		t.Fatalf("cross-owner publication = %v", err)
	}
	owner, err := publisher.Ledger().ArchiveOwner()
	if err != nil || owner != "owner-a" {
		t.Fatalf("archive owner = %q, %v", owner, err)
	}
}

func TestInheritedGitConfigurationCannotEscapeIsolation(t *testing.T) {
	root, remote := initRemote(t, nil)
	maliciousHooks := filepath.Join(root, "malicious-hooks")
	if err := os.MkdirAll(maliciousHooks, 0o755); err != nil {
		t.Fatal(err)
	}
	hookMarker := filepath.Join(root, "hook-ran")
	hook := filepath.Join(maliciousHooks, "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch "+hookMarker+"\nexit 77\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_COUNT", "2")
	t.Setenv("GIT_CONFIG_KEY_0", "core.hooksPath")
	t.Setenv("GIT_CONFIG_VALUE_0", maliciousHooks)
	t.Setenv("GIT_CONFIG_KEY_1", "user.name")
	t.Setenv("GIT_CONFIG_VALUE_1", "Inherited Attacker")
	t.Setenv("GIT_DIR", filepath.Join(root, "wrong.git"))

	syncStore := newFakeSync()
	revision := "rev-555555555555555555555555"
	syncStore.set("song-a", revision, "Song A", leadPayload("songs/song-a.md", "Song A", "Body"))
	publisher := testPublisher(t, root, remote, syncStore)
	result, err := publisher.Publish(context.Background(), request("song-a", revision))
	if err != nil || result.State != IntentFinalized {
		t.Fatalf("isolated publication = %+v, %v", result, err)
	}
	if _, err := os.Stat(hookMarker); !os.IsNotExist(err) {
		t.Fatalf("inherited Git hook ran: %v", err)
	}
}

func TestLowSimilarityDeleteAndUnrelatedAdditionRemainSeparateConflicts(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	externalCommit(t, root, remote, "low-similarity-rename", func(clone string) {
		runGit(t, clone, "mv", "songs/song-a.md", "songs/Completely-New.md")
		if err := os.WriteFile(filepath.Join(clone, "songs/Completely-New.md"), []byte("# Song A\n\nCompletely rewritten external source with no common body.\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		// Keep the sidecar path stale: without a trusted identity locator this
		// must remain a deletion plus a separate unowned addition.
		mutateSidecarClaims(t, clone, "")
	})
	records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"})
	if err == nil || !IsCode(err, CodeReconciliation) || len(records) != 1 {
		t.Fatalf("ambiguous reconciliation = %+v, %v", records, err)
	}
	if records[0].Kind != ReconcileDelete || records[0].CandidatePath != "songs/song-a.md" || !records[0].CandidateDeleted {
		t.Fatalf("known deletion candidate = %+v", records[0])
	}
	additions, err := publisher.Ledger().UnownedAdditions("owner-a")
	if err != nil || len(additions) != 1 || additions[0].Path != "songs/Completely-New.md" || !strings.Contains(string(additions[0].Source), "Completely rewritten") {
		t.Fatalf("separate unowned addition = %+v, %v", additions, err)
	}
	published, err := publisher.Ledger().PublishedDocument("owner-a", "song-a")
	if err != nil || published.Path != "songs/song-a.md" || published.Deleted {
		t.Fatalf("ambiguous transition rewrote published identity: %+v, %v", published, err)
	}
	resolution := "rev-abababababababababababab"
	syncStore.set("song-a", resolution, "Song A", leadPayload("songs/song-a.md", "Song A", "Resolved deletion without adopting unrelated content"))
	if err := publisher.ResolveReconciliation(context.Background(), ResolveReconciliationRequest{OwnerID: "owner-a", DeviceID: "device-a", ConflictID: records[0].ConflictID, ResolutionRevisionID: resolution, Holder: "resolver"}); err != nil {
		t.Fatalf("resolve known deletion: %v", err)
	}
	before := remoteCount(t, remote)
	if result, err := publisher.Publish(context.Background(), request("song-a", resolution)); err == nil || !IsCode(err, CodeReconciliation) || result.Commit != "" || remoteCount(t, remote) != before {
		t.Fatalf("unowned addition did not block resolved publication = %+v, %v", result, err)
	}
	inspect := filepath.Join(root, "inspect-unrelated")
	runGit(t, "", "clone", "--quiet", remote, inspect)
	if raw, err := os.ReadFile(filepath.Join(inspect, "songs/Completely-New.md")); err != nil || !strings.Contains(string(raw), "Completely rewritten") {
		t.Fatalf("unrelated external file was lost: %q, %v", raw, err)
	}
}

func TestReconciliationPreservesCandidateWhenSyncCurrentIsMissing(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	syncStore.remove("song-a")
	externalCommit(t, root, remote, "missing-sync-current", func(clone string) {
		if err := os.WriteFile(filepath.Join(clone, "songs/song-a.md"), []byte("# Song A\n\nExternal survives missing sync row\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"})
	if err != nil || len(records) != 1 || records[0].CurrentRevisionID != "" || !strings.Contains(string(records[0].CandidateSource), "External survives") {
		t.Fatalf("missing-current reconciliation = %+v, %v", records, err)
	}
}

func TestPublicationReservationBlocksEligibilityChangeThroughPush(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	original := "rev-666666666666666666666666"
	newer := "rev-777777777777777777777777"
	syncStore.set("song-a", original, "Song A", leadPayload("songs/song-a.md", "Song A", "Original"))
	blocked := false
	publisher := testPublisher(t, root, remote, syncStore, func(config *Options) {
		config.Hooks.Failure = func(observed FailurePoint, _ Intent) error {
			if observed == FailureBeforePush && !blocked {
				err := syncStore.attemptSet("song-a", newer, "Song A", leadPayload("songs/song-a.md", "Song A", "Newer"))
				blocked = errors.Is(err, v2sync.ErrPublicationReserved)
			}
			return nil
		}
	})
	before := remoteCount(t, remote)
	result, err := publisher.Publish(context.Background(), request("song-a", original))
	if err != nil || result.State != IntentFinalized || remoteCount(t, remote) != before+1 || !blocked {
		t.Fatalf("publication reservation race = %+v, blocked=%v, err=%v", result, blocked, err)
	}
}

func TestLedgerRejectsDifferentFlockIdentityForSameDatabase(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "ledger.sqlite")
	first, err := OpenLedger(path, filepath.Join(root, "one.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := OpenLedger(path, filepath.Join(root, "two.lock")); err == nil {
		second.Close()
		t.Fatal("same ledger opened with a different process lock")
	} else if !IsCode(err, CodeInvalidConfig) {
		t.Fatalf("different lock identity error = %v", err)
	}
}

func TestPathCollisionFailsBeforeGitCommitOrPush(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	before := remoteCount(t, remote)
	revision := "rev-888888888888888888888888"
	syncStore.set("song-b", revision, "Song B", leadPayload("songs/song-a.md", "Song B", "Must not overwrite A"))
	result, err := publisher.Publish(context.Background(), request("song-b", revision))
	if err == nil || !IsCode(err, CodeIneligible) || result.Commit != "" || remoteCount(t, remote) != before {
		t.Fatalf("path collision = %+v, %v", result, err)
	}
	published, err := publisher.Ledger().PublishedDocument("owner-a", "song-a")
	if err != nil || !strings.Contains(string(published.Source), "Published body") {
		t.Fatalf("original publication changed: %+v, %v", published, err)
	}
}

func TestReconcileRejectsUnownedCanonicalAdditionWithoutAdvancingBase(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	baseBefore, _, err := publisher.Ledger().GitBase()
	if err != nil {
		t.Fatal(err)
	}
	externalCommit(t, root, remote, "unowned-addition", func(clone string) {
		if err := os.WriteFile(filepath.Join(clone, "songs/unowned.md"), []byte("# Unowned\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	if records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"}); err == nil || !IsCode(err, CodeReconciliation) || len(records) != 0 {
		t.Fatalf("unowned addition reconcile = %+v, %v", records, err)
	}
	baseAfter, _, err := publisher.Ledger().GitBase()
	if err != nil || baseAfter != baseBefore {
		t.Fatalf("unowned addition advanced base: %s -> %s, %v", baseBefore, baseAfter, err)
	}
	additions, err := publisher.Ledger().UnownedAdditions("owner-a")
	if err != nil || len(additions) != 1 || additions[0].Path != "songs/unowned.md" || string(additions[0].Source) != "# Unowned\n" {
		t.Fatalf("unowned addition was not durably preserved: %+v, %v", additions, err)
	}
}

func TestMalformedSidecarCannotHideExternalBodyCandidate(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	externalCommit(t, root, remote, "malformed-sidecar", func(clone string) {
		if err := os.WriteFile(filepath.Join(clone, "songs/song-a.md"), []byte("# Song A\n\nExternal body survives sidecar corruption\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(clone, filepath.FromSlash(sidecarPath("song-a"))), []byte("{not-json\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	records, err := publisher.Reconcile(context.Background(), ReconcileRequest{OwnerID: "owner-a", DeviceID: "device-a", Holder: "reconciler", Actor: "operator"})
	if err != nil || len(records) != 1 || !strings.Contains(string(records[0].CandidateSource), "survives sidecar corruption") || !strings.Contains(records[0].ValidationError, "sidecar") {
		t.Fatalf("malformed sidecar reconciliation = %+v, %v", records, err)
	}
}

func TestValidSetListPublicationWithResolvedCorpusLink(t *testing.T) {
	root, remote := initRemote(t, map[string]string{"songs/song-a.md": "# Song A\n\nBody\n"})
	syncStore := newFakeSync()
	revision := "rev-999999999999999999999999"
	payload := PublicationPayload{
		SchemaVersion: PayloadSchemaVersion,
		Kind:          SetList,
		Path:          "sets/set-a.md",
		Source:        "---\nschema_version: 1\nid: set-a\ntitle: Set A\n---\n\n# Set A\n\n## Set 1\n1. [Song A](../songs/song-a.md)\n",
	}
	syncStore.set("set-a", revision, "Set A", payload)
	publisher := testPublisher(t, root, remote, syncStore)
	result, err := publisher.Publish(context.Background(), PublishRequest{OwnerID: "owner-a", DeviceID: "device-a", DocumentID: "set-a", RevisionID: revision, Holder: "worker-a"})
	if err != nil || result.State != IntentFinalized {
		t.Fatalf("valid set-list publication = %+v, %v", result, err)
	}
	published, err := publisher.Ledger().PublishedDocument("owner-a", "set-a")
	if err != nil || published.Kind != SetList || published.Path != "sets/set-a.md" {
		t.Fatalf("published set-list = %+v, %v", published, err)
	}
}

func TestBackupRejectsReservedEqualAndSymlinkAliasedDestinations(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	alias := filepath.Join(root, "work-alias")
	if err := os.Symlink(publisher.git.root, alias); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, ledger, bundle string
	}{
		{"live-ledger", publisher.ledger.path, filepath.Join(root, "safe-a.bundle")},
		{"live-wal", publisher.ledger.path + "-wal", filepath.Join(root, "safe-b.bundle")},
		{"live-shm", publisher.ledger.path + "-shm", filepath.Join(root, "safe-c.bundle")},
		{"live-flock", filepath.Join(root, "safe-d.sqlite"), publisher.ledger.lockPath},
		{"equal-artifacts", filepath.Join(root, "same.backup"), filepath.Join(root, "same.backup")},
		{"inside-work-root", filepath.Join(root, "safe-e.sqlite"), filepath.Join(publisher.git.root, "forbidden.bundle")},
		{"symlink-alias-work-root", filepath.Join(root, "safe-f.sqlite"), filepath.Join(alias, "forbidden.bundle")},
	}
	head := remoteHead(t, remote)
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := publisher.Backup(context.Background(), "backup-worker", test.ledger, test.bundle); err == nil || !IsCode(err, CodeInvalidConfig) {
				t.Fatalf("unsafe backup destination = %v", err)
			}
			if remoteHead(t, remote) != head {
				t.Fatal("unsafe backup changed remote head")
			}
			if err := publisher.ledger.Integrity(); err != nil {
				t.Fatalf("unsafe backup damaged live ledger: %v", err)
			}
		})
	}
	if err := publisher.ledger.Backup(publisher.ledger.lockPath); err == nil || !IsCode(err, CodeInvalidConfig) {
		t.Fatalf("direct ledger backup accepted live flock path: %v", err)
	}
}

func TestBackupBundleAdvertisesExactlyReportedRemoteHead(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	ledgerBackup := filepath.Join(root, "verified", "ledger.sqlite")
	bundleBackup := filepath.Join(root, "verified", "archive.bundle")
	result, err := publisher.Backup(context.Background(), "backup-worker", ledgerBackup, bundleBackup)
	if err != nil {
		t.Fatal(err)
	}
	listed := runGit(t, "", "bundle", "list-heads", bundleBackup, DefaultBranch)
	fields := strings.Fields(listed)
	if len(fields) != 2 || fields[0] != result.RemoteHead || fields[1] != DefaultBranch {
		t.Fatalf("bundle heads = %q, backup result = %+v", listed, result)
	}
}

func TestBackupHoldsFlockAcrossLedgerSnapshotAndGitBundle(t *testing.T) {
	root, remote := initRemote(t, nil)
	syncStore := newFakeSync()
	publisher, _ := publishBaseline(t, root, remote, syncStore)
	entered := make(chan struct{})
	release := make(chan struct{})
	publisher.SetHooks(Hooks{
		Now: func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
		Failure: func(point FailurePoint, _ Intent) error {
			if point == FailureBeforeBackupBundle {
				close(entered)
				<-release
			}
			return nil
		},
	})
	done := make(chan error, 1)
	go func() {
		_, err := publisher.Backup(context.Background(), "backup-worker", filepath.Join(root, "locked-backup", "ledger.sqlite"), filepath.Join(root, "locked-backup", "archive.bundle"))
		done <- err
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if lease, err := publisher.Ledger().AcquireLease(ctx, "competing-worker"); err == nil {
		lease.Release()
		close(release)
		t.Fatal("competing lease entered while backup was between SQLite and Git artifacts")
	} else if !IsCode(err, CodeLeaseBusy) {
		close(release)
		t.Fatalf("competing lease error = %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("backup after lock drill: %v", err)
	}
}
