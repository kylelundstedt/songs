package syncspike

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

// GitMaterializer deliberately uses a private worktree and private bare remote.
// Its mutex serializes publication and reconciliation within this process.
type GitMaterializer struct {
	Root, Work, Remote, Template, Hooks string
	mu                                  sync.Mutex
}
type Failure struct{ Commit, Push, Finalize bool }
type PublishResult struct {
	State, Commit string
	Idempotent    bool
}
type ReconcileResult struct {
	Kind, DocumentID, RevisionID, ConflictID, SourceCommit string
	Sequence                                               int64
}

type sidecar struct {
	DocumentID  string `json:"document_id"`
	RevisionID  string `json:"revision_id"`
	Path        string `json:"path"`
	ContentHash string `json:"content_hash"`
}

func NewGitMaterializer(root string) (*GitMaterializer, error) {
	g := &GitMaterializer{Root: root, Work: filepath.Join(root, "work"), Remote: filepath.Join(root, "remote.git"), Template: filepath.Join(root, "empty-template"), Hooks: filepath.Join(root, "empty-hooks")}
	for _, path := range []string{g.Root, g.Template, g.Hooks} {
		if err := os.MkdirAll(path, 0755); err != nil {
			return nil, err
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("unsafe Git isolation directory")
		}
	}
	if err := g.runAt("", "init", "--bare", "--initial-branch=main", "--object-format=sha1", g.Remote); err != nil {
		return nil, err
	}
	if err := g.runAt("", "init", "--initial-branch=main", "--object-format=sha1", g.Work); err != nil {
		return nil, err
	}
	for _, args := range [][]string{{"config", "user.name", "Songs V2 Sync Spike"}, {"config", "user.email", "sync-spike@example.invalid"}, {"config", "commit.gpgsign", "false"}, {"config", "core.hooksPath", g.Hooks}, {"config", "core.autocrlf", "false"}, {"config", "core.attributesfile", "/dev/null"}, {"remote", "add", "origin", g.Remote}} {
		if err := g.git(args...); err != nil {
			return nil, err
		}
	}
	return g, nil
}
func (g *GitMaterializer) env(extra ...string) []string {
	base := []string{
		"LC_ALL=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_TEMPLATE_DIR=" + g.Template, "GIT_CONFIG_COUNT=3",
		"GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=" + g.Hooks,
		"GIT_CONFIG_KEY_1=core.autocrlf", "GIT_CONFIG_VALUE_1=false",
		"GIT_CONFIG_KEY_2=core.attributesfile", "GIT_CONFIG_VALUE_2=/dev/null",
	}
	return append(append(os.Environ(), base...), extra...)
}
func (g *GitMaterializer) runAt(dir string, args ...string) error {
	all := append([]string{}, args...)
	if dir != "" {
		all = append([]string{"-C", dir}, all...)
	}
	c := exec.Command("git", all...)
	c.Env = g.env()
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %w: %s", strings.Join(all, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
func (g *GitMaterializer) outputAt(dir string, args ...string) (string, error) {
	all := append([]string{}, args...)
	if dir != "" {
		all = append([]string{"-C", dir}, all...)
	}
	c := exec.Command("git", all...)
	c.Env = g.env()
	out, err := c.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(all, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
func (g *GitMaterializer) bytesAt(dir string, args ...string) ([]byte, error) {
	all := append([]string{}, args...)
	if dir != "" {
		all = append([]string{"-C", dir}, all...)
	}
	c := exec.Command("git", all...)
	c.Env = g.env()
	out, err := c.Output()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w", strings.Join(all, " "), err)
	}
	return out, nil
}
func (g *GitMaterializer) git(args ...string) error              { return g.runAt(g.Work, args...) }
func (g *GitMaterializer) gitOut(args ...string) (string, error) { return g.outputAt(g.Work, args...) }
func (g *GitMaterializer) hasRemoteHead() bool {
	_, err := g.gitOut("rev-parse", "--verify", "origin/main")
	return err == nil
}
func (g *GitMaterializer) fetch() error { return g.git("fetch", "--quiet", "origin") }
func (g *GitMaterializer) remoteHead() (string, error) {
	if err := g.fetch(); err != nil {
		return "", err
	}
	if !g.hasRemoteHead() {
		return "", nil
	}
	return g.gitOut("rev-parse", "origin/main")
}
func (g *GitMaterializer) cleanTo(head string) error {
	if head != "" {
		if err := g.git("reset", "--hard", head); err != nil {
			return err
		}
	}
	return g.git("clean", "-fd")
}
func (g *GitMaterializer) commit(message string) (string, error) {
	c := exec.Command("git", "-C", g.Work, "commit", "--quiet", "-m", message)
	c.Env = g.env("GIT_AUTHOR_NAME=Songs V2 Sync Spike", "GIT_AUTHOR_EMAIL=sync-spike@example.invalid", "GIT_COMMITTER_NAME=Songs V2 Sync Spike", "GIT_COMMITTER_EMAIL=sync-spike@example.invalid", "GIT_AUTHOR_DATE=2001-02-03T04:05:06+0000", "GIT_COMMITTER_DATE=2001-02-03T04:05:06+0000")
	out, err := c.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git commit: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return g.gitOut("rev-parse", "HEAD")
}
func validate(title string, body []byte) error {
	if !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 {
		return errors.New("body must be valid UTF-8 without NUL")
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, "# ") {
			if strings.TrimSpace(strings.TrimPrefix(line, "# ")) != title {
				return errors.New("H1 title does not match revision title")
			}
			return nil
		}
	}
	return errors.New("H1 is required")
}
func ensureSafeDir(root, rel string) error {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe worktree root")
	}
	current := root
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return errors.New("unsafe path component")
		}
		current = filepath.Join(current, part)
		info, err = os.Lstat(current)
		if os.IsNotExist(err) {
			if err = os.Mkdir(current, 0755); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("non-directory or symlink path component")
		}
	}
	return nil
}
func safeTarget(root, rel string) (string, error) {
	parts := strings.Split(rel, "/")
	if len(parts) < 2 {
		return "", errors.New("unsafe target path")
	}
	if err := ensureSafeDir(root, strings.Join(parts[:len(parts)-1], "/")); err != nil {
		return "", err
	}
	target := filepath.Join(append([]string{root}, parts...)...)
	if info, err := os.Lstat(target); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("target is not a regular file")
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return target, nil
}
func writeSafe(root, rel string, body []byte) error {
	target, err := safeTarget(root, rel)
	if err != nil {
		return err
	}
	return os.WriteFile(target, body, 0644)
}
func (g *GitMaterializer) writeRevision(doc, rev, title string, body []byte) error {
	if !validStableID(doc) || !revisionIDRE.MatchString(rev) {
		return errors.New("invalid identity for materialization")
	}
	if err := validate(title, body); err != nil {
		return err
	}
	path, err := docPath(doc)
	if err != nil {
		return err
	}
	manifest := sidecar{DocumentID: doc, RevisionID: rev, Path: path, ContentHash: bodyHash(body)}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	// Preflight both targets before changing either legacy body or sidecar.
	bodyTarget, err := safeTarget(g.Work, path)
	if err != nil {
		return err
	}
	sideTarget, err := safeTarget(g.Work, ".songs-v2/documents/"+doc+".json")
	if err != nil {
		return err
	}
	if err := os.WriteFile(bodyTarget, body, 0644); err != nil {
		return err
	}
	return os.WriteFile(sideTarget, append(raw, '\n'), 0644)
}
func (g *GitMaterializer) push(commit string) error {
	return g.git("push", "--quiet", "origin", commit+":refs/heads/main")
}
func (g *GitMaterializer) isAncestor(ancestor, descendant string) (bool, error) {
	if ancestor == "" {
		return descendant != "", nil
	}
	c := exec.Command("git", "-C", g.Work, "merge-base", "--is-ancestor", ancestor, descendant)
	c.Env = g.env()
	err := c.Run()
	if err == nil {
		return true, nil
	}
	if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
		return false, nil
	}
	return false, err
}
func (g *GitMaterializer) commitParent(commit string) (string, error) {
	line, err := g.gitOut("rev-list", "--parents", "-n", "1", commit)
	if err != nil {
		return "", err
	}
	parts := strings.Fields(line)
	if len(parts) == 1 {
		return "", nil
	}
	if len(parts) == 2 {
		return parts[1], nil
	}
	return "", errors.New("commit has unexpected parent count")
}
func (g *GitMaterializer) baseIsCurrent(s *Store) (string, string, error) {
	head, err := g.remoteHead()
	if err != nil {
		return "", "", err
	}
	_, base, err := s.GitState()
	if err != nil {
		return "", "", err
	}
	if head != base {
		return head, base, errors.New("remote head drift requires reconciliation before publication")
	}
	return head, base, nil
}
func (g *GitMaterializer) recordIneligible(s *Store, rev, detail string) error {
	_, base, err := s.GitState()
	if err != nil {
		return err
	}
	expected, err := s.ExpectedPublishedRevision(rev)
	if err != nil {
		return err
	}
	return s.RecordPublication(rev, "ineligible", "terminal", "", base, expected, detail)
}
func (g *GitMaterializer) makeAndPush(s *Store, rev string, r RevisionInfo, base, expected string, failure Failure, rebuilt bool) (PublishResult, error) {
	if err := g.cleanTo(base); err != nil {
		return PublishResult{}, err
	}
	if err := g.writeRevision(r.DocumentID, rev, r.Title, r.Body); err != nil {
		return PublishResult{}, err
	}
	path, pathErr := docPath(r.DocumentID)
	if pathErr != nil {
		return PublishResult{}, pathErr
	}
	if err := g.git("add", path, ".songs-v2/documents/"+r.DocumentID+".json"); err != nil {
		return PublishResult{}, err
	}
	if failure.Commit {
		if err := s.RecordPublication(rev, "commit_failed", "retryable", "", base, expected, "injected commit failure"); err != nil {
			return PublishResult{}, err
		}
		return PublishResult{State: "commit_failed"}, errors.New("injected commit failure")
	}
	commit, err := g.commit("sync-spike: publish " + rev)
	if err != nil {
		if recordErr := s.RecordPublication(rev, "commit_failed", "retryable", "", base, expected, err.Error()); recordErr != nil {
			return PublishResult{}, recordErr
		}
		return PublishResult{}, err
	}
	detail := "local commit durable before push"
	if rebuilt {
		detail = "rebuilt local commit on reconciled baseline"
	}
	if err := s.RecordPublication(rev, "commit_created", "retryable", commit, base, expected, detail); err != nil {
		return PublishResult{}, err
	}
	return g.pushAndFinalize(s, rev, commit, base, failure)
}
func (g *GitMaterializer) pushAndFinalize(s *Store, rev, commit, base string, failure Failure) (PublishResult, error) {
	if failure.Push {
		if err := s.AddPublicationAttempt(rev, "push_failed", "retryable", commit, base, "injected push failure"); err != nil {
			return PublishResult{}, err
		}
		return PublishResult{State: "push_failed", Commit: commit}, errors.New("injected push failure")
	}
	if err := g.push(commit); err != nil {
		if recordErr := s.AddPublicationAttempt(rev, "push_failed", "retryable", commit, base, err.Error()); recordErr != nil {
			return PublishResult{}, recordErr
		}
		return PublishResult{State: "push_failed", Commit: commit}, err
	}
	// The commit is genuinely accepted by the isolated remote before the
	// finalization-loss injection is recorded.
	head, err := g.remoteHead()
	if err != nil {
		return PublishResult{}, err
	}
	if failure.Finalize {
		if err := s.AddPublicationAttempt(rev, "finalization_lost", "retryable", commit, base, "remote accepted; injected SQLite finalization loss"); err != nil {
			return PublishResult{}, err
		}
		return PublishResult{State: "finalization_lost", Commit: commit}, errors.New("injected SQLite finalization loss")
	}
	if _, err := s.FinalizePublication(rev, commit, head, "pushed", "remote accepted"); err != nil {
		return PublishResult{}, err
	}
	return PublishResult{State: "pushed", Commit: commit}, nil
}
func (g *GitMaterializer) repairPushed(s *Store, rev string, p Publication) (PublishResult, error) {
	head, err := g.remoteHead()
	if err != nil {
		return PublishResult{}, err
	}
	contained, err := g.isAncestor(p.Commit, head)
	if err != nil {
		return PublishResult{}, err
	}
	if !contained {
		if err := s.RecordPublication(rev, "remote_drift", "retryable", p.Commit, p.Base, p.ExpectedPublished, "recorded remote-accepted commit is absent from remote head"); err != nil {
			return PublishResult{}, err
		}
		return PublishResult{State: "remote_drift", Commit: p.Commit}, errors.New("published commit absent from remote")
	}
	attemptState := "pushed"
	detail := "repaired remote-accepted publication finalization"
	if p.State == "pushed" {
		attemptState = "idempotent"
		detail = "verified/acknowledged existing remote publication"
	}
	if head != p.Commit {
		attemptState = "acknowledged"
		detail = "acknowledged remote ancestor without rewinding newer pointer or baseline"
	}
	if _, err := s.FinalizePublication(rev, p.Commit, head, attemptState, detail); err != nil {
		return PublishResult{}, err
	}
	if attemptState == "acknowledged" {
		return PublishResult{State: "acknowledged", Commit: p.Commit, Idempotent: true}, nil
	}
	return PublishResult{State: "pushed", Commit: p.Commit, Idempotent: p.State == "pushed"}, nil
}
func (g *GitMaterializer) resumeCommit(s *Store, rev string, p Publication, failure Failure) (PublishResult, error) {
	head, err := g.remoteHead()
	if err != nil {
		return PublishResult{}, err
	}
	contained, err := g.isAncestor(p.Commit, head)
	if err != nil {
		return PublishResult{}, err
	}
	if contained {
		// The remote already has this immutable commit, so repair its durable
		// acknowledgement even if a later local revision is now current.
		return g.repairPushed(s, rev, p)
	}
	r, err := s.PublicationEligibility(rev)
	if err != nil {
		if recordErr := s.AddPublicationAttempt(rev, "ineligible", "terminal", p.Commit, p.Base, err.Error()); recordErr != nil {
			return PublishResult{}, recordErr
		}
		return PublishResult{State: "ineligible", Commit: p.Commit}, err
	}
	if err := validate(r.Title, r.Body); err != nil {
		return PublishResult{}, err
	}
	_, knownBase, err := s.GitState()
	if err != nil {
		return PublishResult{}, err
	}
	parent, err := g.commitParent(p.Commit)
	if err != nil {
		return PublishResult{}, err
	}
	if head != p.Base || parent != p.Base {
		if head != knownBase {
			if err := s.AddPublicationAttempt(rev, "remote_drift", "retryable", p.Commit, p.Base, "commit_created retry requires reconciliation"); err != nil {
				return PublishResult{}, err
			}
			return PublishResult{State: "remote_drift", Commit: p.Commit}, errors.New("stale local commit requires reconciliation")
		}
		return g.makeAndPush(s, rev, r, head, p.ExpectedPublished, failure, true)
	}
	return g.pushAndFinalize(s, rev, p.Commit, p.Base, failure)
}

