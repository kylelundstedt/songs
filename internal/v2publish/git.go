package v2publish

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type materializerOptions struct {
	Remote      string
	Branch      string
	WorkRoot    string
	AuthorName  string
	AuthorEmail string
}

type gitMaterializer struct {
	remote, branch, root, template, hooks string
	authorName, authorEmail               string
}

type identitySidecar struct {
	SchemaVersion string       `json:"schema_version"`
	OwnerID       string       `json:"owner_id"`
	DocumentID    string       `json:"document_id"`
	Kind          DocumentKind `json:"kind"`
	Path          string       `json:"path"`
	RevisionID    string       `json:"revision_id"`
	SourceSHA256  string       `json:"source_sha256"`
	Deleted       bool         `json:"deleted"`
}

func newGitMaterializer(options materializerOptions) (*gitMaterializer, error) {
	if options.Remote == "" || options.WorkRoot == "" {
		return nil, codeError(CodeInvalidConfig, "Git remote and isolated work root are required", nil)
	}
	branch := options.Branch
	if branch == "" {
		branch = DefaultBranch
	}
	if !branchRefRE.MatchString(branch) || strings.Contains(branch, "..") || strings.Contains(branch, "//") || strings.HasSuffix(branch, ".") {
		return nil, codeError(CodeInvalidConfig, "unsafe Git branch ref", nil)
	}
	root, err := filepath.Abs(options.WorkRoot)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	if err := requireRealDirectory(root); err != nil {
		return nil, err
	}
	materializer := &gitMaterializer{
		remote: options.Remote, branch: branch, root: root,
		template: filepath.Join(root, "empty-template"), hooks: filepath.Join(root, "empty-hooks"),
		authorName: options.AuthorName, authorEmail: options.AuthorEmail,
	}
	if materializer.authorName == "" {
		materializer.authorName = "Songs V2 Publisher"
	}
	if materializer.authorEmail == "" {
		materializer.authorEmail = "v2-publisher@example.invalid"
	}
	for _, directory := range []string{materializer.template, materializer.hooks, filepath.Join(root, "intents"), filepath.Join(root, "checks")} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, err
		}
		if err := requireRealDirectory(directory); err != nil {
			return nil, err
		}
	}
	return materializer, nil
}

func requireRealDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return codeError(CodeInvalidConfig, "Git isolation path is not a real directory", nil)
	}
	return nil
}

func sanitizedGitEnvironment(overrides ...string) []string {
	overrideKeys := make(map[string]bool, len(overrides))
	for _, entry := range overrides {
		if key, _, ok := strings.Cut(entry, "="); ok {
			overrideKeys[key] = true
		}
	}
	result := make([]string, 0, len(os.Environ())+len(overrides))
	for _, entry := range os.Environ() {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || overrideKeys[key] || strings.HasPrefix(key, "GIT_") {
			continue
		}
		result = append(result, entry)
	}
	return append(result, overrides...)
}

func (g *gitMaterializer) env(extra ...string) []string {
	base := []string{
		"LC_ALL=C", "LANG=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "GIT_ASKPASS=/bin/false",
		"GIT_TEMPLATE_DIR=" + g.template,
		"GIT_CONFIG_COUNT=4",
		"GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=" + g.hooks,
		"GIT_CONFIG_KEY_1=core.autocrlf", "GIT_CONFIG_VALUE_1=false",
		"GIT_CONFIG_KEY_2=core.attributesfile", "GIT_CONFIG_VALUE_2=/dev/null",
		"GIT_CONFIG_KEY_3=commit.gpgsign", "GIT_CONFIG_VALUE_3=false",
	}
	return sanitizedGitEnvironment(append(base, extra...)...)
}

