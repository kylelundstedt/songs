package v2author

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ProviderChoice is metadata only; provider search never returns lyrics.
type ProviderChoice struct {
	Provider string  `json:"provider"`
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Artist   string  `json:"artist"`
	Album    string  `json:"album,omitempty"`
	Duration float64 `json:"duration,omitempty"`
}

type providerSearchResponse struct {
	SchemaVersion  string           `json:"schema_version"`
	Choices        []ProviderChoice `json:"choices"`
	ProviderErrors []string         `json:"provider_errors"`
}

type providerImportRequest struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
}

// ImportResponse is a complete, non-published source candidate for review.
type ImportResponse struct {
	SchemaVersion  string `json:"schema_version"`
	ReviewRequired bool   `json:"review_required"`
	Title          string `json:"title"`
	Artist         string `json:"artist"`
	OriginalBPM    string `json:"original_bpm,omitempty"`
	SourceProvider string `json:"source_provider"`
	SourceURL      string `json:"source_url"`
	Source         string `json:"source"`
	SourceSHA256   string `json:"source_sha256"`
	StructuredBy   string `json:"structured_by"`
}

type providerDraft struct{ title, artist, bpm, sourceProvider, sourceURL, body, structuredBy string }

func (h *Handler) handleProviderSearch(w http.ResponseWriter, r *http.Request) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_QUERY", "search query is invalid")
		return
	}
	for key, entries := range values {
		if (key != "title" && key != "artist") || len(entries) != 1 {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "search accepts title and artist exactly once")
			return
		}
	}
	title, artist := strings.TrimSpace(values.Get("title")), strings.TrimSpace(values.Get("artist"))
	if !validSingleLine(title, 200, true) || !validSingleLine(artist, 200, true) || len(strings.TrimSpace(artist+" "+title)) < 2 {
		writeError(w, http.StatusBadRequest, "INVALID_QUERY", "enter at least two bounded title or artist characters")
		return
	}
	if !acquire(h.providerSem) {
		writeError(w, http.StatusTooManyRequests, "TOO_MANY_REQUESTS", "too many provider requests")
		return
	}
	defer release(h.providerSem)
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()

	type result struct {
		choices []ProviderChoice
		err     error
	}
	results := make([]result, 2)
	done := make(chan int, 2)
	query := strings.TrimSpace(artist + " " + title)
	go func() { results[0].choices, results[0].err = h.searchLRCLIB(ctx, query); done <- 0 }()
	go func() { results[1].choices, results[1].err = h.searchLyricsOvh(ctx, query); done <- 1 }()
	<-done
	<-done
	choices := append(append([]ProviderChoice{}, results[0].choices...), results[1].choices...)
	errorsOut := []string{}
	if results[0].err != nil {
		errorsOut = append(errorsOut, "LRCLIB unavailable")
	}
	if results[1].err != nil {
		errorsOut = append(errorsOut, "Lyrics.ovh unavailable")
	}
	if len(choices) == 0 && len(errorsOut) == 2 {
		writeError(w, http.StatusBadGateway, "PROVIDERS_UNAVAILABLE", "lyrics providers are temporarily unavailable")
		return
	}
	sort.SliceStable(choices, func(i, j int) bool {
		si, sj := choiceScore(choices[i], title, artist), choiceScore(choices[j], title, artist)
		if si != sj {
			return si > sj
		}
		left := choices[i].Provider + "\x00" + normalize(choices[i].Title) + "\x00" + normalize(choices[i].Artist) + "\x00" + choices[i].ID
		right := choices[j].Provider + "\x00" + normalize(choices[j].Title) + "\x00" + normalize(choices[j].Artist) + "\x00" + choices[j].ID
		return left < right
	})
	if len(choices) > 12 {
		choices = choices[:12]
	}
	writeJSON(w, http.StatusOK, providerSearchResponse{"1", choices, errorsOut})
}

func choiceScore(choice ProviderChoice, title, artist string) int {
	score := 0
	ct, ca, title, artist := normalize(choice.Title), normalize(choice.Artist), normalize(title), normalize(artist)
	if title != "" {
		if ct == title {
			score += 100
		} else if strings.Contains(ct, title) {
			score += 35
		}
	}
	if artist != "" {
		if ca == artist {
			score += 60
		} else if strings.Contains(ca, artist) {
			score += 20
		}
	}
	if choice.Provider == "LRCLIB" {
		score += 2
	}
	return score
}
func normalize(value string) string { return strings.Join(strings.Fields(strings.ToLower(value)), " ") }

