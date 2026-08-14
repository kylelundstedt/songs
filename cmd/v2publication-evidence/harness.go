package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"songs.exe.dev/internal/v2bootstrap"
	"songs.exe.dev/internal/v2publish"
	"songs.exe.dev/internal/v2shell"
	"songs.exe.dev/internal/v2sync"
	"songs.exe.dev/srv"
)

const (
	ownerID  = "owner-main"
	deviceID = "publisher-one"
)

var fixedNow = time.Unix(1_700_000_000, 0).UTC()

type harness struct {
	root       string
	remote     string
	ledgerPath string
	lockPath   string
	workRoot   string
	store      *v2sync.Store
	publisher  *v2publish.Publisher
}

func require(ok bool, message string) error {
	if !ok {
		return errors.New(message)
	}
	return nil
}

func publishCode(err error) string {
	var coded *v2publish.CodeError
	if errors.As(err, &coded) {
		return string(coded.Code)
	}
	return ""
}

func gitEnvironment(extra ...string) []string {
	values := []string{
		"LC_ALL=C", "LANG=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never",
	}
	keys := map[string]bool{}
	for _, value := range append(values, extra...) {
		if key, _, ok := strings.Cut(value, "="); ok {
			keys[key] = true
		}
	}
	var environment []string
	for _, value := range os.Environ() {
		key, _, ok := strings.Cut(value, "=")
		if !ok || strings.HasPrefix(key, "GIT_") || keys[key] {
			continue
		}
		environment = append(environment, value)
	}
	return append(environment, append(values, extra...)...)
}

func gitOutput(directory string, args ...string) (string, error) {
	all := append([]string{}, args...)
	if directory != "" {
		all = append([]string{"-C", directory}, all...)
	}
	command := exec.Command("git", all...)
	command.Env = gitEnvironment()
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(all, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func gitRun(directory string, args ...string) error {
	_, err := gitOutput(directory, args...)
	return err
}

func writeFile(root, relative, value string) error {
	target := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, []byte(value), 0o644)
}

func initRemote(root string) (string, error) {
	remote := filepath.Join(root, "remote.git")
	seed := filepath.Join(root, "seed")
	if err := gitRun("", "init", "--quiet", "--bare", "--initial-branch=main", remote); err != nil {
		return "", err
	}
	if err := gitRun("", "init", "--quiet", "--initial-branch=main", seed); err != nil {
		return "", err
	}
	if err := gitRun(seed, "config", "user.name", "Evidence Fixture"); err != nil {
		return "", err
	}
	if err := gitRun(seed, "config", "user.email", "fixture@example.invalid"); err != nil {
		return "", err
	}
	if err := writeFile(seed, "README.md", "isolated publication fixture\n"); err != nil {
		return "", err
	}
	if err := gitRun(seed, "add", "-A"); err != nil {
		return "", err
	}
	command := exec.Command("git", "-C", seed, "commit", "--quiet", "-m", "fixture")
	command.Env = gitEnvironment("GIT_AUTHOR_DATE=2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z")
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("seed commit: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if err := gitRun(seed, "remote", "add", "origin", remote); err != nil {
		return "", err
	}
	if err := gitRun(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main"); err != nil {
		return "", err
	}
	return remote, nil
}

func newHarness(parent, name, apexPath string, hooks v2publish.Hooks) (*harness, error) {
	root := filepath.Join(parent, name)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	remote, err := initRemote(root)
	if err != nil {
		return nil, err
	}
	store, err := v2sync.Open(filepath.Join(root, "sync.sqlite"))
	if err != nil {
		return nil, err
	}
	if _, err := store.RegisterDevice(ownerID, deviceID, "registration-one", "Publication worker", strings.Repeat("a", 64)); err != nil {
		_ = store.Close()
		return nil, err
	}
	if hooks.Now == nil {
		hooks.Now = func() time.Time { return fixedNow }
	}
	result := &harness{
		root: root, remote: remote, ledgerPath: filepath.Join(root, "publication.sqlite"),
		lockPath: filepath.Join(root, "publication.lock"), workRoot: filepath.Join(root, "work"), store: store,
	}
	publisher, err := v2publish.Open(v2publish.Options{
		LedgerPath: result.ledgerPath, LockPath: result.lockPath,
		Remote: remote, WorkRoot: result.workRoot, Sync: store,
		ValidatorOptions: v2publish.ValidatorOptions{ApexPath: apexPath}, Hooks: hooks,
	})
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	result.publisher = publisher
	return result, nil
}

func (h *harness) close() error {
	var first error
	if h.publisher != nil {
		first = h.publisher.Close()
		h.publisher = nil
	}
	if h.store != nil {
		if err := h.store.Close(); first == nil {
			first = err
		}
		h.store = nil
	}
	return first
}

func applyRevision(store *v2sync.Store, operation, document, title, base string, payload v2publish.PublicationPayload) (v2sync.Outcome, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return v2sync.Outcome{}, err
	}
	digest, _, err := v2sync.HashPayload(raw)
	if err != nil {
		return v2sync.Outcome{}, err
	}
	return store.Apply(v2sync.ApplyEnvelope{
		ProtocolVersion: v2sync.ProtocolVersion, OwnerID: ownerID, DeviceID: deviceID,
		OperationID: operation, OperationKind: "replace", DocumentID: document,
		BaseRevisionID: base, Title: title, Payload: raw, PayloadSHA256: digest,
	})
}

func leadPayload(path, title, text string) v2publish.PublicationPayload {
	return v2publish.PublicationPayload{
		SchemaVersion: v2publish.PayloadSchemaVersion,
		Kind:          v2publish.LeadSheet,
		Path:          path,
		Source:        "# " + title + "\n\n" + text + "\n",
	}
}