func (g *gitMaterializer) command(ctx context.Context, directory string, stdin io.Reader, args ...string) ([]byte, error) {
	all := append([]string{}, args...)
	if directory != "" {
		all = append([]string{"-C", directory}, all...)
	}
	command := exec.CommandContext(ctx, "git", all...)
	command.Env = g.env()
	command.Stdin = stdin
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(all, " "), err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func (g *gitMaterializer) run(ctx context.Context, directory string, args ...string) error {
	_, err := g.command(ctx, directory, nil, args...)
	return err
}

func (g *gitMaterializer) output(ctx context.Context, directory string, args ...string) (string, error) {
	output, err := g.command(ctx, directory, nil, args...)
	return strings.TrimSpace(string(output)), err
}

func (g *gitMaterializer) RemoteHead(ctx context.Context) (string, error) {
	output, err := g.output(ctx, "", "ls-remote", "--refs", g.remote, g.branch)
	if err != nil {
		return "", err
	}
	if output == "" {
		return "", nil
	}
	lines := strings.Split(output, "\n")
	if len(lines) != 1 {
		return "", codeError(CodeUnsupportedGitState, "remote branch resolved to multiple refs", nil)
	}
	fields := strings.Fields(lines[0])
	if len(fields) != 2 || fields[1] != g.branch || !validGitHash(fields[0]) {
		return "", codeError(CodeUnsupportedGitState, "remote branch has an invalid object ID", nil)
	}
	return fields[0], nil
}

func (g *gitMaterializer) resetDirectory(directory string) error {
	cleanRoot := filepath.Clean(g.root) + string(os.PathSeparator)
	cleanDirectory := filepath.Clean(directory)
	if !strings.HasPrefix(cleanDirectory+string(os.PathSeparator), cleanRoot) || cleanDirectory == filepath.Clean(g.root) {
		return codeError(CodeInvalidConfig, "refusing to reset path outside isolated Git root", nil)
	}
	if err := os.RemoveAll(cleanDirectory); err != nil {
		return err
	}
	return os.MkdirAll(cleanDirectory, 0o700)
}

func (g *gitMaterializer) initializeRepository(ctx context.Context, directory, base string) error {
	if err := g.resetDirectory(directory); err != nil {
		return err
	}
	branchName := strings.TrimPrefix(g.branch, "refs/heads/")
	if err := g.run(ctx, "", "init", "--quiet", "--initial-branch="+branchName, directory); err != nil {
		return err
	}
	if err := g.run(ctx, directory, "config", "user.name", g.authorName); err != nil {
		return err
	}
	if err := g.run(ctx, directory, "config", "user.email", g.authorEmail); err != nil {
		return err
	}
	if base == "" {
		return nil
	}
	if !validGitHash(base) {
		return codeError(CodeUnsupportedGitState, "invalid expected Git base", nil)
	}
	if err := g.run(ctx, directory, "fetch", "--quiet", "--no-tags", g.remote, base); err != nil {
		return err
	}
	return g.run(ctx, directory, "checkout", "--quiet", "--detach", base)
}

func sidecarPath(documentID string) string {
	return ".songs-v2/documents/" + documentID + ".json"
}

func safeTarget(root, relative string, createParents bool) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || filepath.ToSlash(filepath.Clean(relative)) != relative || strings.Contains(relative, "\\") {
		return "", codeError(CodeInvalidPayload, "unsafe materialization path", nil)
	}
	parts := strings.Split(relative, "/")
	current := root
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", codeError(CodeInvalidPayload, "unsafe materialization path component", nil)
		}
		current = filepath.Join(current, part)
		if index == len(parts)-1 {
			break
		}
		info, err := os.Lstat(current)
		if os.IsNotExist(err) && createParents {
			if err := os.Mkdir(current, 0o755); err != nil {
				return "", err
			}
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", codeError(CodeInvalidPayload, "materialization path crosses a symlink or non-directory", nil)
		}
	}
	if info, err := os.Lstat(current); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", codeError(CodeInvalidPayload, "materialization target is not a regular file", nil)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return current, nil
}

func safeWrite(root, relative string, source []byte) error {
	target, err := safeTarget(root, relative, true)
	if err != nil {
		return err
	}
	return os.WriteFile(target, source, 0o644)
}

