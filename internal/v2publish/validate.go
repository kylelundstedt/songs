package v2publish

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Validator interface {
	Validate(ctx context.Context, worktree string, intent Intent) error
}

type ValidatorOptions struct {
	ApexPath string
	SkipApex bool // intended for hermetic tests; production callers should leave false
}

type ProductionValidator struct {
	apexPath string
	skipApex bool
}

func NewProductionValidator(options ValidatorOptions) (*ProductionValidator, error) {
	path := options.ApexPath
	if path == "" && !options.SkipApex {
		var err error
		path, err = exec.LookPath("apex")
		if err != nil {
			return nil, codeError(CodeInvalidConfig, "Apex executable is required for publication validation", err)
		}
	}
	if path != "" {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
			return nil, codeError(CodeInvalidConfig, "Apex path is not an executable regular file", nil)
		}
	}
	return &ProductionValidator{apexPath: path, skipApex: options.SkipApex}, nil
}

type frontMatter map[string]string

func parseFrontMatter(source []byte) (frontMatter, []byte, error) {
	if !bytes.HasPrefix(source, []byte("---\n")) {
		return frontMatter{}, source, nil
	}
	end := bytes.Index(source[4:], []byte("\n---\n"))
	if end < 0 {
		return nil, nil, errors.New("front matter is not terminated by ---")
	}
	block := source[4 : 4+end]
	body := source[4+end+5:]
	result := frontMatter{}
	scanner := bufio.NewScanner(bytes.NewReader(block))
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := scanner.Text()
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			// Nested YAML belongs to the preceding top-level field. Publication
			// identity/schema checks deliberately inspect only top-level scalars;
			// Apex remains the full Markdown/front-matter parser.
			continue
		}
		key, value, found := strings.Cut(line, ":")
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if !found || key == "" {
			return nil, nil, fmt.Errorf("invalid front-matter scalar on line %d", lineNumber)
		}
		for _, r := range key {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
				return nil, nil, fmt.Errorf("invalid front-matter key %q", key)
			}
		}
		if _, duplicate := result[key]; duplicate {
			return nil, nil, fmt.Errorf("duplicate front-matter key %q", key)
		}
		if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || value[0] == '\'' && value[len(value)-1] == '\'') {
			if value[0] == '"' {
				unquoted, err := strconv.Unquote(value)
				if err != nil {
					return nil, nil, fmt.Errorf("invalid quoted front-matter value for %s: %w", key, err)
				}
				value = unquoted
			} else {
				value = strings.ReplaceAll(value[1:len(value)-1], "''", "'")
			}
		}
		result[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, nil, err
	}
	return result, body, nil
}

func markdownH1(body []byte) (string, int) {
	var title string
	var count int
	inFence := false
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if !inFence && strings.HasPrefix(line, "# ") {
			count++
			if title == "" {
				title = strings.TrimSpace(strings.TrimPrefix(line, "# "))
			}
		}
	}
	return title, count
}

func validateDocumentSource(intent Intent) error {
	payload := intent.Payload
	if payload.Deleted {
		return nil
	}
	source := []byte(payload.Source)
	if !utf8.Valid(source) || bytes.IndexByte(source, 0) >= 0 || bytes.Contains(source, []byte{'\r'}) {
		return errors.New("source must be UTF-8 with LF line endings and no NUL")
	}
	front, body, err := parseFrontMatter(source)
	if err != nil {
		return err
	}
	if schema, present := front["schema_version"]; present && schema != "1" {
		return fmt.Errorf("front-matter schema_version is %q, want 1", schema)
	}
	if payload.Kind == SetList && front["schema_version"] != "1" {
		return errors.New("set-list source requires schema_version: 1")
	}
	if declared, present := front["id"]; present && declared != intent.DocumentID {
		return fmt.Errorf("declared document id %q does not match %q", declared, intent.DocumentID)
	}
	if payload.Kind == SetList && front["id"] != intent.DocumentID {
		return errors.New("set-list source requires its immutable id in front matter")
	}
	title, count := markdownH1(body)
	if count != 1 || title == "" {
		return fmt.Errorf("source must contain exactly one non-empty H1 (found %d)", count)
	}
	if title != intent.Title {
		return fmt.Errorf("H1 title %q does not match revision title %q", title, intent.Title)
	}
	if declared, present := front["title"]; present && declared != title {
		return fmt.Errorf("front-matter title %q does not match H1 %q", declared, title)
	}
	if payload.Kind == SetList {
		sections := 0
		scanner := bufio.NewScanner(bytes.NewReader(body))
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "## ") {
				sections++
			}
		}
		if sections == 0 {
			return errors.New("set-list source requires at least one H2 section")
		}
	}
	return nil
}