func (g *GitMaterializer) Publish(s *Store, rev string, failure Failure) (PublishResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !revisionIDRE.MatchString(rev) {
		return PublishResult{}, errors.New("invalid revision ID")
	}
	p, err := s.Publication(rev)
	if err != nil && !sqlErrNoRows(err) {
		return PublishResult{}, err
	}
	if p.State == "pushed" {
		return g.repairPushed(s, rev, p)
	}
	if p.State == "commit_created" {
		return g.resumeCommit(s, rev, p, failure)
	}
	r, err := s.PublicationEligibility(rev)
	if err != nil {
		if recordErr := g.recordIneligible(s, rev, err.Error()); recordErr != nil {
			return PublishResult{}, recordErr
		}
		return PublishResult{State: "ineligible"}, err
	}
	if err := validate(r.Title, r.Body); err != nil {
		_, base, stateErr := s.GitState()
		if stateErr != nil {
			return PublishResult{}, stateErr
		}
		expected, stateErr := s.ExpectedPublishedRevision(rev)
		if stateErr != nil {
			return PublishResult{}, stateErr
		}
		if recordErr := s.RecordPublication(rev, "validation_failed", "terminal", "", base, expected, err.Error()); recordErr != nil {
			return PublishResult{}, recordErr
		}
		return PublishResult{State: "validation_failed"}, err
	}
	expected, err := s.ExpectedPublishedRevision(rev)
	if err != nil {
		return PublishResult{}, err
	}
	head, base, err := g.baseIsCurrent(s)
	if err != nil {
		if recordErr := s.RecordPublication(rev, "remote_drift", "retryable", "", base, expected, err.Error()); recordErr != nil {
			return PublishResult{}, recordErr
		}
		return PublishResult{State: "remote_drift"}, err
	}
	return g.makeAndPush(s, rev, r, head, expected, failure, false)
}
func sqlErrNoRows(err error) bool { return err == sql.ErrNoRows }
func (g *GitMaterializer) RemoteHead() (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	head, err := g.remoteHead()
	return head, err
}
func (g *GitMaterializer) RemoteCommitCount() (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	x, err := g.outputAt("", "--git-dir="+g.Remote, "rev-list", "--count", "refs/heads/main")
	if err != nil {
		return 0, err
	}
	var n int
	_, err = fmt.Sscanf(x, "%d", &n)
	return n, err
}
func (g *GitMaterializer) treeBlob(commit, path string) ([]byte, error) {
	entry, err := g.gitOut("ls-tree", commit, "--", path)
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(entry)
	if len(fields) < 3 || !strings.HasPrefix(fields[0], "100") || fields[1] != "blob" {
		return nil, errors.New("Git tree entry is not a regular blob")
	}
	return g.bytesAt(g.Work, "show", commit+":"+path)
}