func safeRemove(root, relative string) error {
	target, err := safeTarget(root, relative, false)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Materialize creates a disposable private repository rooted at the intent's
// exact expected base and changes only the canonical body and identity sidecar.
func (g *gitMaterializer) Materialize(ctx context.Context, intent Intent, prior *PublishedDocument) (string, error) {
	directory := filepath.Join(g.root, "intents", intent.ID)
	if err := g.initializeRepository(ctx, directory, intent.ExpectedGitBase); err != nil {
		return "", err
	}
	if prior == nil {
		if intent.Payload.Deleted {
			return "", codeError(CodeIneligible, "cannot publish a deletion without a durable prior publication", nil)
		}
		for _, occupied := range []string{intent.Payload.Path, sidecarPath(intent.DocumentID)} {
			if _, err := os.Lstat(filepath.Join(directory, filepath.FromSlash(occupied))); err == nil {
				return "", codeError(CodeIneligible, "refusing to overwrite an unowned canonical Git path", nil)
			} else if !os.IsNotExist(err) {
				return "", err
			}
		}
	}
	if prior != nil && prior.Path != intent.Payload.Path {
		if err := safeRemove(directory, prior.Path); err != nil {
			return "", err
		}
	}
	if intent.Payload.Deleted {
		if err := safeRemove(directory, intent.Payload.Path); err != nil {
			return "", err
		}
	} else if err := safeWrite(directory, intent.Payload.Path, []byte(intent.Payload.Source)); err != nil {
		return "", err
	}
	sidecar := identitySidecar{
		SchemaVersion: SidecarSchemaVersion,
		OwnerID:       intent.OwnerID,
		DocumentID:    intent.DocumentID,
		Kind:          intent.Payload.Kind,
		Path:          intent.Payload.Path,
		RevisionID:    intent.RevisionID,
		SourceSHA256:  intent.SourceSHA256,
		Deleted:       intent.Payload.Deleted,
	}
	raw, err := json.Marshal(sidecar)
	if err != nil {
		return "", err
	}
	if err := safeWrite(directory, sidecarPath(intent.DocumentID), append(raw, '\n')); err != nil {
		return "", err
	}
	return directory, nil
}

func (g *gitMaterializer) DeterministicCommit(ctx context.Context, directory string, intent Intent) (string, error) {
	if err := g.run(ctx, directory, "add", "-A"); err != nil {
		return "", err
	}
	tree, err := g.output(ctx, directory, "write-tree")
	if err != nil {
		return "", err
	}
	if !validGitHash(tree) {
		return "", codeError(CodeUnsupportedGitState, "git write-tree returned an invalid object ID", nil)
	}
	args := []string{"commit-tree", tree}
	if intent.ExpectedGitBase != "" {
		args = append(args, "-p", intent.ExpectedGitBase)
	}
	message := "v2publish: " + intent.DocumentID + " " + intent.RevisionID + "\n"
	date := time.Unix(intent.CommitUnix, 0).UTC().Format(time.RFC3339)
	command := exec.CommandContext(ctx, "git", append([]string{"-C", directory}, args...)...)
	command.Env = g.env(
		"GIT_AUTHOR_NAME="+g.authorName, "GIT_AUTHOR_EMAIL="+g.authorEmail,
		"GIT_COMMITTER_NAME="+g.authorName, "GIT_COMMITTER_EMAIL="+g.authorEmail,
		"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date,
	)
	command.Stdin = strings.NewReader(message)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git commit-tree: %w: %s", err, strings.TrimSpace(string(output)))
	}
	commit := strings.TrimSpace(string(output))
	if !validGitHash(commit) {
		return "", codeError(CodeUnsupportedGitState, "git commit-tree returned an invalid object ID", nil)
	}
	return commit, nil
}