var markdownLinkRE = regexp.MustCompile(`!?\[[^\]\n]*\]\(([^)\n]+)\)`)

func localLinkTarget(raw string) (string, bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false, errors.New("empty Markdown link target")
	}
	// A title after a whitespace separator is allowed only for angle-bracketed
	// destinations; canonical corpus links do not rely on ambiguous bare spaces.
	if strings.HasPrefix(raw, "<") {
		end := strings.Index(raw, ">")
		if end < 0 {
			return "", false, errors.New("unterminated angle-bracket Markdown link")
		}
		raw = raw[1:end]
	} else if strings.ContainsAny(raw, " \t") {
		return "", false, errors.New("unescaped whitespace in Markdown link target")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", false, err
	}
	if parsed.Scheme != "" {
		if parsed.Scheme != "https" && parsed.Scheme != "mailto" {
			return "", false, fmt.Errorf("external link scheme %q is not allowed", parsed.Scheme)
		}
		return "", false, nil
	}
	if parsed.Host != "" || strings.HasPrefix(parsed.Path, "//") {
		return "", false, errors.New("scheme-relative links are not allowed")
	}
	if parsed.Path == "" {
		return "", false, nil
	}
	unescaped, err := url.PathUnescape(parsed.Path)
	if err != nil {
		return "", false, err
	}
	if strings.Contains(unescaped, "\\") || strings.ContainsRune(unescaped, 0) {
		return "", false, errors.New("unsafe local Markdown link")
	}
	return unescaped, true, nil
}

func exactRegularFile(root, relative string) error {
	if relative == "" || filepath.IsAbs(relative) {
		return errors.New("link target is not relative")
	}
	rootClean := filepath.Clean(root)
	target := filepath.Clean(filepath.Join(root, filepath.FromSlash(relative)))
	if target != rootClean && !strings.HasPrefix(target, rootClean+string(os.PathSeparator)) {
		return errors.New("link target escapes repository")
	}
	info, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("link target is not a regular file")
	}
	return nil
}

func validateSongRoute(root, target string) error {
	if !strings.HasPrefix(target, "/song/") {
		return errors.New("absolute application link is not a canonical song route")
	}
	slug := strings.TrimPrefix(target, "/song/")
	if slug == "" || strings.Contains(slug, "/") || !validStableID(slug) {
		return errors.New("invalid canonical song route slug")
	}
	entries, err := os.ReadDir(filepath.Join(root, "songs"))
	if err != nil {
		return err
	}
	want := strings.ToLower(slug + ".md")
	for _, entry := range entries {
		if !entry.IsDir() && strings.ToLower(entry.Name()) == want {
			return nil
		}
	}
	return fmt.Errorf("song route %s has no canonical lead sheet", target)
}

func validateLinks(root, relative string, source []byte) error {
	matches := markdownLinkRE.FindAllSubmatch(source, -1)
	for _, match := range matches {
		target, local, err := localLinkTarget(string(match[1]))
		if err != nil {
			return fmt.Errorf("%s: %w", relative, err)
		}
		if !local {
			continue
		}
		if strings.HasPrefix(target, "/") {
			if err := validateSongRoute(root, target); err != nil {
				return fmt.Errorf("%s: %w", relative, err)
			}
			continue
		}
		resolved := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(relative), filepath.FromSlash(target))))
		if resolved == "." || strings.HasPrefix(resolved, "../") || filepath.IsAbs(resolved) {
			return fmt.Errorf("%s: local link escapes corpus: %s", relative, target)
		}
		if err := exactRegularFile(root, resolved); err != nil {
			return fmt.Errorf("%s: unresolved local link %s: %w", relative, target, err)
		}
	}
	return nil
}