func publishRequest(document, revision, holder string) v2publish.PublishRequest {
	return v2publish.PublishRequest{
		OwnerID: ownerID, DeviceID: deviceID, DocumentID: document,
		RevisionID: revision, Holder: holder,
	}
}

func remoteHead(remote string) (string, error) {
	return gitOutput("", "--git-dir="+remote, "rev-parse", "refs/heads/main")
}

func remoteCount(remote string) (int, error) {
	value, err := gitOutput("", "--git-dir="+remote, "rev-list", "--count", "refs/heads/main")
	if err != nil {
		return 0, err
	}
	var result int
	if _, err := fmt.Sscan(value, &result); err != nil {
		return 0, err
	}
	return result, nil
}

func commitTree(remote, commit string) (string, error) {
	return gitOutput("", "--git-dir="+remote, "rev-parse", commit+"^{tree}")
}

func externalCommit(root, remote, label string, mutate func(string) error) (string, error) {
	clone := filepath.Join(root, "external-"+label)
	if err := gitRun("", "clone", "--quiet", remote, clone); err != nil {
		return "", err
	}
	if err := gitRun(clone, "config", "user.name", "External Editor"); err != nil {
		return "", err
	}
	if err := gitRun(clone, "config", "user.email", "external@example.invalid"); err != nil {
		return "", err
	}
	if err := mutate(clone); err != nil {
		return "", err
	}
	if err := gitRun(clone, "add", "-A"); err != nil {
		return "", err
	}
	command := exec.Command("git", "-C", clone, "commit", "--quiet", "-m", "external "+label)
	command.Env = gitEnvironment("GIT_AUTHOR_DATE=2000-01-02T00:00:00Z", "GIT_COMMITTER_DATE=2000-01-02T00:00:00Z")
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("external commit: %w: %s", err, strings.TrimSpace(string(output)))
	}
	head, err := gitOutput(clone, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if err := gitRun(clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"); err != nil {
		return "", err
	}
	return head, nil
}

func mutateSidecarClaims(clone, document, path string) error {
	target := filepath.Join(clone, ".songs-v2", "documents", document+".json")
	raw, err := os.ReadFile(target)
	if err != nil {
		return err
	}
	var sidecar map[string]any
	if err := json.Unmarshal(raw, &sidecar); err != nil {
		return err
	}
	sidecar["revision_id"] = "rev-ffffffffffffffffffffffff"
	sidecar["source_sha256"] = strings.Repeat("0", 64)
	if path != "" {
		sidecar["path"] = path
	}
	changed, err := json.Marshal(sidecar)
	if err != nil {
		return err
	}
	return os.WriteFile(target, append(changed, '\n'), 0o644)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func observingApex(root, realPath string) (wrapper, marker string, err error) {
	marker = filepath.Join(root, "real-apex-invoked")
	wrapper = filepath.Join(root, "apex-observer")
	script := "#!/bin/sh\n: > " + shellQuote(marker) + "\nexec " + shellQuote(realPath) + " \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		return "", "", err
	}
	return wrapper, marker, nil
}

func failingApex(root string) (string, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(root, "apex-reject")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 9\n"), 0o700); err != nil {
		return "", err
	}
	return path, nil
}

type continuityHandlers struct {
	legacy *srv.Server
	v2     http.Handler
	api    http.Handler
}

func newContinuityHandlers(root string) (*continuityHandlers, error) {
	legacyRoot := filepath.Join(root, "legacy")
	if err := os.MkdirAll(filepath.Join(legacyRoot, "songs"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(legacyRoot, "sets"), 0o755); err != nil {
		return nil, err
	}
	if err := writeFile(legacyRoot, "songs/Legacy-Song.md", "# Legacy Song\n\nUsable during publication drills.\n"); err != nil {
		return nil, err
	}
	legacy, err := srv.New(filepath.Join(legacyRoot, "legacy.sqlite"), "continuity-fixture", legacyRoot)
	if err != nil {
		return nil, err
	}
	snapshot, err := v2bootstrap.LoadEmbedded()
	if err != nil {
		_ = legacy.DB.Close()
		return nil, err
	}
	shell, err := v2shell.LoadEmbedded(snapshot.Handler(), snapshot.ManifestSHA256())
	if err != nil {
		_ = legacy.DB.Close()
		return nil, err
	}
	return &continuityHandlers{legacy: legacy, v2: shell.Handler(), api: snapshot.Handler()}, nil
}

func (h *continuityHandlers) close() error {
	if h == nil || h.legacy == nil {
		return nil
	}
	return h.legacy.DB.Close()
}

func (h *continuityHandlers) exercise() (legacy, shell, manifest int, err error) {
	legacyRequest := httptest.NewRequest(http.MethodGet, "/song/legacy-song", nil)
	legacyRequest.SetPathValue("id", "legacy-song")
	legacyResponse := httptest.NewRecorder()
	h.legacy.HandleSong(legacyResponse, legacyRequest)

	shellRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	shellResponse := httptest.NewRecorder()
	h.v2.ServeHTTP(shellResponse, shellRequest)

	manifestRequest := httptest.NewRequest(http.MethodGet, "/api/v2/bootstrap/manifest", nil)
	manifestRequest.Header.Set("X-Forwarded-Proto", "https")
	manifestRequest.Header.Set("X-Forwarded-Host", "continuity.invalid")
	manifestRequest.Header.Set("X-ExeDev-UserID", ownerID)
	manifestResponse := httptest.NewRecorder()
	h.api.ServeHTTP(manifestResponse, manifestRequest)
	return legacyResponse.Code, shellResponse.Code, manifestResponse.Code, nil
}

func contextWithBriefTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 50*time.Millisecond)
}
