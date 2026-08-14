package v2author

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"songs.exe.dev/internal/v2auth"
)

type validateRequest struct {
	DocumentID string `json:"document_id"`
	Path       string `json:"path"`
	Title      string `json:"title"`
	Source     string `json:"source"`
}

// ValidationIssue is a stable, source-safe validation result.
type ValidationIssue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Line    int    `json:"line,omitempty"`
}

// ValidationResponse contains authoritative Apex HTML only when Valid is true.
type ValidationResponse struct {
	SchemaVersion string            `json:"schema_version"`
	Authority     string            `json:"authority"`
	DocumentID    string            `json:"document_id"`
	Path          string            `json:"path"`
	Title         string            `json:"title"`
	SourceSHA256  string            `json:"source_sha256"`
	Valid         bool              `json:"valid"`
	HTML          string            `json:"html,omitempty"`
	Issues        []ValidationIssue `json:"issues"`
}

func (h *Handler) handleValidate(w http.ResponseWriter, r *http.Request) {
	var in validateRequest
	if !requireJSON(w, r, maxRequestBytes, &in) {
		return
	}
	response := ValidationResponse{
		SchemaVersion: "1", Authority: "server-apex", DocumentID: in.DocumentID,
		Path: in.Path, Title: in.Title, SourceSHA256: sha256Hex(in.Source), Issues: []ValidationIssue{},
	}
	issues, _ := validateLeadSheet(in.DocumentID, in.Path, in.Title, in.Source, true)
	if len(issues) != 0 {
		response.Issues = issues
		writeJSON(w, http.StatusUnprocessableEntity, response)
		return
	}
	if !acquire(h.apexSem) {
		writeError(w, http.StatusTooManyRequests, "TOO_MANY_REQUESTS", "too many Apex validation requests")
		return
	}
	defer release(h.apexSem)
	html, err := h.renderApex(r.Context(), in.Path, in.Source)
	if err != nil {
		response.Issues = []ValidationIssue{{Code: "APEX_VALIDATION_FAILED", Message: "Apex could not validate and render the candidate"}}
		writeJSON(w, http.StatusUnprocessableEntity, response)
		return
	}
	response.Valid, response.HTML = true, html
	writeJSON(w, http.StatusOK, response)
}

var leadSheetPathRE = regexp.MustCompile(`^songs/[A-Za-z0-9][A-Za-z0-9'_\-]*\.md$`)
var bpmRE = regexp.MustCompile(`^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$`)

func validateLeadSheet(documentID, documentPath, title, source string, requireIdentity bool) ([]ValidationIssue, map[string]string) {
	var issues []ValidationIssue
	add := func(code, message string, line int) {
		issues = append(issues, ValidationIssue{Code: code, Message: message, Line: line})
	}
	if requireIdentity && !v2auth.ValidStableID(documentID) {
		add("DOCUMENT_ID_INVALID", "document_id must be a stable lowercase ID", 0)
	}
	if requireIdentity && !validLeadSheetPath(documentPath) {
		add("PATH_INVALID", "path must be one safe Markdown file below songs/", 0)
	}
	if !validSingleLine(title, 512, false) {
		add("TITLE_INVALID", "title must be a bounded non-empty single line", 0)
	}
	if source == "" || len(source) > MaxSourceBytes || !utf8.ValidString(source) || strings.ContainsAny(source, "\x00\r") {
		add("SOURCE_INVALID", "source must be non-empty bounded UTF-8 with LF line endings and no NUL", 0)
		return issues, nil
	}
	front, body, frontIssues := scanFrontMatter(source)
	issues = append(issues, frontIssues...)
	if front == nil {
		return issues, nil
	}
	if schema, ok := front["schema_version"]; ok && schema != "1" {
		add("SCHEMA_VERSION_INVALID", "schema_version must be 1", 0)
	}
	if requireIdentity {
		if declared, ok := front["id"]; ok && declared != documentID {
			add("DOCUMENT_ID_MISMATCH", "front-matter id does not match document_id", 0)
		}
	}
	h1, count := markdownH1(body)
	if count != 1 || h1 == "" {
		add("H1_INVALID", fmt.Sprintf("source must contain exactly one non-empty H1; found %d", count), 0)
	}
	if h1 != "" && title != h1 {
		add("TITLE_MISMATCH", "request title must match the source H1", 0)
	}
	if declared, ok := front["title"]; ok && h1 != "" && declared != h1 {
		add("TITLE_MISMATCH", "front-matter title must match the source H1", 0)
	}
	if artist, ok := front["artist"]; !ok || strings.TrimSpace(artist) == "" {
		add("ARTIST_REQUIRED", "artist is required", 0)
	}
	for _, field := range []string{"bpm", "original_bpm"} {
		if value, ok := front[field]; ok && !validBPM(value) {
			add("BPM_INVALID", field+" must be a decimal BPM greater than 0 and at most 1000", 0)
		}
	}
	return issues, front
}