func isHexDigest(v string) bool {
	if len(v) != 64 {
		return false
	}
	for _, r := range v {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// SafetyProof verifies the enforced per-repository controls without reporting paths.
func (g *GitMaterializer) SafetyProof() (bool, error) {
	format, err := g.gitOut("rev-parse", "--show-object-format")
	if err != nil {
		return false, err
	}
	hooks, err := g.gitOut("config", "core.hooksPath")
	if err != nil {
		return false, err
	}
	crlf, err := g.gitOut("config", "core.autocrlf")
	if err != nil {
		return false, err
	}
	return format == "sha1" && hooks == g.Hooks && crlf == "false", nil
}

// ExternalEdit changes a canonical blob in a real separate clone of this
// spike's bare remote. ExternalEditWithSidecar additionally changes sidecar
// claims so reconciliation proves body comparison does not trust them.
func (g *GitMaterializer) ExternalEdit(doc string, body []byte) (string, error) {
	return g.externalEdit(doc, body, false)
}
func (g *GitMaterializer) ExternalEditWithSidecar(doc string, body []byte) (string, error) {
	return g.externalEdit(doc, body, true)
}
func (g *GitMaterializer) externalEdit(doc string, body []byte, mutateSidecar bool) (string, error) {
	if !validStableID(doc) {
		return "", errors.New("invalid external document ID")
	}
	path, err := docPath(doc)
	if err != nil {
		return "", err
	}
	clone := filepath.Join(g.Root, "external-clone-"+hash(doc, bodyHash(body), fmt.Sprint(mutateSidecar))[:12])
	if err := g.runAt("", "clone", "--quiet", g.Remote, clone); err != nil {
		return "", err
	}
	if err := g.runAt(clone, "config", "user.name", "External Editor"); err != nil {
		return "", err
	}
	if err := g.runAt(clone, "config", "user.email", "external@example.invalid"); err != nil {
		return "", err
	}
	if err := writeSafe(clone, path, body); err != nil {
		return "", err
	}
	if mutateSidecar {
		raw, err := g.bytesAt(clone, "show", "HEAD:.songs-v2/documents/"+doc+".json")
		if err != nil {
			return "", err
		}
		var manifest sidecar
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return "", err
		}
		manifest.RevisionID = "rev-" + hash("external-sidecar", doc, bodyHash(body))[:24]
		manifest.ContentHash = hash("untrusted-sidecar", doc)[:64]
		changed, err := json.Marshal(manifest)
		if err != nil {
			return "", err
		}
		if err := writeSafe(clone, ".songs-v2/documents/"+doc+".json", append(changed, '\n')); err != nil {
			return "", err
		}
		if err := g.runAt(clone, "add", path, ".songs-v2/documents/"+doc+".json"); err != nil {
			return "", err
		}
	} else if err := g.runAt(clone, "add", path); err != nil {
		return "", err
	}
	c := exec.Command("git", "-C", clone, "commit", "--quiet", "-m", "external: edit "+doc)
	c.Env = g.env("GIT_AUTHOR_NAME=External Editor", "GIT_AUTHOR_EMAIL=external@example.invalid", "GIT_COMMITTER_NAME=External Editor", "GIT_COMMITTER_EMAIL=external@example.invalid", "GIT_AUTHOR_DATE=2001-02-03T04:05:07+0000", "GIT_COMMITTER_DATE=2001-02-03T04:05:07+0000")
	out, err := c.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("external commit: %w: %s", err, strings.TrimSpace(string(out)))
	}
	commit, err := g.outputAt(clone, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if err := g.runAt(clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"); err != nil {
		return "", err
	}
	return commit, nil
}
func (g *GitMaterializer) ReconcileExternal(s *Store) ([]ReconcileResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	head, err := g.remoteHead()
	if err != nil {
		return nil, err
	}
	if head == "" {
		return nil, nil
	}
	_, base, err := s.GitState()
	if err != nil {
		return nil, err
	}
	if head == base {
		return nil, nil
	}
	actor, err := g.gitOut("show", "-s", "--format=%an", head)
	if err != nil {
		return nil, err
	}
	names, err := g.gitOut("ls-tree", "-r", "--name-only", head, ".songs-v2/documents")
	if err != nil {
		return nil, err
	}
	var results []ReconcileResult
	for _, name := range strings.Fields(names) {
		prefix := ".songs-v2/documents/"
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".json") {
			return nil, errors.New("invalid sidecar tree path")
		}
		filename := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".json")
		if !validStableID(filename) || strings.Contains(filename, "/") {
			return nil, errors.New("invalid sidecar filename")
		}
		raw, err := g.treeBlob(head, name)
		if err != nil {
			return nil, err
		}
		var manifest sidecar
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return nil, err
		}
		if !validStableID(manifest.DocumentID) || manifest.DocumentID != filename || !revisionIDRE.MatchString(manifest.RevisionID) || !isHexDigest(manifest.ContentHash) {
			return nil, errors.New("invalid sidecar identity")
		}
		expected, err := docPath(manifest.DocumentID)
		if err != nil {
			return nil, err
		}
		if manifest.Path != expected {
			return nil, errors.New("sidecar path does not match document")
		}
		body, err := g.treeBlob(head, expected)
		if err != nil {
			return nil, err
		}
		r, err := s.RevisionForDocumentPublished(manifest.DocumentID)
		if err != nil {
			return nil, err
		}
		if err := validate(r.Title, body); err != nil {
			return nil, fmt.Errorf("external %s failed validation: %w", expected, err)
		}
		imported, err := s.importExternalLocked(head, actor, manifest.DocumentID, r.Title, body)
		if err != nil {
			return nil, err
		}
		if imported.Kind != "unchanged" {
			results = append(results, ReconcileResult{Kind: imported.Kind, DocumentID: imported.DocumentID, RevisionID: imported.RevisionID, ConflictID: imported.ConflictID, SourceCommit: imported.SourceCommit, Sequence: imported.Sequence})
		}
	}
	if err := s.MarkReconciledBase(head); err != nil {
		return nil, err
	}
	return results, nil
}