func (h *Handler) searchLRCLIB(parent context.Context, query string) ([]ProviderChoice, error) {
	var records []struct {
		ID           int64   `json:"id"`
		TrackName    string  `json:"trackName"`
		ArtistName   string  `json:"artistName"`
		AlbumName    string  `json:"albumName"`
		Duration     float64 `json:"duration"`
		Instrumental bool    `json:"instrumental"`
	}
	if err := h.fetchJSON(parent, h.lrclib+"/api/search?q="+url.QueryEscape(query), &records); err != nil {
		return nil, err
	}
	choices := make([]ProviderChoice, 0, 6)
	for _, record := range records {
		if record.ID < 1 || record.Instrumental || !validProviderText(record.TrackName, 200) || !validProviderText(record.ArtistName, 200) {
			continue
		}
		album := boundedProviderText(record.AlbumName, 200)
		duration := record.Duration
		if duration < 0 || duration > 24*60*60 {
			duration = 0
		}
		choices = append(choices, ProviderChoice{"LRCLIB", strconv.FormatInt(record.ID, 10), record.TrackName, record.ArtistName, album, duration})
		if len(choices) == 6 {
			break
		}
	}
	return choices, nil
}

func (h *Handler) searchLyricsOvh(parent context.Context, query string) ([]ProviderChoice, error) {
	var response struct {
		Data []struct {
			ID       int64  `json:"id"`
			Title    string `json:"title"`
			Duration int    `json:"duration"`
			Artist   struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				Title string `json:"title"`
			} `json:"album"`
		} `json:"data"`
	}
	if err := h.fetchJSON(parent, h.lyricsOvh+"/suggest/"+url.PathEscape(query), &response); err != nil {
		return nil, err
	}
	choices := make([]ProviderChoice, 0, 6)
	for _, record := range response.Data {
		if record.ID < 1 || !validProviderText(record.Title, 200) || !validProviderText(record.Artist.Name, 200) {
			continue
		}
		duration := float64(record.Duration)
		if duration < 0 || duration > 24*60*60 {
			duration = 0
		}
		choices = append(choices, ProviderChoice{"Lyrics.ovh", strconv.FormatInt(record.ID, 10), record.Title, record.Artist.Name, boundedProviderText(record.Album.Title, 200), duration})
		if len(choices) == 6 {
			break
		}
	}
	return choices, nil
}

func validProviderText(value string, maximum int) bool { return validSingleLine(value, maximum, false) }
func boundedProviderText(value string, maximum int) string {
	if validSingleLine(value, maximum, true) {
		return value
	}
	return ""
}

func (h *Handler) handleProviderImport(w http.ResponseWriter, r *http.Request) {
	var in providerImportRequest
	if !requireJSON(w, r, 64<<10, &in) {
		return
	}
	if !validProviderText(in.Title, 200) || !validProviderText(in.Artist, 200) || !validNumericID(in.ID) {
		writeError(w, http.StatusBadRequest, "INVALID_SELECTION", "provider selection is invalid")
		return
	}
	if !acquire(h.providerSem) {
		writeError(w, http.StatusTooManyRequests, "TOO_MANY_REQUESTS", "too many provider requests")
		return
	}
	defer release(h.providerSem)
	ctx, cancel := context.WithTimeout(r.Context(), providerWorkflowTimeout)
	defer cancel()
	var draft providerDraft
	var err error
	switch in.Provider {
	case "LRCLIB":
		draft, err = h.importLRCLIB(ctx, in)
	case "Lyrics.ovh":
		draft, err = h.importLyricsOvh(ctx, in)
	default:
		writeError(w, http.StatusBadRequest, "INVALID_SELECTION", "provider selection is invalid")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "PROVIDER_IMPORT_FAILED", "the selected recording could not be imported")
		return
	}
	source := buildProviderSource(draft)
	if issues, _ := validateLeadSheet("", "", draft.title, source, false); len(issues) != 0 {
		writeError(w, http.StatusBadGateway, "PROVIDER_IMPORT_FAILED", "the provider candidate was not a valid lead sheet")
		return
	}
	writeJSON(w, http.StatusOK, ImportResponse{"1", true, draft.title, draft.artist, draft.bpm, draft.sourceProvider, draft.sourceURL, source, sha256Hex(source), draft.structuredBy})
}