func validLeadSheetPath(value string) bool {
	return len(value) <= 240 && leadSheetPathRE.MatchString(value) && path.Clean(value) == value
}

func validSingleLine(value string, maximum int, empty bool) bool {
	return len(value) <= maximum && utf8.ValidString(value) && !strings.ContainsAny(value, "\x00\r\n") && strings.TrimSpace(value) == value && (empty || value != "")
}

func validPrompt(value string) bool {
	return len(value) >= 3 && len(value) <= 2000 && utf8.ValidString(value) && !strings.ContainsRune(value, 0) && strings.TrimSpace(value) == value
}

func validBPM(value string) bool {
	if !bpmRE.MatchString(value) {
		return false
	}
	n, err := strconv.ParseFloat(value, 64)
	return err == nil && n > 0 && n <= 1000
}

func scanFrontMatter(source string) (map[string]string, string, []ValidationIssue) {
	if !strings.HasPrefix(source, "---\n") {
		return nil, "", []ValidationIssue{{Code: "FRONT_MATTER_INVALID", Message: "source must start with an LF front-matter delimiter"}}
	}
	end := strings.Index(source[4:], "\n---\n")
	if end < 0 {
		return nil, "", []ValidationIssue{{Code: "FRONT_MATTER_INVALID", Message: "front matter is not terminated by an exact --- line"}}
	}
	block := source[4 : 4+end]
	body := source[4+end+5:]
	result := map[string]string{}
	var issues []ValidationIssue
	scanner := bufio.NewScanner(strings.NewReader(block))
	lineNumber := 1
	for scanner.Scan() {
		lineNumber++
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || line[0] == ' ' || line[0] == '\t' {
			continue
		}
		key, raw, found := strings.Cut(line, ":")
		key, raw = strings.TrimSpace(key), strings.TrimSpace(raw)
		if !found || key == "" || !validFrontKey(key) {
			issues = append(issues, ValidationIssue{Code: "FRONT_MATTER_INVALID", Message: "invalid top-level front-matter scalar", Line: lineNumber})
			continue
		}
		if _, duplicate := result[key]; duplicate {
			issues = append(issues, ValidationIssue{Code: "DUPLICATE_FRONT_MATTER_KEY", Message: "duplicate top-level front-matter key " + key, Line: lineNumber})
			continue
		}
		value, err := parseScalar(raw)
		if err != nil {
			issues = append(issues, ValidationIssue{Code: "FRONT_MATTER_INVALID", Message: "invalid top-level front-matter scalar " + key, Line: lineNumber})
			continue
		}
		result[key] = value
	}
	if scanner.Err() != nil {
		issues = append(issues, ValidationIssue{Code: "FRONT_MATTER_INVALID", Message: "front matter could not be scanned"})
	}
	return result, body, issues
}

