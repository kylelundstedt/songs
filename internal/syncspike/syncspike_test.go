package syncspike

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "spike.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}
func apply(t *testing.T, s *Store, id, device, doc, base, title, body string) Outcome {
	t.Helper()
	out, err := s.Apply(Operation{id, device, doc, base, title, []byte(body)})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestOperationIdentityKindsAndBaseSafety(t *testing.T) {
	s := newStore(t)
	a := apply(t, s, "seed-a", "device-a", "song-a", "", "Song A", "# Song A\n")
	b := apply(t, s, "seed-b", "device-b", "song-b", "", "Song B", "# Song B\n")
	// The same operation ID is independent per device and contributes to revision identity.
	one := apply(t, s, "same-op", "device-a", "song-a", a.RevisionID, "Song A", "# Song A\na\n")
	two := apply(t, s, "same-op", "device-b", "song-b", b.RevisionID, "Song B", "# Song B\nb\n")
	if one.RevisionID == two.RevisionID {
		t.Fatal("revision ID omitted device identity")
	}
	if _, err := s.Apply(Operation{"unknown", "device-a", "song-a", "rev-000000000000000000000000", "Song A", []byte("# Song A\n")}); err == nil {
		t.Fatal("unknown base accepted")
	}
	if _, err := s.Apply(Operation{"cross", "device-a", "song-a", b.RevisionID, "Song A", []byte("# Song A\n")}); err == nil {
		t.Fatal("cross-document base accepted")
	}
	if _, err := s.Apply(Operation{"bad", "device-a", "../song-a", one.RevisionID, "Song A", []byte("# Song A\n")}); err == nil {
		t.Fatal("traversal document ID accepted")
	}
	stale := apply(t, s, "stale", "device-b", "song-a", a.RevisionID, "Song A", "# Song A\nstale\n")
	if stale.Status != "conflict" {
		t.Fatal("expected conflict")
	}
	// Reusing an Apply key for Resolve is rejected even if the body matches.
	if _, err := s.Resolve(stale.ConflictID, Operation{"same-op", "device-a", "song-a", one.RevisionID, "Song A", []byte("# Song A\nresolved\n")}); err == nil {
		t.Fatal("Apply/Resolve operation key collision accepted")
	}
}

func TestResolveCASLeavesConflictOpenAfterAdvance(t *testing.T) {
	s := newStore(t)
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	current := apply(t, s, "current", "device-a", "song-a", seed.RevisionID, "Song A", "# Song A\ncurrent\n")
	stale := apply(t, s, "stale", "device-b", "song-a", seed.RevisionID, "Song A", "# Song A\nstale\n")
	if stale.Status != "conflict" {
		t.Fatal("expected conflict")
	}
	advanced := apply(t, s, "advance", "device-a", "song-a", current.RevisionID, "Song A", "# Song A\nadvanced\n")
	before, _ := s.Counts()
	_, err := s.Resolve(stale.ConflictID, Operation{"resolve", "device-a", "song-a", current.RevisionID, "Song A", []byte("# Song A\nresolved\n")})
	if err == nil {
		t.Fatal("CAS resolution succeeded after current revision advanced")
	}
	after, _ := s.Counts()
	if before["revisions"] != after["revisions"] || before["events"] != after["events"] {
		t.Fatalf("failed CAS wrote state: before=%v after=%v", before, after)
	}
	conflict, err := s.ConflictByID(stale.ConflictID)
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Status != "open" || conflict.CurrentRevisionID != current.RevisionID {
		t.Fatalf("conflict was closed or rewritten: %#v", conflict)
	}
	if got, _ := s.CurrentRevision("song-a"); got != advanced.RevisionID {
		t.Fatal("document did not retain advanced revision")
	}
	if _, err := s.Resolve(stale.ConflictID, Operation{"nul", "device-a", "song-a", current.RevisionID, "Song A", []byte("# Song A\x00")}); err == nil {
		t.Fatal("resolve accepted NUL body")
	}
}

func TestPullAckCursorSafety(t *testing.T) {
	s := newStore(t)
	a := apply(t, s, "seed-a", "device-a", "song-a", "", "Song A", "# Song A\n")
	_ = apply(t, s, "seed-b", "device-b", "song-b", "", "Song B", "# Song B\n")
	page, err := s.Pull(0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.Cursor != a.Sequence {
		t.Fatal("unexpected pull")
	}
	if _, err := s.DeviceCursor("device-a"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Pull mutated durable cursor: %v", err)
	}
	if err := s.AckCursor("device-a", 2); err != nil {
		t.Fatal(err)
	}
	if err := s.AckCursor("device-a", 1); err != nil {
		t.Fatal(err)
	}
	if cursor, _ := s.DeviceCursor("device-a"); cursor != 2 {
		t.Fatalf("cursor regressed: %d", cursor)
	}
	if err := s.AckCursor("device-a", 3); err == nil {
		t.Fatal("future cursor accepted")
	}
	if err := s.AckCursor("../device", 1); err == nil {
		t.Fatal("traversal device accepted")
	}
}

func TestPublicationEligibilityAndSerializedCalls(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	current := apply(t, s, "current", "device-a", "song-a", seed.RevisionID, "Song A", "# Song A\ncurrent\n")
	stale := apply(t, s, "stale", "device-b", "song-a", seed.RevisionID, "Song A", "# Song A\nstale\n")
	if r, err := g.Publish(s, stale.RevisionID, Failure{}); err == nil || r.State != "ineligible" {
		t.Fatal("candidate was publishable")
	}
	if r, err := g.Publish(s, current.RevisionID, Failure{}); err == nil || r.State != "ineligible" {
		t.Fatal("current revision with open conflict was publishable")
	}
	resolved := apply(t, s, "advance", "device-a", "song-a", current.RevisionID, "Song A", "# Song A\nadvance\n")
	if r, err := g.Publish(s, current.RevisionID, Failure{}); err == nil || r.State != "ineligible" {
		t.Fatal("superseded revision was publishable")
	}
	// A fresh document has no conflicts; concurrent publication calls serialize to one commit.
	other := apply(t, s, "other", "device-a", "song-b", "", "Song B", "# Song B\n")
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := g.Publish(s, other.RevisionID, Failure{}); errs <- e }()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	count, err := g.RemoteCommitCount()
	if err != nil || count != 1 {
		t.Fatalf("publication mutex allowed duplicate commits: %d %v", count, err)
	}
	_ = resolved
}

func TestFilesystemGitTreeAndConfigSafety(t *testing.T) {
	root := t.TempDir()
	hostile := filepath.Join(root, "hostile.gitconfig")
	if err := os.WriteFile(hostile, []byte("[user]\nname = hostile\n"), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", hostile)
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	if name, err := g.gitOut("config", "user.name"); err != nil || name != "Songs V2 Sync Spike" {
		t.Fatalf("hostile global config leaked: %q %v", name, err)
	}
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	if _, err := g.Publish(s, seed.RevisionID, Failure{}); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(g.Work, "songs", "song-a.md")
	before, err := os.ReadFile(legacy)
	if err != nil {
		t.Fatal(err)
	}
	side := filepath.Join(g.Work, ".songs-v2", "documents", "song-a.json")
	if err := os.Remove(side); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, side); err != nil {
		t.Fatal(err)
	}
	if err := g.writeRevision("song-a", seed.RevisionID, "Song A", []byte("# Song A\nchanged\n")); err == nil {
		t.Fatal("symlink target accepted for materialization")
	}
	after, err := os.ReadFile(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("sidecar preflight changed legacy body")
	}
	if err := os.RemoveAll(filepath.Join(g.Work, "songs")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, filepath.Join(g.Work, "songs")); err != nil {
		t.Fatal(err)
	}
	if err := g.writeRevision("song-a", seed.RevisionID, "Song A", []byte("# Song A\n")); err == nil {
		t.Fatal("symlink component accepted for materialization")
	}
}

func TestScenarioEndToEndDeterministic(t *testing.T) {
	first, err := RunScenario(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	second, err := RunScenario(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, _ := CanonicalEvidence(first)
	b, _ := CanonicalEvidence(second)
	if string(a) != string(b) {
		t.Fatal("scenario evidence is not deterministic")
	}
	proofs := first["proofs"].(map[string]bool)
	for name, ok := range proofs {
		if !ok {
			t.Fatalf("scenario proof failed: %s", name)
		}
	}
	git := first["git"].(map[string]any)
	if !git["seed_body_byte_identical"].(bool) || !git["later_body_byte_identical"].(bool) {
		t.Fatal("body preservation proof incomplete")
	}
	if !first["recommendation"].(map[string]any)["feasible"].(bool) {
		t.Fatal("scenario not feasible")
	}
}

func TestMinimalPublicationValidationAndIntegrity(t *testing.T) {
	if err := validate("A", []byte("# A\n")); err != nil {
		t.Fatal(err)
	}
	if err := validate("A", []byte("# Different\n")); err == nil {
		t.Fatal("bad H1 accepted")
	}
	if err := validate("A", []byte("# A\x00")); err == nil {
		t.Fatal("NUL accepted")
	}
	s := newStore(t)
	ok, fk, err := s.Integrity()
	if err != nil || !ok || !fk {
		t.Fatalf("empty SQLite integrity/fk check failed: %v %v %v", ok, fk, err)
	}
}

func TestCommitCreatedRetryRebuildsOnReconciledBaseline(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	seedA := apply(t, s, "seed-a", "device-a", "song-a", "", "Song A", "# Song A\n")
	seedB := apply(t, s, "seed-b", "device-b", "song-b", "", "Song B", "# Song B\n")
	if _, err := g.Publish(s, seedA.RevisionID, Failure{}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Publish(s, seedB.RevisionID, Failure{}); err != nil {
		t.Fatal(err)
	}
	local := apply(t, s, "local", "device-a", "song-a", seedA.RevisionID, "Song A", "# Song A\nlocal\n")
	failed, err := g.Publish(s, local.RevisionID, Failure{Push: true})
	if err == nil || failed.State != "push_failed" {
		t.Fatal("expected durable commit-created push failure")
	}
	if _, err := g.ExternalEditWithSidecar("song-b", []byte("# Song B\nexternal\n")); err != nil {
		t.Fatal(err)
	}
	imports, err := g.ReconcileExternal(s)
	if err != nil {
		t.Fatal(err)
	}
	if len(imports) != 1 || imports[0].Kind != "imported" {
		t.Fatalf("expected direct reconciliation: %#v", imports)
	}
	retried, err := g.Publish(s, local.RevisionID, Failure{})
	if err != nil {
		t.Fatal(err)
	}
	if retried.Commit == failed.Commit {
		t.Fatal("stale local commit was pushed instead of rebuilt")
	}
	count, err := g.RemoteCommitCount()
	if err != nil || count != 4 {
		t.Fatalf("unexpected rebuilt remote history: %d %v", count, err)
	}
	attempts, err := s.PublicationAttempts(local.RevisionID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, attempt := range attempts {
		if attempt["detail"] == "rebuilt local commit on reconciled baseline" {
			found = true
		}
	}
	if !found {
		t.Fatal("rebuild publication attempt was not durable")
	}
}

func TestReconciliationRejectsMismatchedSidecarAndNonRegularBlob(t *testing.T) {
	setup := func(t *testing.T) (*Store, *GitMaterializer, Outcome) {
		t.Helper()
		root := t.TempDir()
		s, err := Open(filepath.Join(root, "db.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Close() })
		g, err := NewGitMaterializer(filepath.Join(root, "git"))
		if err != nil {
			t.Fatal(err)
		}
		seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
		published, err := g.Publish(s, seed.RevisionID, Failure{})
		if err != nil {
			t.Fatal(err)
		}
		if err := g.cleanTo(published.Commit); err != nil {
			t.Fatal(err)
		}
		return s, g, seed
	}
	t.Run("mismatched sidecar", func(t *testing.T) {
		s, g, seed := setup(t)
		bad := sidecar{DocumentID: "song-a", RevisionID: seed.RevisionID, Path: "songs/not-song-a.md", ContentHash: bodyHash([]byte("# Song A\n"))}
		raw, err := json.Marshal(bad)
		if err != nil {
			t.Fatal(err)
		}
		if err := writeSafe(g.Work, ".songs-v2/documents/song-a.json", append(raw, '\n')); err != nil {
			t.Fatal(err)
		}
		if err := g.git("add", ".songs-v2/documents/song-a.json"); err != nil {
			t.Fatal(err)
		}
		commit, err := g.commit("external malformed sidecar")
		if err != nil {
			t.Fatal(err)
		}
		if err := g.push(commit); err != nil {
			t.Fatal(err)
		}
		if _, err := g.ReconcileExternal(s); err == nil {
			t.Fatal("mismatched sidecar was reconciled")
		}
	})
	t.Run("non regular canonical blob", func(t *testing.T) {
		s, g, _ := setup(t)
		target := filepath.Join(g.Work, "songs", "song-a.md")
		if err := os.Remove(target); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("elsewhere.md", target); err != nil {
			t.Fatal(err)
		}
		if err := g.git("add", "-A"); err != nil {
			t.Fatal(err)
		}
		commit, err := g.commit("external symlink")
		if err != nil {
			t.Fatal(err)
		}
		if err := g.push(commit); err != nil {
			t.Fatal(err)
		}
		if _, err := g.ReconcileExternal(s); err == nil {
			t.Fatal("symlink Git blob was reconciled")
		}
	})
}

func TestForeignKeyCheckDetectsViolations(t *testing.T) {
	s := newStore(t)
	s.db.SetMaxOpenConns(1)
	if _, err := s.db.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"rev-111111111111111111111111", "rev-222222222222222222222222"} {
		if _, err := s.db.Exec(`INSERT INTO revisions(revision_id,document_id,device_id,operation_id,operation_kind,base_revision_id,title,body,content_hash,source) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, "missing-document", "device-a", "bad", "apply", "", "Missing", []byte("# Missing\n"), bodyHash([]byte("# Missing\n")), "test"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		t.Fatal(err)
	}
	integrity, foreign, err := s.Integrity()
	if err != nil || !integrity || foreign {
		t.Fatalf("foreign_key_check did not enumerate violations: integrity=%v foreign=%v err=%v", integrity, foreign, err)
	}
}

func TestPushedRetryRepairsPublicationPointersAtomically(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	published, err := g.Publish(s, seed.RevisionID, Failure{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE documents SET published_revision_id=NULL WHERE document_id='song-a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE git_state SET last_app_commit='',publication_base_commit='' WHERE singleton=1`); err != nil {
		t.Fatal(err)
	}
	repaired, err := g.Publish(s, seed.RevisionID, Failure{})
	if err != nil || !repaired.Idempotent || repaired.Commit != published.Commit {
		t.Fatalf("pushed retry did not repair: %#v %v", repaired, err)
	}
	pointer, err := s.PublishedRevision("song-a")
	if err != nil || pointer != seed.RevisionID {
		t.Fatalf("published pointer not repaired: %q %v", pointer, err)
	}
	last, base, err := s.GitState()
	if err != nil || last != published.Commit || base != published.Commit {
		t.Fatalf("git state not atomically repaired: %q %q %v", last, base, err)
	}
}

func TestNonAtomicBatchReplayDoesNotDuplicateRows(t *testing.T) {
	s := newStore(t)
	a := apply(t, s, "seed-a", "device-a", "song-a", "", "Song A", "# Song A\n")
	b := apply(t, s, "seed-b", "device-b", "song-b", "", "Song B", "# Song B\n")
	firstOps := []Operation{{"edit-a", "device-a", "song-a", a.RevisionID, "Song A", []byte("# Song A\na\n")}, {"edit-b", "device-b", "song-b", b.RevisionID, "Song B", []byte("# Song B\nb\n")}}
	first, err := s.PushBatch(firstOps)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := s.PushBatch(firstOps)
	if err != nil {
		t.Fatal(err)
	}
	if replayed[0] != first[0] || replayed[1] != first[1] {
		t.Fatalf("full replay differed: %#v %#v", first, replayed)
	}
	partial, err := s.PushBatch([]Operation{firstOps[1], {"next-a", "device-a", "song-a", first[0].RevisionID, "Song A", []byte("# Song A\nnext\n")}})
	if err != nil {
		t.Fatal(err)
	}
	if partial[0] != first[1] || partial[1].Sequence != 5 {
		t.Fatalf("partial replay duplicated rows: %#v", partial)
	}
	if _, err := s.Apply(Operation{"edit-a", "device-a", "song-a", a.RevisionID, "Song A", []byte("# Song A\ntampered\n")}); err == nil {
		t.Fatal("changed replay payload accepted")
	}
	counts, err := s.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if counts["operations"] != 5 || counts["events"] != 5 || counts["revisions"] != 5 {
		t.Fatalf("batch replay created duplicates: %#v", counts)
	}
}

func TestCommitCreatedSupersededRevisionCannotBePushed(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	if _, err := g.Publish(s, seed.RevisionID, Failure{}); err != nil {
		t.Fatal(err)
	}
	pending := apply(t, s, "pending", "device-a", "song-a", seed.RevisionID, "Song A", "# Song A\npending\n")
	if _, err := g.Publish(s, pending.RevisionID, Failure{Push: true}); err == nil {
		t.Fatal("expected push failure")
	}
	_ = apply(t, s, "advance", "device-a", "song-a", pending.RevisionID, "Song A", "# Song A\nadvance\n")
	result, err := g.Publish(s, pending.RevisionID, Failure{})
	if err == nil || result.State != "ineligible" {
		t.Fatalf("superseded commit-created revision pushed: %#v %v", result, err)
	}
	count, err := g.RemoteCommitCount()
	if err != nil || count != 1 {
		t.Fatalf("obsolete commit reached remote: %d %v", count, err)
	}
	publication, err := s.Publication(pending.RevisionID)
	if err != nil || publication.State != "commit_created" {
		t.Fatalf("durable commit state was lost: %#v %v", publication, err)
	}
}

func TestExternalImportLedgerMakesCrashRetryIdempotent(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	published, err := g.Publish(s, seed.RevisionID, Failure{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.ExternalEditWithSidecar("song-a", []byte("# Song A\nexternal\n")); err != nil {
		t.Fatal(err)
	}
	first, err := g.ReconcileExternal(s)
	if err != nil || len(first) != 1 || first[0].Kind != "imported" {
		t.Fatalf("initial external import failed: %#v %v", first, err)
	}
	counts, err := s.Counts()
	if err != nil {
		t.Fatal(err)
	}
	// Model a crash after the per-document import transaction but before the
	// remote baseline acknowledgement; the unique ledger must replay no events.
	if _, err := s.db.Exec(`UPDATE git_state SET publication_base_commit=? WHERE singleton=1`, published.Commit); err != nil {
		t.Fatal(err)
	}
	retried, err := g.ReconcileExternal(s)
	if err != nil || len(retried) != 1 || retried[0].RevisionID != first[0].RevisionID {
		t.Fatalf("retry did not return existing import: %#v %v", retried, err)
	}
	after, err := s.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if counts["events"] != after["events"] || counts["audit_events"] != after["audit_events"] || counts["external_imports"] != after["external_imports"] {
		t.Fatalf("reconciliation retry duplicated durable state: before=%v after=%v", counts, after)
	}
}

func TestRemoteAcceptedFinalizationLossRepairsWithoutSecondCommit(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	seedPub, err := g.Publish(s, seed.RevisionID, Failure{})
	if err != nil {
		t.Fatal(err)
	}
	candidate := apply(t, s, "final-loss", "device-a", "song-a", seed.RevisionID, "Song A", "# Song A\nremote accepted\n")
	before, err := g.RemoteCommitCount()
	if err != nil {
		t.Fatal(err)
	}
	lost, err := g.Publish(s, candidate.RevisionID, Failure{Finalize: true})
	if err == nil || lost.State != "finalization_lost" {
		t.Fatalf("expected finalization loss: %#v %v", lost, err)
	}
	afterPush, err := g.RemoteCommitCount()
	if err != nil || afterPush != before+1 {
		t.Fatalf("push was not real/exactly once: %d %v", afterPush, err)
	}
	intent, err := s.Publication(candidate.RevisionID)
	if err != nil || intent.State != "commit_created" || intent.ExpectedPublished != seed.RevisionID || intent.Base != seedPub.Commit {
		t.Fatalf("intent missing predecessor/base: %#v %v", intent, err)
	}
	pointer, err := s.PublishedRevision("song-a")
	if err != nil || pointer != seed.RevisionID {
		t.Fatalf("finalization loss moved pointer: %q %v", pointer, err)
	}
	repaired, err := g.Publish(s, candidate.RevisionID, Failure{})
	if err != nil || repaired.Commit != lost.Commit {
		t.Fatalf("retry did not repair remote commit: %#v %v", repaired, err)
	}
	afterRepair, err := g.RemoteCommitCount()
	if err != nil || afterRepair != afterPush {
		t.Fatalf("repair created a second commit: %d %v", afterRepair, err)
	}
	pointer, err = s.PublishedRevision("song-a")
	if err != nil || pointer != candidate.RevisionID {
		t.Fatalf("pointer not repaired: %q %v", pointer, err)
	}
	last, base, err := s.GitState()
	if err != nil || last != lost.Commit || base != lost.Commit {
		t.Fatalf("git state not repaired: %q %q %v", last, base, err)
	}
}

func TestRetryOldRemoteAcceptedPublicationAfterNewerPublicationDoesNotRewind(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	g, err := NewGitMaterializer(filepath.Join(root, "git"))
	if err != nil {
		t.Fatal(err)
	}
	seed := apply(t, s, "seed", "device-a", "song-a", "", "Song A", "# Song A\n")
	if _, err := g.Publish(s, seed.RevisionID, Failure{}); err != nil {
		t.Fatal(err)
	}
	a := apply(t, s, "a", "device-a", "song-a", seed.RevisionID, "Song A", "# Song A\nA\n")
	lost, err := g.Publish(s, a.RevisionID, Failure{Finalize: true})
	if err == nil {
		t.Fatal("expected A finalization loss")
	}
	// Simulate recovery of A's shared pointers followed by loss of only A's
	// publication-state acknowledgement, then publish newer B normally.
	head, err := g.RemoteHead()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinalizePublication(a.RevisionID, lost.Commit, head, "test_repair", "test fixture repair"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE publications SET state='commit_created' WHERE revision_id=?`, a.RevisionID); err != nil {
		t.Fatal(err)
	}
	b := apply(t, s, "b", "device-a", "song-a", a.RevisionID, "Song A", "# Song A\nB\n")
	bPub, err := g.Publish(s, b.RevisionID, Failure{})
	if err != nil {
		t.Fatal(err)
	}
	ack, err := g.Publish(s, a.RevisionID, Failure{})
	if err != nil || ack.State != "acknowledged" || !ack.Idempotent {
		t.Fatalf("old A was not acknowledged safely: %#v %v", ack, err)
	}
	pointer, err := s.PublishedRevision("song-a")
	if err != nil || pointer != b.RevisionID {
		t.Fatalf("old A rewound published pointer: %q %v", pointer, err)
	}
	last, base, err := s.GitState()
	if err != nil || last != bPub.Commit || base != bPub.Commit {
		t.Fatalf("old A rewound Git baseline: %q %q %v", last, base, err)
	}
	count, err := g.RemoteCommitCount()
	if err != nil || count != 3 {
		t.Fatalf("old A retry changed remote history: %d %v", count, err)
	}
	attempts, err := s.PublicationAttempts(a.RevisionID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, attempt := range attempts {
		if attempt["state"] == "acknowledged" {
			found = true
		}
	}
	if !found {
		t.Fatal("old A acknowledgement was not durably recorded")
	}
}
