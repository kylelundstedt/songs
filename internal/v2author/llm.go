package v2author

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

type shelleySuggestRequest struct {
	BaseSourceSHA256 string `json:"base_source_sha256"`
	Title            string `json:"title"`
	Source           string `json:"source"`
	Prompt           string `json:"prompt"`
}

// SuggestResponse is a review-only exact-source candidate. BaseSourceSHA256 is
// echoed so the browser can reject a stale suggestion before local adoption.
type SuggestResponse struct {
	SchemaVersion    string `json:"schema_version"`
	ReviewRequired   bool   `json:"review_required"`
	BaseSourceSHA256 string `json:"base_source_sha256"`
	Source           string `json:"source"`
	SourceSHA256     string `json:"source_sha256"`
	Model            string `json:"model"`
}

func (h *Handler) handleShelleySuggest(w http.ResponseWriter, r *http.Request) {
	var in shelleySuggestRequest
	if !requireJSON(w, r, maxRequestBytes, &in) {
		return
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(in.BaseSourceSHA256) || sha256Hex(in.Source) != in.BaseSourceSHA256 {
		writeError(w, http.StatusBadRequest, "BASE_HASH_MISMATCH", "base_source_sha256 does not match the exact source")
		return
	}
	if !validPrompt(in.Prompt) {
		writeError(w, http.StatusBadRequest, "INVALID_PROMPT", "prompt must contain 3 to 2000 bounded characters")
		return
	}
	baseIssues, baseFront := validateLeadSheet("", "", in.Title, in.Source, false)
	if len(baseIssues) != 0 {
		writeError(w, http.StatusUnprocessableEntity, "INVALID_BASE_SOURCE", "base source is not a valid lead-sheet candidate")
		return
	}
	if !acquire(h.modelSem) {
		writeError(w, http.StatusTooManyRequests, "TOO_MANY_REQUESTS", "Shelley is already processing another suggestion")
		return
	}
	defer release(h.modelSem)

	system := "You revise vocalist lead-sheet Markdown. Return only the complete revised Markdown source, with no code fence or commentary. Preserve every byte and field not required by the requested focused change. Never invent lyrics, metadata, counts, chords, or facts."
	user := "Title: " + in.Title + "\nRequested focused change: " + in.Prompt + "\n\nExact base source follows:\n" + in.Source
	candidate, err := h.modelText(r.Context(), system, user, 16000)
	if err != nil {
		writeError(w, http.StatusBadGateway, "SHELLEY_UNAVAILABLE", "Shelley could not produce a safe suggestion")
		return
	}
	candidate = unwrapMarkdownFence(candidate)
	issues, candidateFront := validateLeadSheet("", "", in.Title, candidate, false)
	if len(issues) != 0 || candidate == in.Source {
		writeError(w, http.StatusBadGateway, "INVALID_MODEL_RESPONSE", "Shelley did not return a valid revised exact source")
		return
	}
	if baseID, ok := baseFront["id"]; ok {
		if candidateID, present := candidateFront["id"]; !present || candidateID != baseID {
			writeError(w, http.StatusBadGateway, "INVALID_MODEL_RESPONSE", "Shelley changed immutable lead-sheet identity")
			return
		}
	}
	writeJSON(w, http.StatusOK, SuggestResponse{"1", true, in.BaseSourceSHA256, candidate, sha256Hex(candidate), h.model})
}

func unwrapMarkdownFence(value string) string {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "```") {
		return value
	}
	first := strings.IndexByte(trimmed, '\n')
	last := strings.LastIndex(trimmed, "\n```")
	if first < 0 || last <= first || strings.TrimSpace(trimmed[last+1:]) != "```" {
		return value
	}
	return trimmed[first+1 : last]
}

func (h *Handler) modelText(parent context.Context, system, user string, maxOutputTokens int) (string, error) {
	ctx, cancel := context.WithTimeout(parent, modelTimeout)
	defer cancel()
	payload, err := json.Marshal(map[string]any{
		"model": h.model,
		"input": []map[string]any{
			{"role": "system", "content": []map[string]string{{"type": "input_text", "text": system}}},
			{"role": "user", "content": []map[string]string{{"type": "input_text", "text": user}}},
		},
		"reasoning":         map[string]string{"effort": "none"},
		"max_output_tokens": maxOutputTokens,
		"store":             false,
		"stream":            false,
	})
	if err != nil {
		return "", err
	}
	if len(payload) > maxModelRequest {
		return "", errors.New("model request exceeded limit")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.llm+"/v1/responses", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := h.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("model HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxModelResponse+1))
	if err != nil || len(body) > maxModelResponse {
		return "", errors.New("model response exceeded limit")
	}
	var text string
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") || bytes.HasPrefix(bytes.TrimSpace(body), []byte("data:")) {
		text, err = parseModelSSE(body)
	} else {
		text, err = parseModelJSON(body)
	}
	if err != nil {
		return "", err
	}
	if text == "" || len(text) > MaxSourceBytes || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", errors.New("model returned invalid text")
	}
	return text, nil
}