func validFrontKey(key string) bool {
	for _, r := range key {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return key != ""
}

func parseScalar(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if raw[0] == '"' {
		end := quotedScalarEnd(raw, '"')
		if end < 0 || !commentSuffix(raw[end+1:]) {
			return "", errors.New("invalid quoted scalar")
		}
		return strconv.Unquote(raw[:end+1])
	}
	if raw[0] == '\'' {
		end := quotedScalarEnd(raw, '\'')
		if end < 0 || !commentSuffix(raw[end+1:]) {
			return "", errors.New("invalid quoted scalar")
		}
		return strings.ReplaceAll(raw[1:end], "''", "'"), nil
	}
	value := raw
	for i := 1; i < len(raw); i++ {
		if raw[i] == '#' && (raw[i-1] == ' ' || raw[i-1] == '\t') {
			value = raw[:i]
			break
		}
	}
	return strings.TrimSpace(value), nil
}

func quotedScalarEnd(raw string, quote byte) int {
	for i := 1; i < len(raw); i++ {
		if quote == '"' && raw[i] == '\\' {
			i++
			continue
		}
		if raw[i] != quote {
			continue
		}
		if quote == '\'' && i+1 < len(raw) && raw[i+1] == '\'' {
			i++
			continue
		}
		return i
	}
	return -1
}
func commentSuffix(value string) bool {
	value = strings.TrimSpace(value)
	return value == "" || strings.HasPrefix(value, "#")
}

func markdownH1(body string) (string, int) {
	var title string
	count := 0
	var marker byte
	markerLen := 0
	scanner := bufio.NewScanner(strings.NewReader(body))
	for scanner.Scan() {
		line := scanner.Text()
		candidate := strings.TrimLeft(line, " ")
		indent := len(line) - len(candidate)
		if indent > 3 {
			candidate = ""
		}
		if marker == 0 {
			if n := fencePrefix(candidate, '`'); n >= 3 {
				marker, markerLen = '`', n
				continue
			}
			if n := fencePrefix(candidate, '~'); n >= 3 {
				marker, markerLen = '~', n
				continue
			}
			if strings.HasPrefix(line, "# ") {
				value := strings.TrimSpace(strings.TrimPrefix(line, "# "))
				if value != "" {
					count++
					if title == "" {
						title = value
					}
				}
			}
		} else if n := fencePrefix(candidate, marker); n >= markerLen && strings.Trim(candidate[n:], " \t") == "" {
			marker, markerLen = 0, 0
		}
	}
	return title, count
}
func fencePrefix(line string, marker byte) int {
	n := 0
	for n < len(line) && line[n] == marker {
		n++
	}
	return n
}

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

type limitBuffer struct {
	b        bytes.Buffer
	limit    int
	exceeded bool
}

func (w *limitBuffer) Write(p []byte) (int, error) {
	original := len(p)
	remaining := w.limit - w.b.Len()
	if remaining <= 0 {
		w.exceeded = true
		return original, nil
	}
	if len(p) > remaining {
		w.exceeded = true
		p = p[:remaining]
	}
	_, _ = w.b.Write(p)
	return original, nil
}

func (h *Handler) renderApex(parent context.Context, candidatePath, source string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, apexTimeout)
	defer cancel()
	temp, err := os.CreateTemp("", ".songs-v2-author-*.md")
	if err != nil {
		return "", err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return "", err
	}
	if _, err := io.WriteString(temp, source); err != nil {
		temp.Close()
		return "", err
	}
	if err := temp.Close(); err != nil {
		return "", err
	}

	cmd := exec.CommandContext(ctx, h.apexPath, "--no-plugins", "--no-unsafe", "--aria", "--mode", "unified", "--to", "html", name)
	cmd.Env = []string{"LC_ALL=C", "LANG=C", "TZ=UTC", "PATH=/usr/bin:/bin"}
	var stdout, stderr limitBuffer
	stdout.limit, stderr.limit = maxApexOutput, 16<<10
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		return "", fmt.Errorf("Apex failed: %w", err)
	}
	if stdout.exceeded || stderr.exceeded {
		return "", errors.New("Apex output exceeded limit")
	}
	output := stdout.b.String()
	if output == "" || !utf8.ValidString(output) || strings.ContainsRune(output, 0) {
		return "", errors.New("Apex returned invalid HTML")
	}
	_ = candidatePath // path identity is validated separately; temp basename is intentionally untrusted-data-free.
	return output, nil
}