// PushCAS updates the configured branch only when its current value still
// equals expectedBase. force-with-lease provides the server-side race check;
// it is not used to bypass history.
func (g *gitMaterializer) PushCAS(ctx context.Context, directory, commit, expectedBase string) error {
	if !validGitHash(commit) || expectedBase != "" && !validGitHash(expectedBase) {
		return codeError(CodeUnsupportedGitState, "invalid commit/base for CAS push", nil)
	}
	lease := "--force-with-lease=" + g.branch + ":" + expectedBase
	_, err := g.command(ctx, directory, nil, "push", "--quiet", lease, g.remote, commit+":"+g.branch)
	if err != nil {
		return codeError(CodeCASFailed, "Git compare-and-swap push rejected", err)
	}
	return nil
}

func (g *gitMaterializer) checkRepository(ctx context.Context, name string) (string, error) {
	directory := filepath.Join(g.root, "checks", name)
	if err := g.initializeRepository(ctx, directory, ""); err != nil {
		return "", err
	}
	return directory, nil
}

func (g *gitMaterializer) IsRemoteAncestor(ctx context.Context, commit, head string) (bool, error) {
	if commit == "" || head == "" {
		return false, nil
	}
	if !validGitHash(commit) || !validGitHash(head) {
		return false, codeError(CodeUnsupportedGitState, "invalid object ID for ancestry check", nil)
	}
	directory, err := g.checkRepository(ctx, "ancestry")
	if err != nil {
		return false, err
	}
	if err := g.run(ctx, directory, "fetch", "--quiet", "--no-tags", g.remote, head+":refs/check/head"); err != nil {
		return false, err
	}
	present := exec.CommandContext(ctx, "git", "-C", directory, "cat-file", "-e", commit+"^{commit}")
	present.Env = g.env()
	if err := present.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return false, nil
		}
		return false, err
	}
	command := exec.CommandContext(ctx, "git", "-C", directory, "merge-base", "--is-ancestor", commit, head)
	command.Env = g.env()
	err = command.Run()
	if err == nil {
		return true, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return false, nil
	}
	return false, err
}

func (g *gitMaterializer) Checkout(ctx context.Context, name, commit string) (string, error) {
	if !validGitHash(commit) {
		return "", codeError(CodeUnsupportedGitState, "invalid checkout commit", nil)
	}
	directory := filepath.Join(g.root, "checks", name)
	if err := g.initializeRepository(ctx, directory, commit); err != nil {
		return "", err
	}
	return directory, nil
}

func (g *gitMaterializer) TreeBlob(ctx context.Context, repository, commit, relative string) ([]byte, bool, error) {
	if relative == "" || strings.Contains(relative, "\\") || filepath.ToSlash(filepath.Clean(relative)) != relative {
		return nil, false, codeError(CodeInvalidPayload, "unsafe Git tree path", nil)
	}
	command := exec.CommandContext(ctx, "git", "-C", repository, "cat-file", "-e", commit+":"+relative)
	command.Env = g.env()
	if err := command.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, false, nil
		}
		return nil, false, err
	}
	output, err := g.command(ctx, repository, nil, "show", commit+":"+relative)
	return output, err == nil, err
}

func (g *gitMaterializer) RenameMap(ctx context.Context, repository, base, head string) (map[string]string, error) {
	result := map[string]string{}
	if base == "" || base == head {
		return result, nil
	}
	output, err := g.command(ctx, repository, nil, "diff", "--name-status", "-z", "-M", base, head, "--", "songs", "sets")
	if err != nil {
		return nil, err
	}
	parts := bytes.Split(output, []byte{0})
	for index := 0; index < len(parts) && len(parts[index]) != 0; {
		status := string(parts[index])
		index++
		if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
			if index+1 >= len(parts) {
				return nil, codeError(CodeUnsupportedGitState, "truncated Git rename record", nil)
			}
			oldPath, newPath := string(parts[index]), string(parts[index+1])
			index += 2
			if strings.HasPrefix(status, "R") {
				result[oldPath] = newPath
			}
			continue
		}
		if index >= len(parts) {
			return nil, codeError(CodeUnsupportedGitState, "truncated Git diff record", nil)
		}
		index++
	}
	return result, nil
}