func validateSidecar(root string, intent Intent) error {
	target := filepath.Join(root, filepath.FromSlash(sidecarPath(intent.DocumentID)))
	raw, err := os.ReadFile(target)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var sidecar identitySidecar
	if err := decoder.Decode(&sidecar); err != nil {
		return err
	}
	if sidecar.SchemaVersion != SidecarSchemaVersion || sidecar.OwnerID != intent.OwnerID || sidecar.DocumentID != intent.DocumentID || sidecar.Kind != intent.Payload.Kind || sidecar.Path != intent.Payload.Path || sidecar.RevisionID != intent.RevisionID || sidecar.SourceSHA256 != intent.SourceSHA256 || sidecar.Deleted != intent.Payload.Deleted {
		return errors.New("identity sidecar does not exactly bind publication intent")
	}
	return nil
}

func walkCanonical(root string) ([]string, error) {
	var files []string
	for _, directory := range []string{"songs", "sets"} {
		base := filepath.Join(root, directory)
		info, err := os.Lstat(base)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("canonical %s is not a real directory", directory)
		}
		err = filepath.WalkDir(base, func(filePath string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("canonical corpus contains symlink %s", filePath)
			}
			if entry.IsDir() {
				if filePath != base {
					return fmt.Errorf("canonical corpus contains unexpected nested directory %s", filePath)
				}
				return nil
			}
			if !info.Mode().IsRegular() || filepath.Ext(filePath) != ".md" {
				return fmt.Errorf("canonical corpus contains unexpected file %s", filePath)
			}
			relative, err := filepath.Rel(root, filePath)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(relative))
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Strings(files)
	return files, nil
}

func validateCorpus(root string) error {
	files, err := walkCanonical(root)
	if err != nil {
		return err
	}
	declaredIDs := map[string]string{}
	for _, relative := range files {
		raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			return err
		}
		if !utf8.Valid(raw) || bytes.IndexByte(raw, 0) >= 0 {
			return fmt.Errorf("%s is not valid UTF-8 without NUL", relative)
		}
		front, _, err := parseFrontMatter(raw)
		if err != nil {
			return fmt.Errorf("%s: %w", relative, err)
		}
		if id := front["id"]; id != "" {
			if previous, exists := declaredIDs[id]; exists {
				return fmt.Errorf("duplicate declared document id %q in %s and %s", id, previous, relative)
			}
			declaredIDs[id] = relative
		}
		if err := validateLinks(root, relative, raw); err != nil {
			return err
		}
	}
	return nil
}

func (v *ProductionValidator) validateApex(ctx context.Context, worktree string, intent Intent) error {
	if intent.Payload.Deleted || v.skipApex {
		return nil
	}
	target := filepath.Join(worktree, filepath.FromSlash(intent.Payload.Path))
	command := exec.CommandContext(ctx, v.apexPath, "--no-plugins", "--no-unsafe", "--aria", "--mode", "unified", "--to", "html", target)
	command.Env = sanitizedGitEnvironment("LC_ALL=C", "LANG=C", "TZ=UTC")
	output, err := command.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if len(detail) > 1000 {
			detail = detail[:1000]
		}
		return codeError(CodeValidation, "Apex validation failed", fmt.Errorf("%w: %s", err, detail))
	}
	return nil
}

func (v *ProductionValidator) Validate(ctx context.Context, worktree string, intent Intent) error {
	if err := ValidatePublicationPath(intent.Payload.Kind, intent.Payload.Path); err != nil {
		return codeError(CodeValidation, "path validation failed", err)
	}
	if err := validateDocumentSource(intent); err != nil {
		return codeError(CodeValidation, "schema or identity validation failed", err)
	}
	if err := validateSidecar(worktree, intent); err != nil {
		return codeError(CodeValidation, "identity sidecar validation failed", err)
	}
	if err := validateCorpus(worktree); err != nil {
		return codeError(CodeValidation, "link or corpus validation failed", err)
	}
	return v.validateApex(ctx, worktree, intent)
}

// ValidateExternal validates actual external body/path bytes without trusting
// editable sidecar revision or source-hash claims.
func (v *ProductionValidator) ValidateExternal(ctx context.Context, worktree string, intent Intent) error {
	if err := ValidatePublicationPath(intent.Payload.Kind, intent.Payload.Path); err != nil {
		return codeError(CodeValidation, "external path validation failed", err)
	}
	if err := validateDocumentSource(intent); err != nil {
		return codeError(CodeValidation, "external schema or identity validation failed", err)
	}
	if err := validateCorpus(worktree); err != nil {
		return codeError(CodeValidation, "external link or corpus validation failed", err)
	}
	return v.validateApex(ctx, worktree, intent)
}