func parseModelSSE(body []byte) (string, error) {
	var output strings.Builder
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64<<10), maxModelResponse)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var event struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Text  string `json:"text"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return "", err
		}
		switch event.Type {
		case "response.output_text.delta":
			output.WriteString(event.Delta)
		case "response.output_text.done":
			if output.Len() == 0 {
				output.WriteString(event.Text)
			}
		}
		if output.Len() > MaxSourceBytes {
			return "", errors.New("model text exceeded limit")
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	if output.Len() == 0 {
		return "", errors.New("model returned no output text")
	}
	return output.String(), nil
}

func parseModelJSON(body []byte) (string, error) {
	if duplicateJSONKey(body) {
		return "", errors.New("model response has duplicate fields")
	}
	var response struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&response); err != nil {
		return "", err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return "", errors.New("model response has trailing JSON")
	}
	if response.OutputText != "" {
		return response.OutputText, nil
	}
	var b strings.Builder
	for _, item := range response.Output {
		for _, content := range item.Content {
			if content.Type == "output_text" {
				b.WriteString(content.Text)
			}
		}
	}
	if b.Len() == 0 {
		return "", errors.New("model returned no output text")
	}
	return b.String(), nil
}

type modelPlan struct {
	Sections []struct {
		Heading  string `json:"heading"`
		Start    int    `json:"start"`
		End      int    `json:"end"`
		RepeatOf int    `json:"repeat_of"`
	} `json:"sections"`
}

var headingRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9 -]{0,48}$`)

func (h *Handler) structureLyricsWithModel(parent context.Context, title, lyrics string) (string, error) {
	var lines []string
	var numbered strings.Builder
	for _, line := range strings.Split(lyrics, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
			numbered.WriteString("[stanza break]\n")
		case isSectionLabel(line):
			numbered.WriteString("[section hint: " + strings.Trim(line, "[]") + "]\n")
		default:
			lines = append(lines, line)
			fmt.Fprintf(&numbered, "%d: %s\n", len(lines), line)
		}
	}
	if len(lines) == 0 {
		return "", errors.New("no lyric lines")
	}
	prompt := `Return a compact section plan as JSON only: {"sections":[{"heading":"Verse 1","start":1,"end":4,"repeat_of":0}]}. Sections must cover every numbered lyric line exactly once in order with no gaps or overlaps. start/end are inclusive. Use concise performance headings. repeat_of is zero or an earlier one-based section with identical lines. Do not return lyrics, Markdown, commentary, or code fences.

Numbered lyrics:
` + numbered.String()
	raw, err := h.modelText(parent, "You create exact section plans for vocalist lead sheets.", prompt, 4000)
	if err != nil {
		return "", err
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```") {
		raw = unwrapMarkdownFence(raw)
	}
	var plan modelPlan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		return "", err
	}
	if len(plan.Sections) == 0 || len(plan.Sections) > len(lines) {
		return "", errors.New("invalid section count")
	}
	next := 1
	for i, section := range plan.Sections {
		if !headingRE.MatchString(strings.TrimSpace(section.Heading)) || section.Start != next || section.End < section.Start || section.End > len(lines) || section.RepeatOf < 0 || section.RepeatOf > i {
			return "", errors.New("invalid section")
		}
		next = section.End + 1
	}
	if next != len(lines)+1 {
		return "", errors.New("section plan omitted lines")
	}
	var b strings.Builder
	b.WriteString("# " + title + "\n\n")
	for i, section := range plan.Sections {
		heading := canonicalSection(section.Heading)
		b.WriteString("### " + heading + "\n")
		current := lines[section.Start-1 : section.End]
		abbreviate := false
		if section.RepeatOf > 0 {
			previous := plan.Sections[section.RepeatOf-1]
			if canonicalSection(previous.Heading) == heading && equalLines(current, lines[previous.Start-1:previous.End]) {
				abbreviate = true
			}
		}
		if !abbreviate {
			b.WriteString(preserveLineBreaks(strings.Join(current, "\n")) + "\n")
		}
		if i < len(plan.Sections)-1 {
			b.WriteByte('\n')
		}
	}
	return strings.TrimSpace(b.String()) + "\n", nil
}
func equalLines(a, b []string) bool {
	if len(a) != len(b) || len(a) == 0 {
		return false
	}
	for i := range a {
		if strings.TrimSpace(a[i]) != strings.TrimSpace(b[i]) {
			return false
		}
	}
	return true
}