func validNumericID(id string) bool {
	if id == "" || len(id) > 20 || id[0] == '0' {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	_, err := strconv.ParseInt(id, 10, 64)
	return err == nil
}

func (h *Handler) importLRCLIB(parent context.Context, in providerImportRequest) (providerDraft, error) {
	var record struct {
		ID          int64  `json:"id"`
		TrackName   string `json:"trackName"`
		ArtistName  string `json:"artistName"`
		PlainLyrics string `json:"plainLyrics"`
	}
	endpoint := h.lrclib + "/api/get/" + url.PathEscape(in.ID)
	if err := h.fetchJSON(parent, endpoint, &record); err != nil {
		return providerDraft{}, err
	}
	id, _ := strconv.ParseInt(in.ID, 10, 64)
	if record.ID != id || normalize(record.TrackName) != normalize(in.Title) || normalize(record.ArtistName) != normalize(in.Artist) || !validProviderText(record.TrackName, 200) || !validProviderText(record.ArtistName, 200) {
		return providerDraft{}, errors.New("selection mismatch")
	}
	lyrics, err := boundedLyrics(record.PlainLyrics)
	if err != nil {
		return providerDraft{}, err
	}
	body, by := h.structureLyrics(parent, record.TrackName, lyrics)
	return providerDraft{record.TrackName, record.ArtistName, h.lookupOriginalBPM(parent, record.TrackName, record.ArtistName, ""), "LRCLIB", endpoint, body, by}, nil
}

func (h *Handler) importLyricsOvh(parent context.Context, in providerImportRequest) (providerDraft, error) {
	choices, err := h.searchLyricsOvh(parent, in.Artist+" "+in.Title)
	if err != nil {
		return providerDraft{}, err
	}
	matched := false
	for _, choice := range choices {
		if choice.ID == in.ID && normalize(choice.Title) == normalize(in.Title) && normalize(choice.Artist) == normalize(in.Artist) {
			matched = true
			break
		}
	}
	if !matched {
		return providerDraft{}, errors.New("selection mismatch")
	}
	endpoint := h.lyricsOvh + "/v1/" + url.PathEscape(in.Artist) + "/" + url.PathEscape(in.Title)
	var response struct {
		Lyrics string `json:"lyrics"`
	}
	if err := h.fetchJSON(parent, endpoint, &response); err != nil {
		return providerDraft{}, err
	}
	lyrics, err := boundedLyrics(response.Lyrics)
	if err != nil {
		return providerDraft{}, err
	}
	body, by := h.structureLyrics(parent, in.Title, lyrics)
	return providerDraft{in.Title, in.Artist, h.lookupOriginalBPM(parent, in.Title, in.Artist, in.ID), "Lyrics.ovh", endpoint, body, by}, nil
}

func boundedLyrics(value string) (string, error) {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	if len(value) > MaxSourceBytes/2 || !utf8.ValidString(value) || strings.ContainsRune(value, 0) || strings.TrimSpace(value) == "" {
		return "", errors.New("invalid lyrics")
	}
	return value, nil
}

func (h *Handler) lookupOriginalBPM(parent context.Context, title, artist, preferredID string) string {
	id := preferredID
	if id == "" {
		choices, err := h.searchLyricsOvh(parent, artist+" "+title)
		if err != nil {
			return ""
		}
		for _, choice := range choices {
			if normalize(choice.Title) == normalize(title) && normalize(choice.Artist) == normalize(artist) {
				id = choice.ID
				break
			}
		}
	}
	if !validNumericID(id) {
		return ""
	}
	var track struct {
		BPM float64 `json:"bpm"`
	}
	if err := h.fetchJSON(parent, h.deezer+"/track/"+url.PathEscape(id), &track); err != nil || track.BPM <= 0 || track.BPM > 1000 {
		return ""
	}
	return strconv.FormatFloat(track.BPM, 'f', -1, 64)
}

func (h *Handler) fetchJSON(parent context.Context, endpoint string, destination any) error {
	ctx, cancel := context.WithTimeout(parent, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "songs-v2-author/1.0")
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("provider HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProviderResponse+1))
	if err != nil || len(body) > maxProviderResponse {
		return errors.New("provider response too large")
	}
	if duplicateJSONKey(body) {
		return errors.New("provider response has duplicate fields")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("provider response has trailing JSON")
	}
	return nil
}

func buildProviderSource(d providerDraft) string {
	var b strings.Builder
	b.WriteString("---\nschema_version: 1\n")
	b.WriteString("title: " + strconv.Quote(d.title) + "\nartist: " + strconv.Quote(d.artist) + "\n")
	if d.bpm != "" {
		b.WriteString("original_bpm: " + strconv.Quote(d.bpm) + "\n")
	}
	b.WriteString("provenance_status: \"provider-imported-pending-review\"\n")
	b.WriteString("source_provider: " + strconv.Quote(d.sourceProvider) + "\nsource_url: " + strconv.Quote(d.sourceURL) + "\n---\n\n")
	b.WriteString(strings.TrimSpace(d.body))
	b.WriteByte('\n')
	return b.String()
}

func (h *Handler) structureLyrics(parent context.Context, title, lyrics string) (string, string) {
	if h.shelley && acquire(h.modelSem) {
		defer release(h.modelSem)
		if source, err := h.structureLyricsWithModel(parent, title, lyrics); err == nil {
			return source, "model"
		}
	}
	return structureLyricsDeterministic(title, lyrics), "deterministic-fallback"
}

func structureLyricsDeterministic(title, lyrics string) string {
	clean := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(lyrics, "\r\n", "\n"), "\r", "\n"))
	rawBlocks := regexpBlankLines.Split(clean, -1)
	blocks := make([][]string, 0, len(rawBlocks))
	hasLabels := false
	for _, block := range rawBlocks {
		var lines []string
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				lines = append(lines, line)
			}
		}
		if len(lines) > 0 {
			if isSectionLabel(lines[0]) {
				hasLabels = true
			}
			blocks = append(blocks, lines)
		}
	}
	counts := map[string]int{}
	for _, lines := range blocks {
		if !isSectionLabel(lines[0]) {
			counts[normalize(strings.Join(lines, "\n"))]++
		}
	}
	var b strings.Builder
	b.WriteString("# " + title + "\n\n")
	verse := 0
	for i, lines := range blocks {
		heading := ""
		if isSectionLabel(lines[0]) {
			heading = canonicalSection(strings.Trim(lines[0], "[]"))
			lines = lines[1:]
		} else if !hasLabels && counts[normalize(strings.Join(lines, "\n"))] > 1 && len(lines) >= 3 {
			heading = "Chorus"
		} else if i == len(blocks)-1 && len(lines) <= 2 {
			heading = "Outro"
		} else {
			verse++
			heading = "Verse " + strconv.Itoa(verse)
		}
		b.WriteString("### " + heading + "\n")
		if len(lines) > 0 {
			b.WriteString(preserveLineBreaks(strings.Join(lines, "\n")) + "\n")
		}
		if i < len(blocks)-1 {
			b.WriteByte('\n')
		}
	}
	return strings.TrimSpace(b.String()) + "\n"
}