func (g *gitMaterializer) AddedPaths(ctx context.Context, repository, base, head string) ([]string, error) {
	if base == "" || base == head {
		return nil, nil
	}
	output, err := g.command(ctx, repository, nil, "diff", "--name-only", "--diff-filter=A", "-z", base, head, "--", "songs", "sets")
	if err != nil {
		return nil, err
	}
	parts := bytes.Split(output, []byte{0})
	var result []string
	for _, part := range parts {
		if len(part) != 0 {
			result = append(result, string(part))
		}
	}
	sort.Strings(result)
	return result, nil
}

func (g *gitMaterializer) CommitActor(ctx context.Context, repository, commit string) (string, error) {
	return g.output(ctx, repository, "show", "-s", "--format=%an <%ae>", commit)
}

func (g *gitMaterializer) bundle(ctx context.Context, destination string) (string, error) {
	if destination == "" {
		return "", codeError(CodeInvalidConfig, "empty Git bundle destination", nil)
	}
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return "", err
	}
	if err := os.Remove(absolute); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	directory := filepath.Join(g.root, "checks", "bundle")
	if err := g.resetDirectory(directory); err != nil {
		return "", err
	}
	if err := g.run(ctx, "", "clone", "--quiet", "--mirror", g.remote, directory); err != nil {
		return "", err
	}
	clonedHead, err := g.output(ctx, directory, "rev-parse", "--verify", g.branch)
	if err != nil {
		return "", err
	}
	if !validGitHash(clonedHead) {
		return "", codeError(CodeUnsupportedGitState, "mirrored branch has an invalid object ID", nil)
	}
	if err := g.run(ctx, directory, "bundle", "create", absolute, "--all"); err != nil {
		return "", err
	}
	if err := g.run(ctx, directory, "bundle", "verify", absolute); err != nil {
		return "", err
	}
	listed, err := g.output(ctx, directory, "bundle", "list-heads", absolute, g.branch)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(listed)
	if len(fields) != 2 || fields[1] != g.branch || !validGitHash(fields[0]) || fields[0] != clonedHead {
		return "", codeError(CodeIntegrity, "Git bundle does not advertise the mirrored publication branch", nil)
	}
	return clonedHead, nil
}

func VerifyBundle(ctx context.Context, bundle string) error {
	temporary, err := os.MkdirTemp("", "v2publish-bundle-verify-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	initCommand := exec.CommandContext(ctx, "git", "init", "--quiet", "--bare", temporary)
	initCommand.Env = sanitizedGitEnvironment("LC_ALL=C", "LANG=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if output, err := initCommand.CombinedOutput(); err != nil {
		return fmt.Errorf("initialize Git bundle verifier: %w: %s", err, strings.TrimSpace(string(output)))
	}
	command := exec.CommandContext(ctx, "git", "-C", temporary, "bundle", "verify", bundle)
	command.Env = sanitizedGitEnvironment("LC_ALL=C", "LANG=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("verify Git bundle: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func RestoreBundle(ctx context.Context, bundle, destination string) error {
	if bundle == "" || destination == "" {
		return codeError(CodeInvalidConfig, "bundle and restore destination are required", nil)
	}
	if _, err := os.Stat(destination); err == nil {
		return codeError(CodeInvalidConfig, "Git restore destination already exists", nil)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	command := exec.CommandContext(ctx, "git", "clone", "--quiet", "--mirror", bundle, destination)
	command.Env = sanitizedGitEnvironment("LC_ALL=C", "LANG=C", "TZ=UTC", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("restore Git bundle: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (g *gitMaterializer) Integrity(ctx context.Context) error {
	directory := filepath.Join(g.root, "checks", "integrity")
	if err := g.resetDirectory(directory); err != nil {
		return err
	}
	if err := g.run(ctx, "", "clone", "--quiet", "--mirror", g.remote, directory); err != nil {
		return err
	}
	return g.run(ctx, directory, "fsck", "--strict", "--no-dangling")
}

func uniqueSorted(values ...string) []string {
	seen := map[string]bool{}
	for _, value := range values {
		if value != "" {
			seen[value] = true
		}
	}
	result := make([]string, 0, len(seen))
	for value := range seen {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