var regexpBlankLines = mustRegexp(`\n[ \t]*\n+`)
var sectionLabelRE = mustRegexp(`(?i)^(?:\[(?:intro|verse|pre[- ]?chorus|chorus|bridge|break|solo|outro)[^]]*\]|(?:intro|verse|pre[- ]?chorus|chorus|bridge|break|solo|outro)(?:\s+\d+)?)$`)

func mustRegexp(value string) *regexp.Regexp { return regexp.MustCompile(value) }
func isSectionLabel(value string) bool       { return sectionLabelRE.MatchString(strings.TrimSpace(value)) }
func canonicalSection(value string) string {
	lower := strings.ToLower(strings.TrimSpace(value))
	switch {
	case strings.HasPrefix(lower, "pre-chorus") || strings.HasPrefix(lower, "pre chorus"):
		return "Pre-Chorus"
	case strings.HasPrefix(lower, "chorus"):
		return "Chorus"
	case strings.HasPrefix(lower, "bridge"):
		return "Bridge"
	case strings.HasPrefix(lower, "intro"):
		return "Intro"
	case strings.HasPrefix(lower, "outro"):
		return "Outro"
	case strings.HasPrefix(lower, "solo"):
		return "Solo"
	default:
		return strings.TrimSpace(value)
	}
}
func preserveLineBreaks(body string) string {
	lines := strings.Split(body, "\n")
	for i := 0; i+1 < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != "" && strings.TrimSpace(lines[i+1]) != "" {
			lines[i] = strings.TrimRight(lines[i], " \t") + "  "
		}
	}
	return strings.Join(lines, "\n")
}
